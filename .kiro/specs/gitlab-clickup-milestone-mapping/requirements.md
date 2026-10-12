# Requirements Document

## Introduction

The GitLab→ClickUp sync currently derives ClickUp task status almost entirely from GitLab **labels**. Milestones are used for two narrow purposes only: filtering which issues enter the sync (`ALLOWED_MILESTONES` by ID for the webhook path, `GITLAB_MILESTONES` by name for the scheduled path), and a single hard-coded special case where milestone ID `756` causes a newly created task to get the status `pending review (qa)`. There is no general milestone→status mapping table today, and the one special case applies **only on task creation**, never on updates.

This feature introduces a general, centralized GitLab milestone → ClickUp status mapping and seeds it with two new entries:

| GitLab Milestone | ClickUp Status |
| --- | --- |
| `2026 Review - For QA Verification` | `2026 Review - QA` |
| `2026 Review - For Dev Verification` | `2026 Review - Dev` |

Two structural problems must be solved to make this work:

1. **Status resolution is duplicated** across four sync paths (`gitlab-webhook.js`, `sync-single.js`, `process-queue.js`, `run-queue.js`), each with its own copy of `getExpectedStatus()`. A mapping added to one copy would silently not apply to the others.
2. **The webhook payload has no milestone name.** GitLab issue events expose only `object_attributes.milestone_id`, so a name-keyed mapping cannot be resolved on the webhook path without either configured milestone IDs or a GitLab API lookup.

### Decisions made in this draft (please confirm or correct)

- **Milestone mapping outranks label mapping.** An issue sitting in `2026 Review - For QA Verification` will usually still carry development-era labels such as `On-Going Development`. Under today's precedence those labels would win and the 2026 Review statuses would never be applied. This draft therefore ranks milestone mapping above label mapping, and below closed-state.
- **Mapping applies to updates, not just creation.** Unlike the existing `QA_MILESTONE_ID` special case, a milestone-derived status is applied when an existing ClickUp task is updated too.

## Glossary

- **Sync_System**: The complete GitLab→ClickUp integration, comprising all Netlify functions in `netlify/functions/`.
- **Webhook_Handler**: `netlify/functions/gitlab-webhook.js`, which processes real-time GitLab issue events.
- **Manual_Sync**: `netlify/functions/sync-single.js`, which syncs one GitLab issue on demand by URL.
- **Queue_Processor**: `netlify/functions/process-queue.js` and `netlify/functions/run-queue.js`, which process queued issues in batches.
- **Issue_Collector**: `netlify/functions/sync-gitlab.js` and `netlify/functions/sync-trigger.js`, which fetch issues from GitLab by milestone name and enqueue them.
- **Status_Resolver**: The logic that determines the target ClickUp status for a GitLab issue. Currently implemented as four duplicated `getExpectedStatus()` functions.
- **Milestone_Status_Map**: The new configuration structure that maps a GitLab milestone name to a ClickUp status name.
- **Milestone_Resolver**: The logic that determines a GitLab milestone's name when only the milestone ID is available.
- **Target_Status**: The single ClickUp status name that the Status_Resolver produces for a given GitLab issue.
- **Label_Status**: A Target_Status derived from GitLab labels by the existing label rules.
- **Milestone_Status**: A Target_Status derived from the Milestone_Status_Map.
- **Sync_Log**: The run record written by `netlify/functions/utils/logger.js` and displayed on the Logs page.
- **2026_Review_Milestones**: The GitLab milestones named `2026 Review - For QA Verification` and `2026 Review - For Dev Verification`.

## Requirements

### Requirement 1: Centralized Milestone-to-Status Mapping

**User Story:** As an integration maintainer, I want one shared milestone-to-status mapping, so that adding a milestone mapping takes effect on every sync path without editing four files.

#### Acceptance Criteria

1. THE Sync_System SHALL define the Milestone_Status_Map exactly once, in a single shared module under `netlify/functions/utils/`, such that zero other files under `netlify/functions/` declare a milestone-name-to-ClickUp-status mapping of their own.
2. WHEN the Webhook_Handler processes a GitLab issue event, THE Webhook_Handler SHALL resolve Milestone_Status exclusively by querying the shared Milestone_Status_Map.
3. WHEN the Manual_Sync processes a GitLab issue, THE Manual_Sync SHALL resolve Milestone_Status exclusively by querying the shared Milestone_Status_Map.
4. WHEN the Queue_Processor processes a queued GitLab issue, THE Queue_Processor SHALL resolve Milestone_Status exclusively by querying the shared Milestone_Status_Map.
5. THE Milestone_Status_Map SHALL map the GitLab milestone name `2026 Review - For QA Verification` to exactly one ClickUp status value, `2026 Review - QA`.
6. THE Milestone_Status_Map SHALL map the GitLab milestone name `2026 Review - For Dev Verification` to exactly one ClickUp status value, `2026 Review - Dev`.
7. WHEN comparing a GitLab milestone name of up to 255 characters against a Milestone_Status_Map key, THE Status_Resolver SHALL normalize both values by removing leading and trailing whitespace, collapsing each run of internal whitespace to a single space, and converting both to a single letter case, and SHALL treat them as matching only if the normalized values are character-for-character equal.
8. IF a GitLab issue's milestone name is absent, empty, longer than 255 characters, or normalizes to a value matching no Milestone_Status_Map key, THEN THE Status_Resolver SHALL produce no Milestone_Status for that issue.

### Requirement 2: Status Precedence

**User Story:** As a QA lead, I want milestone-driven statuses to win over stale development labels, so that a ticket moved into a 2026 Review milestone shows the correct review status in ClickUp.

#### Acceptance Criteria

1. WHEN the Status_Resolver evaluates a GitLab issue whose state is `closed`, THE Status_Resolver SHALL produce the Target_Status `Closed` regardless of the issue milestone name and regardless of any Label_Status derivable from the issue labels.
2. WHEN the Status_Resolver evaluates a GitLab issue whose state is `opened` AND the issue milestone name, after removal of leading and trailing whitespace, matches a Milestone_Status_Map key by exact case-insensitive comparison, THE Status_Resolver SHALL produce the mapped Milestone_Status as the single Target_Status regardless of any Label_Status derivable from the issue labels.
3. WHEN the Status_Resolver evaluates a GitLab issue whose state is `opened` AND the issue has no milestone assigned OR the issue milestone name (whitespace-trimmed, case-insensitive) matches no Milestone_Status_Map key, THE Status_Resolver SHALL produce the Label_Status as the Target_Status.
4. IF the Status_Resolver evaluates a GitLab issue whose state is `opened` AND no Milestone_Status_Map key matches the issue milestone name AND the existing label rules derive no Label_Status from the issue labels, THEN THE Status_Resolver SHALL produce no Target_Status, which is the empty result that selects the behaviour in criteria 5 and 6.
5. WHEN the Status_Resolver produces no Target_Status AND the Sync_System creates a new ClickUp task, THE Sync_System SHALL set the new task status to `Open`.
6. WHEN the Status_Resolver produces no Target_Status AND a matching ClickUp task already exists, THE Sync_System SHALL leave the existing ClickUp task status field unchanged and SHALL apply no status update request for that task.
7. THE Status_Resolver SHALL produce at most one Target_Status per GitLab issue, and repeated evaluations of the same issue data with the same Milestone_Status_Map SHALL produce the identical Target_Status.
8. IF the Milestone_Status_Map is absent, empty, or cannot be read at evaluation time, THEN THE Status_Resolver SHALL treat every issue milestone name as unmatched and resolve the Target_Status from the Label_Status as specified in criteria 3 and 4.
9. IF more than one Milestone_Status_Map key matches the issue milestone name under whitespace-trimmed case-insensitive comparison, THEN THE Status_Resolver SHALL produce the Milestone_Status of the first matching entry in configured order as the single Target_Status.

### Requirement 3: Preserve the Existing QA Milestone Behavior

**User Story:** As an integration maintainer, I want the current milestone `756` behavior preserved, so that introducing the new mapping does not regress tickets already flowing through the QA milestone.

#### Acceptance Criteria

1. WHEN the Sync_System creates a ClickUp task for a GitLab issue AND the issue milestone ID equals the value of `QA_MILESTONE_ID` (default `756`) compared as strings with leading and trailing whitespace removed from both values AND the Status_Resolver produces no Target_Status, THE Sync_System SHALL set the new task status to `pending review (qa)`.
2. WHEN the Sync_System processes a GitLab issue whose milestone ID equals `QA_MILESTONE_ID` AND a matching ClickUp task already exists AND the Status_Resolver produces no Target_Status, THE Sync_System SHALL leave the existing ClickUp task status unchanged.
3. WHERE `DEFAULT_ASSIGNEE_ID` is set to a decimal integer greater than 0, WHEN the Webhook_Handler creates a ClickUp task with status `pending review (qa)` AND the GitLab issue event yields zero ClickUp assignees, THE Webhook_Handler SHALL create the task with exactly one assignee equal to `DEFAULT_ASSIGNEE_ID`.
4. WHEN the Webhook_Handler creates a ClickUp task with status `pending review (qa)` AND `DEFAULT_ASSIGNEE_ID` is unset, empty, or not a decimal integer greater than 0, THE Webhook_Handler SHALL create the task with zero assignees.
5. IF `DEFAULT_ASSIGNEE_ID` is set to a value that is not a decimal integer greater than 0, THEN THE Webhook_Handler SHALL record a Sync_Log entry indicating that the configured default assignee value is unusable, and SHALL still complete the task creation.
6. WHEN the Status_Resolver evaluates a GitLab issue whose state is `opened` AND whose milestone name is absent from the Milestone_Status_Map, THE Status_Resolver SHALL produce the same Label_Status, by exact ClickUp status name, that the pre-change `getExpectedStatus()` implementation produces for the same label set and issue state.
7. WHEN the Sync_System creates or updates a ClickUp task, THE Sync_System SHALL apply exactly the set of ClickUp tag names, with no additions and no removals, that the pre-change tag derivation produces for the same label set.

### Requirement 4: Milestone Name Resolution on the Webhook Path

**User Story:** As an integration maintainer, I want the webhook to recognize the 2026 Review milestones, so that real-time GitLab events update ClickUp status without waiting for the scheduled sync.

#### Acceptance Criteria

1. WHEN the Webhook_Handler receives a GitLab issue event whose payload carries a milestone name that is a non-empty string after leading and trailing whitespace is removed, THE Webhook_Handler SHALL use that trimmed milestone name as the Milestone_Status_Map lookup key, matched case-insensitively, without issuing any GitLab milestones API request.
2. WHEN the Webhook_Handler receives a GitLab issue event that carries a milestone ID and no milestone name, THE Milestone_Resolver SHALL request the milestone name from the GitLab milestones API using that milestone ID, applying a per-request timeout of 10 seconds and at most 1 retry attempt after a timeout or connection failure.
3. WHEN the Milestone_Resolver retrieves a milestone name from the GitLab milestones API, THE Milestone_Resolver SHALL store the ID-to-name pair in a cache that persists for the lifetime of the current function invocation and is discarded when that invocation ends.
4. IF the GitLab milestones API returns a response with an HTTP status code of 400 or greater, OR returns no response within the 10-second timeout on both the initial request and the retry attempt, OR returns a success response in which the milestone name is absent or empty after whitespace is removed, THEN THE Milestone_Resolver SHALL produce no milestone name for that milestone ID.
5. IF the Milestone_Resolver produces no milestone name, THEN THE Sync_System SHALL record exactly one Sync_Log entry for that issue containing the milestone ID, the GitLab issue identifier, and an indication that milestone name resolution failed.
6. WHEN the Milestone_Resolver receives a lookup request for a milestone ID already present in the invocation cache, THE Milestone_Resolver SHALL return the cached milestone name and SHALL issue no further GitLab milestones API request for that milestone ID during the same invocation.
7. IF the Milestone_Resolver produces no milestone name, THEN THE Status_Resolver SHALL resolve the issue status from the Label_Status AND THE Sync_System SHALL complete the remaining processing for that issue rather than aborting the webhook invocation.

### Requirement 5: Admitting the New Milestones into the Sync Scope

**User Story:** As a QA lead, I want issues in the two 2026 Review milestones to be picked up by the sync, so that the new status mappings have issues to act on.

#### Acceptance Criteria

1. WHEN an Issue_Collector run begins, THE Issue_Collector SHALL fetch GitLab issues whose milestone name is `2026 Review - For QA Verification` and enqueue them for processing.
2. WHEN an Issue_Collector run begins, THE Issue_Collector SHALL fetch GitLab issues whose milestone name is `2026 Review - For Dev Verification` and enqueue them for processing.
3. WHEN the Webhook_Handler receives a GitLab issue event for an issue whose milestone name is one of the 2026_Review_Milestones, THE Webhook_Handler SHALL resolve the Target_Status for that issue and apply it to ClickUp, whether or not the issue's milestone ID is listed in `ALLOWED_MILESTONES`.
4. IF the Webhook_Handler receives a GitLab issue event for an issue whose milestone ID is not listed in `ALLOWED_MILESTONES` AND whose milestone name is not present in the Milestone_Status_Map, THEN THE Webhook_Handler SHALL skip the issue without creating or updating any ClickUp task.
5. THE Sync_System SHALL read sync-scope milestone names from the environment variable `GITLAB_MILESTONES` and sync-scope milestone IDs from the environment variable `ALLOWED_MILESTONES`, parsing each value as a comma-separated list with leading and trailing whitespace removed from each entry and empty entries discarded.
6. THE Sync_System SHALL document each new or changed environment variable in `.env.example` and `README.md` with the variable name, its purpose, and an example value.
7. IF the Webhook_Handler skips a GitLab issue because its milestone is outside the sync scope, THEN THE Webhook_Handler SHALL record a skipped entry in the Sync_Log containing the GitLab issue IID and the issue's milestone ID.
8. IF a GitLab issue fetch for one configured milestone name returns an HTTP status code of 400 or greater, THEN THE Issue_Collector SHALL continue fetching issues for the remaining configured milestone names in the same run AND record an error entry in the Sync_Log identifying the failed milestone name.
9. WHEN the same GitLab issue is returned by the fetches for more than one configured milestone name in a single Issue_Collector run, THE Issue_Collector SHALL enqueue that issue exactly once.

### Requirement 6: Applying the Status to ClickUp

**User Story:** As a QA lead, I want ClickUp task status to reflect the current GitLab milestone, so that the ClickUp board is an accurate view of review progress.

#### Acceptance Criteria

1. WHEN the Sync_System creates a ClickUp task AND the Status_Resolver produces a Target_Status, THE Sync_System SHALL set the status field of that single create request to the Target_Status name exactly as it appears in the Milestone_Status_Map or label rule that produced it.
2. WHEN the Sync_System updates an existing ClickUp task AND the Status_Resolver produces a Target_Status that differs from the task's current ClickUp status after ignoring leading whitespace, trailing whitespace, and letter case, THE Sync_System SHALL set the status field of a single ClickUp update request to the Target_Status.
3. WHEN the Sync_System updates an existing ClickUp task AND the Target_Status equals the task's current ClickUp status after ignoring leading whitespace, trailing whitespace, and letter case, THE Sync_System SHALL omit the status field from the ClickUp update request.
4. WHEN the Sync_System processes a GitLab issue whose state, milestone name, and label set are identical to those of the most recent successful sync of that issue, THE Sync_System SHALL leave the ClickUp task status equal to the Target_Status applied by that most recent successful sync.
5. WHEN the Sync_System is about to update an existing ClickUp task, THE Sync_System SHALL retrieve that task's current status before comparing it with the Target_Status.
6. IF the Sync_System cannot determine the current status of an existing ClickUp task AND the Status_Resolver produces a Target_Status, THEN THE Sync_System SHALL include the Target_Status in the status field of the ClickUp update request.
7. WHEN the Sync_System omits the status field from a ClickUp update request, THE Sync_System SHALL still apply every non-status field update it would otherwise have applied for that issue.

### Requirement 7: Handling Statuses That Do Not Exist in ClickUp

**User Story:** As an integration maintainer, I want a clear signal when a mapped status is missing from the ClickUp list, so that I can fix the ClickUp configuration instead of hunting through logs for an opaque API error.

#### Acceptance Criteria

1. IF the ClickUp API rejects a task create request with an error indicating that the requested status does not exist in the target list, THEN THE Sync_System SHALL record exactly one error-level entry in the Sync_Log containing the GitLab issue IID, the milestone name, the rejected status name, and the target ClickUp list identifier.
2. IF the ClickUp API rejects a task update request with an error indicating that the requested status does not exist in the target list, THEN THE Sync_System SHALL record exactly one error-level entry in the Sync_Log containing the GitLab issue IID, the milestone name, the rejected status name, and the target ClickUp list identifier.
3. IF the ClickUp API rejects a task create request with an error indicating that the requested status does not exist in the target list, THEN THE Sync_System SHALL retry the create request exactly once, within 5 seconds of receiving the rejection, using the status `Open` and all other field values identical to the original request.
4. IF the retry of a task create request using the status `Open` is also rejected, THEN THE Sync_System SHALL abandon the create for that GitLab issue, SHALL NOT create a ClickUp task for it, and SHALL record one error-level entry in the Sync_Log containing the GitLab issue IID and an indication that both the mapped status and the `Open` fallback were rejected.
5. IF the ClickUp API rejects a task update request with an error indicating that the requested status does not exist in the target list, THEN THE Sync_System SHALL leave the existing ClickUp task's status and all other fields unchanged and SHALL NOT retry the update with a substitute status.
6. WHEN the ClickUp API rejects a create or update request for one GitLab issue because the requested status does not exist in the target list, THE Queue_Processor SHALL continue processing every remaining issue in the batch and SHALL NOT abort the run.
7. WHEN a batch run completes, THE Queue_Processor SHALL record in the Sync_Log run record the count of GitLab issues that failed because a mapped status did not exist in the target ClickUp list.

### Requirement 8: Observability

**User Story:** As an integration maintainer, I want the logs to show which rule set the status, so that I can confirm the milestone mapping fired as intended.

#### Acceptance Criteria

1. WHEN the Sync_System creates or updates a ClickUp task for a GitLab issue that has an assigned milestone, THE Sync_System SHALL record that milestone's name, truncated to the first 255 characters, in the Sync_Log entry for that issue.
2. WHEN the Status_Resolver produces a Milestone_Status, THE Sync_System SHALL record exactly one status origin value in the Sync_Log entry, and that value SHALL identify the milestone mapping and SHALL be distinct from the value used for the label mapping.
3. WHEN the Status_Resolver produces a Label_Status, THE Sync_System SHALL record exactly one status origin value in the Sync_Log entry, and that value SHALL identify the label mapping and SHALL be distinct from the value used for the milestone mapping.
4. WHEN the Logs page renders a Sync_Log entry, THE Logs page SHALL display the recorded milestone name and the recorded status origin for that entry, and IF either value is absent from the entry, THEN THE Logs page SHALL display an indicator that the value was not recorded rather than omitting the entry.
5. IF the Sync_System creates or updates a ClickUp task for a GitLab issue that has no assigned milestone, THEN THE Sync_System SHALL record an empty milestone name in the Sync_Log entry for that issue.
6. IF the Status_Resolver produces neither a Milestone_Status nor a Label_Status for an issue, THEN THE Sync_System SHALL record a status origin value indicating that no mapping applied, distinct from both the milestone mapping and label mapping values.
7. IF writing a Sync_Log entry fails, THEN THE Sync_System SHALL complete the ClickUp task create or update operation without reverting it and SHALL report the sync result as successful.

## Correctness Properties

Properties suitable for property-based testing against the shared Status_Resolver, which is a pure function over `(milestoneName, labels, issueState)`:

1. **Single-valued (invariant)**: For all generated `(milestoneName, labels, issueState)` inputs, the Status_Resolver returns either exactly one status string or no status.
2. **Idempotence**: For all generated inputs, `resolve(input)` equals `resolve(input)` across repeated calls, and re-resolving from an already-synced state yields the same status.
3. **Precedence invariant**: For all generated inputs where `issueState` is `closed`, the result is `Closed` regardless of milestone or labels.
4. **Milestone dominance (metamorphic)**: For all generated label sets, when `milestoneName` is one of the 2026_Review_Milestones and `issueState` is `opened`, the result equals the mapped 2026 Review status.
5. **Normalization invariant**: For all generated milestone names in the Milestone_Status_Map, inserting leading whitespace, trailing whitespace, or additional internal whitespace within an existing whitespace run, or changing letter case, yields the same Milestone_Status.
6. **Backward compatibility (model-based)**: For all generated inputs where `milestoneName` is absent from the Milestone_Status_Map, the new Status_Resolver returns the same value as the pre-change `getExpectedStatus()` implementation.
7. **Length bound (error condition)**: For all generated milestone names longer than 255 characters, and for absent or empty milestone names, the Status_Resolver produces no Milestone_Status.
8. **Degenerate map (metamorphic)**: For all generated inputs, resolving with an empty or unreadable Milestone_Status_Map returns the same value as resolving the same input under the pre-change label-only rules.
9. **Match-order determinism**: For all generated Milestone_Status_Maps containing two or more entries whose keys normalize to the same value, the Status_Resolver returns the Milestone_Status of the first such entry in configured order, independent of how many duplicates follow.
10. **No-op update (metamorphic)**: For all generated pairs of Target_Status and current ClickUp status that are equal after whitespace and case normalization, the constructed ClickUp update request contains no status field; for all pairs that differ under the same normalization, it contains exactly one status field equal to the Target_Status.
11. **Enqueue uniqueness (invariant)**: For all generated sets of configured milestone names and GitLab issue fetch results, each distinct GitLab issue appears exactly once in the Issue_Collector's enqueued output.

Behaviors better covered by integration tests with a small number of representative examples, because they exercise external services rather than project logic: GitLab milestones API lookup, timeout, retry, and invocation-scoped caching (Requirement 4), ClickUp status rejection, create fallback, and update non-retry (Requirement 7), and Sync_Log persistence and Logs page rendering (Requirement 8).
