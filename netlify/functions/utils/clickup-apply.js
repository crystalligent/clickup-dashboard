/**
 * ClickUp_Apply (shared ClickUp status application).
 *
 * Centralizes building ClickUp create/update requests, no-op (status) detection,
 * and ClickUp "status does not exist in list" rejection handling so that Req 6
 * and Req 7 behave identically across all four sync paths
 * (gitlab-webhook.js, sync-single.js, process-queue.js, run-queue.js).
 *
 * This module intentionally performs NO network I/O of its own — callers pass in
 * their existing `clickupRequest` implementation. The network-facing create/update
 * helpers (createTask / updateTask) are added by task 5.2; this file (task 5.1)
 * implements only the pure helpers and the update-request builder, and exports
 * them in a shape that task 5.2 extends.
 */

/**
 * Normalized status equality for no-op detection (Req 6.2, 6.3).
 *
 * Compares two ClickUp status names ignoring leading/trailing whitespace and
 * letter case. Non-string inputs (null, undefined, numbers, objects) are treated
 * as not comparable, so they are never equal to anything — this keeps the
 * "current status unknown" path (Req 6.6) in buildUpdateRequest working.
 *
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function statusEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Detects a ClickUp "status does not exist in list" rejection from a thrown error.
 *
 * Kept deliberately narrow so unrelated 400s are not misclassified. ClickUp returns
 * a 400 whose error payload carries a "Status not found" style message. The existing
 * `clickupRequest` helpers throw `new Error("ClickUp <code>: <JSON.stringify(data)>")`,
 * so the signature typically lands in `err.message`; we also defensively inspect
 * `err.body` and `err.data` (either strings or objects) in case a caller attaches
 * the raw payload.
 *
 * @param {*} err
 * @returns {boolean}
 */
function isStatusNotFoundError(err) {
  if (!err) return false;

  // Collect candidate text fragments from the various shapes an error may carry.
  const parts = [];

  const push = (val) => {
    if (val == null) return;
    if (typeof val === 'string') {
      parts.push(val);
    } else if (typeof val === 'object') {
      // ClickUp error payloads look like { err: "...", ECODE: "..." }.
      if (typeof val.err === 'string') parts.push(val.err);
      if (typeof val.error === 'string') parts.push(val.error);
      if (typeof val.message === 'string') parts.push(val.message);
      try {
        parts.push(JSON.stringify(val));
      } catch (e) {
        /* non-serializable; ignore */
      }
    }
  };

  push(err.message);
  push(err.body);
  push(err.data);
  // The error itself may be a plain object/string in some call sites.
  if (typeof err === 'string') push(err);

  const haystack = parts.join(' ').toLowerCase();
  if (!haystack) return false;

  return (
    haystack.includes('status not found') ||
    haystack.includes('status does not exist')
  );
}

/**
 * Build the field map for a ClickUp update (PUT) request, applying the status
 * inclusion rules (Req 2.6, 6.2, 6.3, 6.5, 6.6, 6.7).
 *
 * Non-status fields (name, assignees, tags, etc.) are ALWAYS included (Req 6.7).
 * The `status` field is included only when:
 *   - targetStatus is a non-empty-ish, non-null string, AND
 *   - it is NOT equal to currentStatus under trim + case-insensitive normalization
 *     (Req 6.2 — differ ⇒ include; Req 6.3 — equal ⇒ omit), OR
 *   - currentStatus is unknown (null/undefined/non-string) while targetStatus is a
 *     usable string (Req 6.6 — include when current cannot be determined).
 * The `status` field is omitted when targetStatus is null (Req 2.6) or when it
 * equals the current status under normalization (Req 6.3).
 *
 * @param {Object} params
 * @param {*} params.currentStatus - the task's current ClickUp status (may be unknown)
 * @param {*} params.targetStatus  - the resolved Target_Status (null means "leave unchanged")
 * @param {Object} [params.otherFields] - non-status fields to always include
 * @returns {Object} the update request body
 */
function buildUpdateRequest({ currentStatus, targetStatus, otherFields } = {}) {
  // Non-status fields are always included (Req 6.7). Shallow copy so callers'
  // objects are not mutated.
  const request = Object.assign({}, otherFields || {});

  // Omit status entirely when there is no Target_Status (Req 2.6).
  if (typeof targetStatus !== 'string') {
    return request;
  }

  const currentKnown = typeof currentStatus === 'string';

  if (!currentKnown) {
    // Current status unknown but a Target_Status exists → include it (Req 6.6).
    request.status = targetStatus;
  } else if (!statusEquals(currentStatus, targetStatus)) {
    // Known and differs under normalization → include (Req 6.2).
    request.status = targetStatus;
  }
  // Known and equal under normalization → omit (Req 6.3).

  return request;
}

module.exports = {
  statusEquals,
  isStatusNotFoundError,
  buildUpdateRequest,
};
