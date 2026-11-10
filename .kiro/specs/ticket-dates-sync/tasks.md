# Implementation Plan: ticket-dates-sync

## Overview

This plan implements the `ticket dates` checklist reconciliation as a single never-throwing module (`netlify/functions/utils/ticket-dates.js`) plus two call-site insertions, following the design strictly. Work proceeds bottom-up: first the pure helpers (date formatter, label matching, item parsing), then the reconciliation entry point built step-by-step per the design's 7 internal steps, then the test harness (`makeFakeClickup` + `fast-check`), then the 13 property tests and example/unit tests, and finally the call-site wiring in `process-queue.js` and `sync-single.js` with their integration tests. Each coding task builds on the previous and ends wired into the sync paths, so no orphaned code remains.

The implementation language is JavaScript (Node / CommonJS), matching the existing `netlify/functions/utils/signoff.js` module and the design's choice of `fast-check` for Node.

## Tasks

- [x] 1. Set up the test runner and PBT tooling
  - Add `fast-check` as a dev dependency in `package.json` and add a `node --test` test script (e.g. `"test": "node --test"`) so property and unit tests can run with the built-in Node test runner
  - Create the `tests/` (or `netlify/functions/utils/__tests__/`) directory for the new test files
  - Run `npm install` to install `fast-check`
  - _Requirements: Design "Testing Strategy" / "Tooling"_

- [x] 2. Implement the pure helpers in `netlify/functions/utils/ticket-dates.js`
  - [x] 2.1 Create the module skeleton and `CHECKLIST_NAME` + `formatDateUtc`
    - Create `netlify/functions/utils/ticket-dates.js` exporting `CHECKLIST_NAME = 'ticket dates'`
    - Implement `formatDateUtc(value)`: accept ISO 8601 string, epoch-millis number, or `Date`; parse via `new Date(value)`; return `null` for `null`/empty/`Invalid Date`; otherwise render `YYYY-MM-DD HH:mm:ss UTC` using UTC getters with fixed-width zero-padding
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

  - [x]* 2.2 Write property test for the date format
    - **Feature: ticket-dates-sync, Property 12: All rendered dates share one fixed-width format**
    - Generate valid source dates; assert every `formatDateUtc` output matches `^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$` (min 100 iterations)
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.4**

  - [x]* 2.3 Write property test for UTC normalization
    - **Feature: ticket-dates-sync, Property 13: Source dates are normalized to UTC before formatting**
    - Generate two inputs denoting the same instant with different offsets; assert `formatDateUtc` returns the identical string equal to the instant's UTC rendering (min 100 iterations)
    - **Validates: Requirements 8.5**

  - [x]* 2.4 Write example test for the exact formatted string
    - Assert `formatDateUtc('2024-03-07T14:05:09.000Z') === '2024-03-07 14:05:09 UTC'`; assert `''`, `null`, `undefined`, and `'not-a-date'` each return `null`
    - _Requirements: 8.6, 2.4_

  - [x] 2.5 Implement `labelTitlesLower` and `hasLabelCI`
    - `labelTitlesLower(labels)`: accept `string[]` and `{title}[]` shapes, return lowercase titles (mirror `signoff.js`)
    - `hasLabelCI(labels, title)`: case-insensitive membership check using `labelTitlesLower`
    - _Requirements: 3.5, 4.5_

  - [x]* 2.6 Write property test for label matching
    - **Feature: ticket-dates-sync, Property 7: Label matching is case-insensitive across both shapes**
    - Generate label sets as `string[]` and `{title}[]` with the triggering title in mixed case; assert detection matches a canonical lowercase comparison for both "For Release" and "Released" (min 100 iterations)
    - **Validates: Requirements 3.5, 4.5**

  - [x] 2.7 Implement `fieldOf`, `isFrozenField`, and `itemValue`
    - `fieldOf(text)`: return `'created_at'|'for_release_at'|'released_at'` when `text` starts with that prefix + `:`, else `null`
    - `isFrozenField(field)`: `true` for `for_release_at` and `released_at`
    - `itemValue(text)`: return `text.slice(text.indexOf(':') + 1).trim()`
    - Export all helpers from the module
    - _Requirements: 2.1, 3.1, 4.1, 5.1, 5.3, 6.5_

- [x] 3. Checkpoint - Ensure helper tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement `syncTicketDatesChecklist` reconciliation entry point
  - [x] 4.1 Implement read + find/create checklist + outer never-throw wrapper
    - Add `syncTicketDatesChecklist(clickupRequest, taskId, issue, status)` wrapped in a single `try/catch`
    - Step 1 (Read): `GET /task/{taskId}`; on throw, short-circuit before any mutation and return `{ ok: false, error }`
    - Step 2 (Find/create): reuse the first checklist whose trimmed name equals `ticket dates`; if none, `POST /task/{taskId}/checklist` with `{ name: 'ticket dates' }` and treat its items as `[]`
    - On catch, log exactly one diagnostic `[ticket-dates] Failed to sync checklist on task {taskId}: {err.message}` and return `{ ok: false, error: err.message }`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 5.5, 5.6, 7.3, 7.5_

  - [x]* 4.2 Write property test for read-before-mutation ordering
    - **Feature: ticket-dates-sync, Property 1: Read happens before any mutation**
    - Using the fake harness, assert the `GET /task/{taskId}` call index precedes every `POST`/`PUT`/`DELETE` (min 100 iterations)
    - **Validates: Requirements 1.1, 5.5**

  - [x]* 4.3 Write property test for create-exactly-once-when-absent
    - **Feature: ticket-dates-sync, Property 2: Checklist is created exactly once only when absent**
    - Generate tasks with zero/one/many `ticket dates` checklists; assert exactly one create when absent, zero creates and first-match reuse otherwise (min 100 iterations)
    - **Validates: Requirements 1.2, 1.3, 1.4**

  - [x] 4.4 Implement Step 3 — dedupe per field
    - Group existing items by `fieldOf(item.name)`; for any field with more than one item, keep the first and `DELETE /checklist/{id}/checklist_item/{extraId}` the rest
    - _Requirements: 6.5_

  - [x]* 4.5 Write property test for duplicate collapse
    - **Feature: ticket-dates-sync, Property 8: Duplicates collapse to exactly one item per field**
    - Pre-seed two or more items for the same field; assert exactly one remains and each extra id received a `DELETE` (min 100 iterations)
    - **Validates: Requirements 6.5**

  - [x] 4.6 Implement Step 4 — created_at add/update in place
    - Compute `formatDateUtc(issue.created_at)`; if `null`, leave any existing created_at item unchanged and add nothing
    - If a created_at item exists, `PUT` its text to `created_at: <date>` only when the stored value differs; if none exists, `POST` one
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 6.4, 6.6, 8.2, 8.6_

  - [x]* 4.7 Write property test for single created_at item
    - **Feature: ticket-dates-sync, Property 3: Exactly one created_at item, added or updated in place**
    - For arbitrary checklist state and parseable `issue.created_at`, assert exactly one created_at item after sync, added when absent / updated in place when present (never duplicated), and no write when the stored value already equals the formatted value (min 100 iterations)
    - **Validates: Requirements 2.1, 2.2, 6.4, 6.6**

  - [x]* 4.8 Write example tests for unparseable created_at
    - With `issue.created_at` of `''`, `null`, and `'not-a-date'`, assert no created_at write is issued and the for_release_at / released_at steps still reconcile
    - _Requirements: 2.4, 8.6_

  - [x] 4.9 Implement Step 5 — for_release_at first-observation + freeze
    - If a non-empty for_release_at item exists, skip entirely (no write/update/delete)
    - Otherwise, if the For Release label is present OR (first sync and `status` at/after "for release" on the status ladder), `POST for_release_at: <observation time>`; if the label is absent and no item exists, do nothing
    - Define the status ladder / "at or after for release" check consistent with the design
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.6, 5.1, 5.2_

  - [x] 4.10 Implement Step 6 — released_at first-observation + freeze
    - Symmetric to Step 5 using the Released label; if a non-empty released_at item exists, skip entirely; otherwise, if the Released label is present, `POST released_at: <observation time>`; if absent and no item exists, do nothing
    - Then return `{ ok: true, checklistId, items: { created_at, for_release_at, released_at }, wrote: [...] }`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.6, 5.3, 5.4_

  - [x]* 4.11 Write property test for first-observation recording
    - **Feature: ticket-dates-sync, Property 4: First observation records a frozen field**
    - Assert that with no for_release_at item and the For Release label present (or first-sync status at/after "for release"), exactly one `for_release_at: <obs time>` item is added; symmetrically for released_at with the Released label (min 100 iterations)
    - **Validates: Requirements 3.1, 3.4, 4.1, 4.4**

  - [x]* 4.12 Write property test for no-create-when-label-absent
    - **Feature: ticket-dates-sync, Property 5: No frozen-field item is created when its label is absent**
    - Assert that when a frozen field's item is absent and its triggering label is absent (and, for for_release_at, status below "for release"), zero items for that field are created (min 100 iterations)
    - **Validates: Requirements 3.2, 4.2**

  - [x]* 4.13 Write property test for the freeze invariant
    - **Feature: ticket-dates-sync, Property 6: Freeze invariant — existing frozen values are never changed**
    - Pre-seed a non-empty for_release_at/released_at item; run arbitrary subsequent syncs with arbitrary label states (including label removal); assert the stored value is identical before/after and no `PUT`/`DELETE` targets that item's id (min 100 iterations)
    - **Validates: Requirements 3.3, 4.3, 5.1, 5.2, 5.3, 5.4**

- [x] 5. Checkpoint - Ensure reconciliation tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Build the in-memory fake ClickUp harness and failure/idempotency tests
  - [x] 6.1 Implement `makeFakeClickup(initialTask)`
    - Return `{ clickupRequest, calls, store }`; record every `{ method, path, body }` in `calls` in order
    - `store` applies `POST /task/{id}/checklist`, `POST /checklist/{id}/checklist_item`, `PUT .../checklist_item/{itemId}`, and `DELETE .../checklist_item/{itemId}` so repeated syncs observe prior effects
    - Support a `failAt(predicate)` option that makes `clickupRequest` reject on a matching call
    - _Requirements: Design "Testing Strategy" / "Mock / fake harness"_

  - [x]* 6.2 Write property test for idempotent convergence
    - **Feature: ticket-dates-sync, Property 9: Idempotent convergence over repeated syncs**
    - For arbitrary initial state and N ≥ 1 consecutive syncs against the same fake store, assert exactly one created_at item and at most one for_release_at and one released_at item at the end (min 100 iterations)
    - **Validates: Requirements 6.1, 6.2, 6.3**

  - [x]* 6.3 Write property test for non-throwing failure result
    - **Feature: ticket-dates-sync, Property 10: Failures resolve to a non-throwing failure result**
    - Inject a single failure at the read, checklist-create, or item-write step; assert the call resolves (never rejects) with `{ ok: false, error }` (min 100 iterations)
    - **Validates: Requirements 1.5, 3.6, 4.6, 7.3**

  - [x]* 6.4 Write property test for failed-read zero-mutation
    - **Feature: ticket-dates-sync, Property 11: A failed read performs zero mutations and surfaces an error**
    - Force the initial `GET /task/{taskId}` to fail; assert no `POST`/`PUT`/`DELETE` is issued, the result is `{ ok: false, error }`, and existing frozen items are untouched (min 100 iterations)
    - **Validates: Requirements 5.6**

  - [x]* 6.5 Write example test for the single failure diagnostic
    - Spy on `console.error`; inject a failure; assert exactly one diagnostic line is logged containing the task id
    - _Requirements: 7.5_

- [x] 7. Checkpoint - Ensure all module and property tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Wire the invocation into the two sync entry points
  - [x] 8.1 Wire `syncTicketDatesChecklist` into `process-queue.js`
    - Add `const { syncTicketDatesChecklist } = require('./utils/ticket-dates');`
    - On the update path in `processIssue`, immediately after the existing `await syncSignoffChecklist(...)`, call `await syncTicketDatesChecklist(clickupRequest, taskId, item, updates.status || existing.status);`
    - On the create path, immediately after the existing `await syncSignoffChecklist(...)`, call `await syncTicketDatesChecklist(clickupRequest, newTask.id, item, status);`
    - Ignore the result for the core outcome (match the sign-off pattern)
    - _Requirements: 7.1, 7.4_

  - [x] 8.2 Wire `syncTicketDatesChecklist` into `sync-single.js`
    - Add `const { syncTicketDatesChecklist } = require('./utils/ticket-dates');`
    - On the update path in the handler, immediately after the existing `await syncSignoffChecklist(...)`, call `await syncTicketDatesChecklist(clickupRequest, taskId, issue, updates.status || existingTask.status?.status);`
    - On the create path, immediately after the existing `await syncSignoffChecklist(...)`, call `await syncTicketDatesChecklist(clickupRequest, newTask.id, issue, status);`
    - Ignore the result for the core outcome (match the sign-off pattern)
    - _Requirements: 7.2, 7.4_

  - [ ]* 8.3 Write integration tests for `process-queue.js` wiring
    - With a mocked `clickupRequest`, exercise the create path and the update path; assert `syncTicketDatesChecklist` is called exactly once on each, immediately after `syncSignoffChecklist`, with `(clickupRequest, taskId, item, appliedStatus)`
    - _Requirements: 7.1_

  - [ ]* 8.4 Write integration tests for `sync-single.js` wiring and core isolation
    - Assert the same once-per-path invocation with the `issue` object on the manual create and update paths
    - Force the helper to return `{ ok: false }` (and separately to reject) and assert the handler still returns its core success response unchanged
    - _Requirements: 7.2, 7.4_

- [x] 9. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (tests) and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references the specific requirements and/or design properties it implements for traceability.
- The 13 correctness properties map to 13 property-based tests (P1–P13), each tagged with the exact comment format `Feature: ticket-dates-sync, Property {number}: {property_text}` and run at a minimum of 100 iterations.
- Property tests are placed close to the implementation they validate so errors are caught early; the harness-dependent properties (P9–P11) follow the `makeFakeClickup` task.
- The module never throws: all failures are caught by a single outer `try/catch` and returned as `{ ok: false, error }`, so the core sync is never broken.
- Call sites `await` the helper but ignore its result for the core response, exactly as they do for `syncSignoffChecklist`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1"] },
    { "id": 1, "tasks": ["2.2", "2.3", "2.4", "2.5", "2.7"] },
    { "id": 2, "tasks": ["2.6", "4.1"] },
    { "id": 3, "tasks": ["4.2", "4.3", "4.4"] },
    { "id": 4, "tasks": ["4.5", "4.6", "4.9"] },
    { "id": 5, "tasks": ["4.7", "4.8", "4.10", "4.11", "4.12"] },
    { "id": 6, "tasks": ["4.13", "6.1"] },
    { "id": 7, "tasks": ["6.2", "6.3", "6.4", "6.5", "8.1", "8.2"] },
    { "id": 8, "tasks": ["8.3", "8.4"] }
  ]
}
```
