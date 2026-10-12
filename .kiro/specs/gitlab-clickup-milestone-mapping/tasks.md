# Implementation Plan: GitLab Milestone → ClickUp Status Mapping

## Overview

This plan refactors status resolution out of four duplicated sync paths into shared,
pure modules, adds a name-keyed Milestone_Status_Map with precedence over labels, resolves
milestone names on the webhook path, centralizes ClickUp apply (no-op detection + status-rejection
handling), isolates per-milestone collector errors, widens webhook admission, and surfaces status
origin + milestone name in logs.

The implementation language is **JavaScript (Node.js, CommonJS)**, matching the existing Netlify
functions. A test framework is introduced first (Vitest + fast-check) because none exists today.
Work proceeds bottom-up: tooling → pure `status-resolver` (the core, property-tested) → `milestone-resolver`
→ `clickup-apply` → refactor the four sync paths → collector scope → webhook admission → observability → docs.

Tasks marked with `*` are optional test sub-tasks and may be skipped for a faster MVP. All property-test
sub-tasks reference the design's Correctness Properties (1–13) and the requirement clauses they validate.

## Tasks

- [x] 1. Set up the test framework and project tooling
  - Add `vitest` and `fast-check` as dev dependencies in `package.json`
  - Add a `"test": "vitest --run"` script (single-run, never watch mode)
  - Create the `netlify/functions/__tests__/` directory for test files
  - Run `npm install` to lock the new dev dependencies
  - _Requirements: Testing Strategy (Tooling); supports all property/unit/integration tests_

- [x] 2. Build the pure Status_Resolver module (`netlify/functions/utils/status-resolver.js`)
  - [x] 2.1 Implement normalization and the Milestone_Status_Map
    - Define `MILESTONE_STATUS_MAP` as an ordered array seeded with
      `2026 Review - For QA Verification → 2026 Review - QA` and
      `2026 Review - For Dev Verification → 2026 Review - Dev`
    - Implement `normalizeMilestone(name)`: trim, collapse internal whitespace runs to a single space, lowercase
    - Implement `getMilestoneStatus(milestoneName)`: return `null` for absent/empty/`>255`-char names; otherwise
      iterate the map in configured order, first normalized-equal key wins; guard against non-array/empty map (return `null`)
    - Export `STATUS_ORIGIN = { MILESTONE, LABEL, NONE }`
    - _Requirements: 1.1, 1.5, 1.6, 1.7, 1.8, 2.8, 2.9_

  - [x] 2.2 Implement label rules, tag rules, and the tolerant `hasLabel`
    - Port `getLabelStatus(labels, issueState)` as the canonical merge of the four `getExpectedStatus` copies,
      adopting the **webhook ordering** (`For Testing` before `For Deployment to Hotfix`); return `null` when no rule matches
    - Port `getExpectedTags(labels)` verbatim from the current identical implementation
    - Implement a tolerant `hasLabel` that accepts both `{title}` objects and raw strings
    - _Requirements: 3.6, 3.7_

  - [x] 2.3 Implement `resolveStatus` entry point with precedence
    - Precedence `closed > milestone > label`: closed → `{status:'Closed', origin:'label'}`;
      else milestone match → `{status, origin:'milestone'}`; else label → `{status, origin:'label'}`;
      else `{status:null, origin:'none'}`
    - Export `MILESTONE_STATUS_MAP`, `normalizeMilestone`, `getLabelStatus`, `getExpectedTags`,
      `getMilestoneStatus`, `resolveStatus`, `STATUS_ORIGIN`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.7_

  - [ ]* 2.4 Write property test — well-formed output
    - **Property 1: Well-formed output (single-valued + consistent origin)**
    - **Validates: Requirements 2.7, 8.2, 8.3, 8.6**

  - [ ]* 2.5 Write property test — closed precedence
    - **Property 3: Closed precedence**
    - **Validates: Requirements 2.1**

  - [ ]* 2.6 Write property test — milestone dominance
    - **Property 4: Milestone dominance**
    - **Validates: Requirements 2.2**

  - [ ]* 2.7 Write property test — normalization invariance
    - **Property 5: Normalization invariance**
    - **Validates: Requirements 1.7**

  - [ ]* 2.8 Write property test — length and absence error condition
    - **Property 6: Length and absence error condition**
    - **Validates: Requirements 1.8**

  - [ ]* 2.9 Write property test — backward compatibility (model-based)
    - **Property 7: Backward compatibility** (frozen reference oracle of pre-change `getLabelStatus`, webhook order)
    - **Validates: Requirements 2.3, 3.6**

  - [ ]* 2.10 Write property test — degenerate map
    - **Property 8: Degenerate map** (empty/unreadable map falls back to label-only)
    - **Validates: Requirements 2.8**

  - [ ]* 2.11 Write property test — match-order determinism
    - **Property 9: Match-order determinism** (duplicate-normalizing keys, first wins)
    - **Validates: Requirements 2.9**

  - [ ]* 2.12 Write property test — tag derivation backward compatibility (model-based)
    - **Property 12: Tag derivation backward compatibility** (frozen reference oracle of pre-change tags)
    - **Validates: Requirements 3.7**

  - [ ]* 2.13 Write unit tests for seed mappings and idempotence
    - Assert exact seed mappings (Req 1.5, 1.6) and that repeated `resolveStatus` calls match
    - _Requirements: 1.5, 1.6, 2.7_

- [ ] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Build the Milestone_Resolver module (`netlify/functions/utils/milestone-resolver.js`)
  - [x] 4.1 Implement `createMilestoneResolver` factory with invocation-scoped cache
    - Factory takes `{ gitlabUrl, token, projectId, fetchImpl = fetch }` and holds a `Map<string, string|null>`
    - `resolveName(milestoneId)`: return cached value when present (no request);
      otherwise `GET {gitlabUrl}/api/v4/projects/{projectId}/milestones/{milestoneId}` with `PRIVATE-TOKEN`,
      a 10s per-attempt `AbortController` timeout, and exactly one retry on timeout/connection failure
    - Resolve to `null` (and cache `null`) on HTTP `>=400`, both attempts failing, or absent/empty trimmed `title`;
      otherwise cache and return the trimmed `title`
    - _Requirements: 4.2, 4.3, 4.4, 4.6_

  - [ ]* 4.2 Write integration tests for the resolver (mocked fetch, fake timers)
    - Cover cache hit (no second request), 10s timeout + single retry, HTTP `>=400` → null, empty title → null
    - _Requirements: 4.2, 4.3, 4.4, 4.6_

- [ ] 5. Build the ClickUp_Apply module (`netlify/functions/utils/clickup-apply.js`)
  - [x] 5.1 Implement status helpers and the update builder
    - `statusEquals(a, b)`: trim + case-insensitive comparison
    - `isStatusNotFoundError(err)`: narrow match on the ClickUp "status does not exist in list" rejection signature
    - Update-request builder: include status only when a Target_Status exists and differs from current under normalization;
      omit status when equal or when Target_Status is `null`; include status when current is unknown but Target_Status exists;
      always include non-status field updates (name, assignee, tags)
    - _Requirements: 2.6, 6.2, 6.3, 6.5, 6.6, 6.7_

  - [ ] 5.2 Implement `createTask` and `updateTask` with status-rejection handling
    - `createTask`: body status = `targetStatus || 'Open'`; on status-not-found, log one error (IID, milestone name,
      rejected status, list id) and retry once within 5s with `status:'Open'`; if retry also rejected, do not create,
      log one error noting both mapped + `Open` rejected, mark `statusNotFound`; non-status errors propagate
    - `updateTask`: on status-not-found rejection, leave task unchanged, do NOT retry, log one error, mark `statusNotFound`
    - Return result objects exposing `created`/`applied`, `statusNotFound`, `fallbackUsed`
    - _Requirements: 6.1, 7.1, 7.2, 7.3, 7.4, 7.5_

  - [ ]* 5.3 Write property test — no-op update
    - **Property 10: No-op update** (equal → no status field; differ → exactly one; null → none)
    - **Validates: Requirements 2.6, 6.2, 6.3**

  - [ ]* 5.4 Write property test — non-status fields preserved
    - **Property 11: Non-status fields preserved**
    - **Validates: Requirements 6.7**

  - [ ]* 5.5 Write integration tests for status-rejection handling (mocked clickupRequest, fake timers)
    - Create retry→Open success, create retry→Open rejected (no task), update non-retry, current-status-unknown include
    - _Requirements: 6.5, 6.6, 7.1, 7.2, 7.3, 7.4, 7.5_

- [ ] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Refactor `gitlab-webhook.js` to delegate to shared modules
  - [ ] 7.1 Delete local duplicates and wire in the resolvers
    - Remove local `hasLabel`, `getExpectedStatus`, `getExpectedTags`, and the inline QA special case
    - `require` `status-resolver` and `clickup-apply`; construct one `createMilestoneResolver(...)` per invocation
    - Determine milestone name: use trimmed non-empty payload name directly; otherwise `resolveName(milestone_id)`;
      on no name, log exactly one failure Sync_Log entry (milestone ID, IID, resolution-failed) and continue via label path
    - Call `resolveStatus(name, labels, state)` and route create/update through `clickup-apply`
    - _Requirements: 1.2, 3.6, 3.7, 4.1, 4.5, 4.7_

  - [ ] 7.2 Preserve QA creation special case and default-assignee behavior
    - Apply QA special case only when `status === null` on **create**: if `milestoneId === QA_MILESTONE_ID`
      (trimmed string compare) set create status `pending review (qa)`
    - Apply `DEFAULT_ASSIGNEE_ID` only when the issue yields zero assignees and the value is a decimal integer `>0`;
      otherwise zero assignees, and when set-but-invalid log a Sync_Log note; still complete creation
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [ ]* 7.3 Write integration tests for the webhook status path
    - Payload-name path (no API call), id-only path (resolver used), QA creation + default-assignee variants
    - _Requirements: 3.1, 3.3, 3.4, 3.5, 4.1, 4.5, 4.7_

- [ ] 8. Refactor `sync-single.js` to delegate to shared modules
  - [ ] 8.1 Delete local duplicates and delegate
    - Remove local `hasLabel`, `getExpectedStatus`, `getExpectedTags`, inline QA special case
    - Use `issue.milestone?.title` as the milestone name; call `resolveStatus(...)`; route create/update through `clickup-apply`
    - Preserve QA creation special case (create-only, when `status === null`)
    - _Requirements: 1.3, 2.5, 3.1, 3.2, 3.6, 3.7, 6.1, 6.2, 6.3, 6.7_

- [ ] 9. Refactor `process-queue.js` to delegate to shared modules
  - [ ] 9.1 Delete local duplicates and delegate with batch counting
    - Remove local `hasLabel`, `getExpectedStatus`, `getExpectedTags`, inline QA special case
    - Use `item.milestone_name` as the milestone name; call `resolveStatus(...)`; route create/update through `clickup-apply`
    - On a status-not-found failure, continue the batch and accumulate a `statusNotFound` count for the run summary
    - _Requirements: 1.4, 2.5, 3.1, 3.2, 3.6, 3.7, 6.1, 6.2, 6.3, 6.7, 7.6, 7.7_

- [ ] 10. Refactor `run-queue.js` to delegate to shared modules
  - [ ] 10.1 Delete local duplicates and delegate with batch counting
    - Remove local `hasLabel`, `getExpectedStatus`, `getExpectedTags`, inline QA special case
    - Use `item.milestone_name` as the milestone name; call `resolveStatus(...)`; route create/update through `clickup-apply`
    - On a status-not-found failure, continue the batch and accumulate a `statusNotFound` count for the run summary
    - _Requirements: 1.4, 2.5, 3.1, 3.2, 3.6, 3.7, 6.1, 6.2, 6.3, 6.7, 7.6, 7.7_

- [ ] 11. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 12. Widen webhook admission (`gitlab-webhook.js`)
  - [ ] 12.1 Admit by mapped name OR allowlisted ID
    - Replace the ID-only gate: process when the resolved milestone **name** is in the Milestone_Status_Map
      OR the milestone **ID** is in `ALLOWED_MILESTONES` (parsed as trimmed, comma-separated, empty-discarded)
    - On skip, record a `skipped` Sync_Log entry carrying the IID and the milestone ID
    - _Requirements: 5.3, 5.4, 5.5, 5.7_

  - [ ]* 12.2 Write integration tests for admission
    - Mapped-name-but-not-allowlisted → processed; neither mapped nor allowlisted → skipped with IID + milestone ID
    - _Requirements: 5.3, 5.4, 5.7_

- [ ] 13. Add per-milestone error isolation to the Issue_Collectors
  - [ ] 13.1 Isolate per-milestone fetch errors in `sync-gitlab.js`
    - Parse `GITLAB_MILESTONES` as trimmed, comma-separated, empty-discarded; wrap each milestone fetch so an
      HTTP `>=400` for one name logs an error Sync_Log entry naming that milestone and continues the remaining names;
      preserve existing dedupe-by-`iid` enqueue
    - _Requirements: 5.1, 5.2, 5.5, 5.8, 5.9_

  - [ ] 13.2 Isolate per-milestone fetch errors in `sync-trigger.js`
    - Same per-milestone try/continue isolation and error logging as `sync-gitlab.js`; preserve dedupe-by-`iid`
    - _Requirements: 5.1, 5.2, 5.5, 5.8, 5.9_

  - [ ]* 13.3 Write property test — enqueue uniqueness
    - **Property 13: Enqueue uniqueness** (overlapping milestone fetch results, each `iid` enqueued once)
    - **Validates: Requirements 5.9**

- [ ] 14. Extend observability for status origin and milestone name
  - [ ] 14.1 Extend the Sync_Log schema in `logger.js`
    - Add `statusOrigin` to the constructed entry; keep `milestone` as the trimmed, ≤255-char name
      (empty string when the issue has no milestone); allow an optional `statusNotFoundCount` on run-summary entries;
      preserve the existing log-write-failure resilience (never revert the ClickUp op; still report success)
    - _Requirements: 8.1, 8.2, 8.3, 8.5, 8.6, 8.7_

  - [ ] 14.2 Normalize the new fields in `logs-store.js`
    - Accept and normalize `statusOrigin`, `milestone` (trim, ≤255), and optional `statusNotFoundCount` on POST
    - _Requirements: 8.1, 8.2, 8.3, 8.5, 8.6_

  - [ ] 14.3 Render milestone name and status origin in `logs.js`
    - Update `renderLogEntry` to display milestone name and status origin; when either is absent show a
      "not recorded" indicator rather than dropping the detail
    - _Requirements: 8.4_

  - [ ] 14.4 Populate `statusOrigin`/`milestone` at each sync log call site
    - In the four refactored handlers, pass `origin` from `resolveStatus` and the trimmed milestone name into `logRun`
    - _Requirements: 8.1, 8.2, 8.3, 8.5, 8.6_

  - [ ]* 14.5 Write tests for log content and rendering
    - Unit: milestone truncation to 255, empty-milestone case, origin values. Integration: Logs page not-recorded
      indicator and log-write-failure resilience
    - _Requirements: 8.1, 8.4, 8.5, 8.7_

- [ ] 15. Update configuration and documentation
  - [ ] 15.1 Document new/changed environment variables
    - In `.env.example` and `README.md`, add the two 2026 Review milestone names to the `GITLAB_MILESTONES`
      example and document any new/changed variables with name, purpose, and example value
    - _Requirements: 5.1, 5.2, 5.6_

- [ ] 16. Final checkpoint - Ensure all tests pass
  - Run `npm install` then `vitest --run`; the full suite (properties + units + integration) must pass.
  - Syntax-check the four refactored handlers and the three new utils.
  - Confirm `.env.example` and `README.md` document the new/changed variables.
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP.
- Each task references specific requirement sub-clauses for traceability.
- Property-test sub-tasks each reference a single design Correctness Property (1–13) and the requirement it validates.
- Properties 2 (idempotence/re-sync stability) is covered within unit task 2.13 (idempotence) and property task 5.3 (no-op update re-sync side).
- The Status_Resolver is kept pure so Properties 1–9 and 12 are testable without any network.
- Checkpoints enforce incremental validation after the core module, after the apply module, after refactors, and at the end.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["2.2"] },
    { "id": 3, "tasks": ["2.3", "4.1", "5.1"] },
    { "id": 4, "tasks": ["2.4", "2.5", "2.6", "2.7", "2.8", "2.9", "2.10", "2.11", "2.12", "2.13", "4.2", "5.2", "14.1"] },
    { "id": 5, "tasks": ["5.3", "5.4", "7.1", "8.1", "9.1", "10.1", "13.1", "13.2", "14.2", "15.1"] },
    { "id": 6, "tasks": ["5.5", "7.2", "12.1", "13.3", "14.3"] },
    { "id": 7, "tasks": ["7.3", "12.2", "14.4"] },
    { "id": 8, "tasks": ["14.5"] }
  ]
}
```
