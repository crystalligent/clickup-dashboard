# Requirements Document

## Introduction

This feature extends the existing GitLab-to-ClickUp synchronization so that each synced ClickUp task carries three dates sourced from its GitLab issue. The dates are stored as items in a ClickUp checklist named "ticket dates" on the task:

1. **created_at** — the GitLab issue's own creation timestamp, which the GitLab issue object exposes directly.
2. **for_release_at** — the time at which the sync process FIRST OBSERVES the "For Release" label on the GitLab issue. Because GitLab does not reliably expose the timestamp at which a label was added, this value is recorded as the sync's own observation time and is then frozen so that later syncs never overwrite it.
3. **released_at** — the time at which the sync process FIRST OBSERVES the "Released" label on the GitLab issue. The "Released" label maps to the ClickUp status "released to prod" per the existing `getExpectedStatus` logic. As with for_release_at, GitLab does not reliably expose the timestamp at which the label was added, so this value is recorded as the sync's own observation time and is then frozen so that later syncs never overwrite it, and is retained even if the "Released" label is later removed.

A checklist is used instead of ClickUp custom fields because custom fields are capped at 60 lifetime uses on ClickUp's Free plan, which an API-driven sync would exhaust immediately. The "ticket dates" checklist is reconciled on every sync without duplicating items, mirrors the reconciliation pattern already used by the Sign-off checklist (`syncSignoffChecklist` in `netlify/functions/utils/signoff.js`), and must never block or break the core sync when it fails. The checklist sync runs in both the scheduled queue processor (`netlify/functions/process-queue.js`) and the manual single-issue sync (`netlify/functions/sync-single.js`), at the same points where the Sign-off checklist is invoked on both the create and update paths.

## Glossary

- **Ticket_Dates_Sync**: The component that builds and reconciles the "ticket dates" checklist on a ClickUp task during a sync run.
- **Ticket Dates Checklist**: A ClickUp checklist named exactly "ticket dates" attached to a synced task, containing date items.
- **created_at Item**: A checklist item whose text has the form `created_at: <date>`.
- **for_release_at Item**: A checklist item whose text has the form `for_release_at: <date>`.
- **released_at Item**: A checklist item whose text has the form `released_at: <date>`.
- **GitLab Issue**: The source issue object provided to the sync, exposing fields such as `iid`, `created_at`, `labels`, and `assignees`.
- **For Release Label**: A GitLab label whose title is "For Release" (matched case-insensitively) present on the GitLab Issue's label set.
- **Released Label**: A GitLab label whose title is "Released" (matched case-insensitively) present on the GitLab Issue's label set, mapping to the ClickUp status "released to prod" per the existing `getExpectedStatus` logic.
- **Observation Time**: The sync run's own current timestamp, used to record `for_release_at` when the For Release Label is first observed and to record `released_at` when the Released Label is first observed.
- **Sign-off Checklist Pattern**: The existing reconciliation approach in `netlify/functions/utils/signoff.js` that reads the task's checklists, creates the checklist if absent, and adds or updates items without duplication.
- **Core Sync**: The existing task create/update, status, assignee, and tag synchronization logic that must not be broken by checklist handling.
- **Scheduled Queue Processor**: The function in `netlify/functions/process-queue.js` that processes queued issues on a schedule.
- **Manual Single Sync**: The function in `netlify/functions/sync-single.js` that syncs one issue on demand.

## Requirements

### Requirement 1: Maintain the ticket dates checklist on synced tasks

**User Story:** As a release manager, I want each synced ClickUp task to carry a "ticket dates" checklist, so that I can see the issue's creation date, its first-observed For Release date, and its first-observed Released date without leaving ClickUp.

#### Acceptance Criteria

1. WHEN a task is synced, THE Ticket_Dates_Sync SHALL read the task's existing checklists and their items before adding, updating, or creating any checklist or item.
2. WHEN a task is synced AND no checklist whose name exactly equals "ticket dates" (case-sensitive, trimmed) exists on the task, THE Ticket_Dates_Sync SHALL create exactly one checklist named "ticket dates" on the task.
3. WHEN a task is synced AND exactly one checklist named "ticket dates" already exists on the task, THE Ticket_Dates_Sync SHALL reuse that existing checklist and SHALL NOT create an additional checklist of the same name.
4. WHEN a task is synced AND two or more checklists named "ticket dates" already exist on the task, THE Ticket_Dates_Sync SHALL reuse the first such checklist returned by the read in criterion 1 and SHALL NOT create an additional checklist of the same name.
5. IF reading the task, creating the checklist, or reconciling its items fails, THEN THE Ticket_Dates_Sync SHALL return a non-throwing result indicating failure with an error description and SHALL leave the Core Sync uninterrupted, preserving any existing "ticket dates" checklist and items already present on the task.

### Requirement 2: Record the created_at date from the GitLab issue

**User Story:** As a release manager, I want the ticket's GitLab creation date stored on the ClickUp task, so that I can tell when the issue originated.

#### Acceptance Criteria

1. WHEN a task is synced AND the "ticket dates" checklist contains no Item whose text begins with `created_at:`, THE Ticket_Dates_Sync SHALL add exactly one Item whose text is `created_at: <date>`, where `<date>` is derived from the GitLab Issue's `created_at` value.
2. WHEN a task is synced AND the "ticket dates" checklist already contains an Item whose text begins with `created_at:`, THE Ticket_Dates_Sync SHALL update that single Item's text to `created_at: <date>` using the GitLab Issue's `created_at` value and SHALL NOT add a duplicate created_at Item.
3. WHEN the Ticket_Dates_Sync writes a created_at Item date, THE Ticket_Dates_Sync SHALL render `<date>` from the GitLab Issue's `created_at` value using the same date format applied to the for_release_at Item, so that both Items display dates in an identical, character-for-character format pattern.
4. IF the GitLab Issue's `created_at` value is absent, empty, or not a parseable ISO 8601 date-time string, THEN THE Ticket_Dates_Sync SHALL leave any existing created_at Item unchanged, SHALL NOT add a created_at Item, and SHALL continue the remainder of the sync without aborting.

### Requirement 3: Record for_release_at on first observation of the For Release label

**User Story:** As a release manager, I want the date the ticket first reached "For Release" captured automatically, so that I can measure time-to-release even though GitLab does not expose label-add timestamps.

#### Acceptance Criteria

1. WHEN a task is synced AND the For Release Label is present on the GitLab Issue AND the "ticket dates" checklist contains no for_release_at Item, THE Ticket_Dates_Sync SHALL add exactly one Item whose text is `for_release_at: <date>` using the Observation Time.
2. WHEN a task is synced AND the For Release Label is absent from the GitLab Issue AND the "ticket dates" checklist contains no for_release_at Item, THE Ticket_Dates_Sync SHALL leave the for_release_at Item absent and SHALL NOT create one.
3. WHEN a task is synced AND the "ticket dates" checklist already contains a for_release_at Item, THE Ticket_Dates_Sync SHALL preserve that Item unchanged regardless of the current label state (this establishes the first-observation semantic; see Requirement 4).
4. WHEN a task is synced for the first time AND the GitLab Issue already carries the For Release Label or a status at or after "for release" on the status ladder AND no for_release_at Item exists, THE Ticket_Dates_Sync SHALL record the for_release_at Item using the Observation Time.
5. THE Ticket_Dates_Sync SHALL match the For Release Label by its title "For Release" case-insensitively against the GitLab Issue's label set, accepting both the string[] and the {title}[] label shapes.
6. IF recording the for_release_at Item fails, THEN THE Ticket_Dates_Sync SHALL catch the error, leave any existing for_release_at Item unchanged, and allow the Core Sync to complete without throwing.

### Requirement 4: Record released_at on first observation of the Released label

**User Story:** As a release manager, I want the date the ticket first reached "Released" captured automatically, so that I can measure time-to-production even though GitLab does not expose label-add timestamps.

#### Acceptance Criteria

1. WHEN a task is synced AND the Released Label is present on the GitLab Issue AND the "ticket dates" checklist contains no released_at Item, THE Ticket_Dates_Sync SHALL add exactly one Item whose text is `released_at: <date>` using the Observation Time.
2. WHEN a task is synced AND the Released Label is absent from the GitLab Issue AND the "ticket dates" checklist contains no released_at Item, THE Ticket_Dates_Sync SHALL leave the released_at Item absent and SHALL NOT create one.
3. WHEN a task is synced AND the "ticket dates" checklist already contains a released_at Item, THE Ticket_Dates_Sync SHALL preserve that Item unchanged regardless of the current label state (this establishes the first-observation semantic; see Requirement 5).
4. WHEN a task is synced for the first time AND the GitLab Issue already carries the Released Label AND no released_at Item exists, THE Ticket_Dates_Sync SHALL record the released_at Item using the Observation Time.
5. THE Ticket_Dates_Sync SHALL match the Released Label by its title "Released" case-insensitively against the GitLab Issue's label set, accepting both the string[] and the {title}[] label shapes.
6. IF recording the released_at Item fails, THEN THE Ticket_Dates_Sync SHALL catch the error, leave any existing released_at Item unchanged, and allow the Core Sync to complete without throwing.

### Requirement 5: Freeze for_release_at and released_at once recorded

**User Story:** As a release manager, I want the recorded For Release and Released dates to stay stable, so that repeated syncs or label changes do not rewrite history.

#### Acceptance Criteria

1. WHEN a task is synced AND the "ticket dates" checklist already contains a for_release_at Item with a non-empty value, THE Ticket_Dates_Sync SHALL preserve the existing for_release_at Item value unchanged and SHALL NOT issue any write, update, or delete operation against that Item.
2. WHILE the For Release Label is absent from the GitLab Issue after a for_release_at Item was recorded, THE Ticket_Dates_Sync SHALL retain the existing for_release_at Item value unchanged.
3. WHEN a task is synced AND the "ticket dates" checklist already contains a released_at Item with a non-empty value, THE Ticket_Dates_Sync SHALL preserve the existing released_at Item value unchanged and SHALL NOT issue any write, update, or delete operation against that Item.
4. WHILE the Released Label is absent from the GitLab Issue after a released_at Item was recorded, THE Ticket_Dates_Sync SHALL retain the existing released_at Item value unchanged.
5. WHEN a task is synced, THE Ticket_Dates_Sync SHALL read the existing "ticket dates" checklist and determine whether a for_release_at Item and a released_at Item each with a non-empty value are present before deciding whether to write either Item.
6. IF reading the existing "ticket dates" checklist fails or the checklist cannot be retrieved, THEN THE Ticket_Dates_Sync SHALL NOT write, overwrite, or delete the for_release_at Item or the released_at Item, SHALL leave any existing for_release_at Item and released_at Item unchanged, and SHALL surface an error indicating the checklist could not be read.

### Requirement 6: Never duplicate checklist items across repeated syncs

**User Story:** As a release manager, I want the ticket dates checklist to stay clean across many syncs, so that I never see repeated or conflicting date rows.

#### Acceptance Criteria

1. WHEN a task is synced repeatedly any number of times, THE Ticket_Dates_Sync SHALL maintain exactly one created_at Item in the "ticket dates" checklist at the end of each sync.
2. WHEN a task is synced repeatedly any number of times, THE Ticket_Dates_Sync SHALL maintain exactly one for_release_at Item in the "ticket dates" checklist at the end of each sync.
3. WHEN a task is synced repeatedly any number of times, THE Ticket_Dates_Sync SHALL maintain exactly one released_at Item in the "ticket dates" checklist at the end of each sync.
4. WHEN the "ticket dates" checklist already contains a created_at Item, THE Ticket_Dates_Sync SHALL update the existing created_at Item in place and SHALL NOT add a new created_at Item.
5. IF the "ticket dates" checklist contains more than one Item matching the same date field (created_at, for_release_at, or released_at) at the start of a sync, THEN THE Ticket_Dates_Sync SHALL retain exactly one Item for that date field and remove the remaining duplicate Items for that field.
6. WHEN a sync would write a date Item whose stored value already equals the new value, THE Ticket_Dates_Sync SHALL leave the Item unchanged and SHALL NOT create an additional Item.

### Requirement 7: Run in both sync entry points without blocking the core sync

**User Story:** As a developer maintaining the sync, I want the ticket dates checklist handled in both the scheduled and manual sync paths and isolated from failures, so that date tracking works everywhere and never breaks the primary sync.

#### Acceptance Criteria

1. WHEN the Scheduled Queue Processor creates a task or updates a task, THE Ticket_Dates_Sync SHALL be invoked exactly once per task in the same path step at which the Sign-off Checklist is invoked.
2. WHEN the Manual Single Sync creates a task or updates a task, THE Ticket_Dates_Sync SHALL be invoked exactly once per task in the same path step at which the Sign-off Checklist is invoked.
3. IF the Ticket_Dates_Sync encounters an error during processing, THEN THE Ticket_Dates_Sync SHALL catch the error internally and return a failure-indicating result to the caller without throwing or propagating an exception.
4. WHEN the Ticket_Dates_Sync returns a failure-indicating result, THE Core Sync SHALL complete with the same committed outcome it would have produced had the Ticket_Dates_Sync not run, and THE Core Sync result SHALL NOT be marked as failed due to the Ticket_Dates_Sync failure.
5. IF the Ticket_Dates_Sync fails, THEN THE Ticket_Dates_Sync SHALL record one diagnostic entry that identifies the affected task by its task identifier and describes the failure cause.

### Requirement 8: Format dates consistently

**User Story:** As a release manager, I want all three dates displayed in the same readable format, so that I can compare them at a glance.

#### Acceptance Criteria

1. THE Ticket_Dates_Sync SHALL render the created_at Item date, the for_release_at Item date, and the released_at Item date using one shared date format with a consistent fixed-width representation for each date component.
2. WHEN the created_at Item is written from the GitLab Issue's `created_at` value, THE Ticket_Dates_Sync SHALL apply the shared date format to that value and store the result as a string whose structure is identical to the for_release_at Item's and released_at Item's formatted structure.
3. WHEN the for_release_at Item is written from the Observation Time, THE Ticket_Dates_Sync SHALL apply the shared date format to that value and store the result as a string whose structure is identical to the created_at Item's and released_at Item's formatted structure.
4. WHEN the released_at Item is written from the Observation Time, THE Ticket_Dates_Sync SHALL apply the shared date format to that value and store the result as a string whose structure is identical to the created_at Item's and for_release_at Item's formatted structure.
5. WHERE a source date value uses a time zone other than UTC, THE Ticket_Dates_Sync SHALL convert the value to UTC before applying the shared date format.
6. IF a source date value is missing, empty, or cannot be parsed into a valid date, THEN THE Ticket_Dates_Sync SHALL leave the corresponding Item unchanged and record an error indication identifying the affected Item and the unparseable value.
