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

const { logRun } = require('./logger');

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

/**
 * Create a ClickUp task, applying status-not-found rejection handling
 * (Req 6.1, 7.1, 7.3, 7.4).
 *
 * The caller supplies `clickupRequest(method, path, body)` (async; throws
 * `Error("ClickUp API <status>: <JSON.stringify(data)>")` on a non-OK response)
 * and has already assembled `body` with every field it wants on the new task,
 * including any Target_Status / QA special-case status it resolved. This function
 * only guarantees a sensible default status and the fallback-to-`Open` behavior:
 *
 *   1. Ensure `body.status` defaults to `'Open'` when the caller left it unset.
 *   2. POST the create. On success → `{ task, created:true, statusNotFound:false, fallbackUsed:false }`.
 *   3. If ClickUp rejects the status as nonexistent in the list, log ONE error
 *      Sync_Log entry (IID, milestone name, the rejected status, list id) and retry
 *      ONCE with `status:'Open'` (all other body fields identical). The 5s window in
 *      the spec is an upper bound; an immediate retry satisfies it.
 *        - retry succeeds → `{ task, created:true, statusNotFound:false, fallbackUsed:true }`.
 *        - retry also status-not-found → do NOT create; log ONE error entry noting
 *          both the mapped status and the `Open` fallback were rejected; return
 *          `{ task:null, created:false, statusNotFound:true, fallbackUsed:true }`.
 *   4. Any non-status error propagates (re-thrown).
 *
 * @param {Function} clickupRequest - async (method, path, body) => data
 * @param {string} listId - the ClickUp list id the task is created in
 * @param {Object} body - the create request body (fields already assembled by caller)
 * @param {Object} [ctx]
 * @param {*} [ctx.issueIid] - GitLab issue IID (for logging)
 * @param {*} [ctx.milestoneName] - resolved milestone name (for logging)
 * @returns {Promise<{task: (Object|null), created: boolean, statusNotFound: boolean, fallbackUsed: boolean}>}
 */
async function createTask(clickupRequest, listId, body, { issueIid, milestoneName } = {}) {
  // Default the create status to 'Open' when the caller did not set one (Req 7.1).
  body.status = body.status || 'Open';
  const mappedStatus = body.status;

  try {
    const task = await clickupRequest('POST', `/list/${listId}/task`, body);
    return { task, created: true, statusNotFound: false, fallbackUsed: false };
  } catch (err) {
    if (!isStatusNotFoundError(err)) {
      // Non-status errors propagate unchanged (Req 7.1).
      throw err;
    }

    // Status rejected by ClickUp: log one error entry, then retry once with 'Open' (Req 7.3).
    await logRun({
      source: 'clickup-apply',
      action: 'create',
      status: 'error',
      issueIid: issueIid || null,
      milestone: milestoneName || null,
      clickupStatus: mappedStatus,
      error: `ClickUp rejected status "${mappedStatus}" (not found in list ${listId}); retrying with "Open".`,
      details: { listId, rejectedStatus: mappedStatus },
    });

    // Immediate retry with status 'Open', all other body fields identical (Req 7.3).
    const retryBody = Object.assign({}, body, { status: 'Open' });
    try {
      const task = await clickupRequest('POST', `/list/${listId}/task`, retryBody);
      return { task, created: true, statusNotFound: false, fallbackUsed: true };
    } catch (retryErr) {
      if (!isStatusNotFoundError(retryErr)) {
        // A non-status error on the retry propagates (Req 7.1).
        throw retryErr;
      }

      // Both the mapped status AND the 'Open' fallback were rejected: do NOT create (Req 7.4).
      await logRun({
        source: 'clickup-apply',
        action: 'create',
        status: 'error',
        issueIid: issueIid || null,
        milestone: milestoneName || null,
        clickupStatus: 'Open',
        error: `ClickUp rejected both the mapped status "${mappedStatus}" and the "Open" fallback (not found in list ${listId}); task not created.`,
        details: { listId, rejectedStatus: mappedStatus, fallbackStatus: 'Open' },
      });

      return { task: null, created: false, statusNotFound: true, fallbackUsed: true };
    }
  }
}

/**
 * Apply a ClickUp task update (PUT), applying status-not-found rejection handling
 * (Req 6.2, 6.3, 6.5, 6.6, 6.7, 7.2, 7.5).
 *
 * `updates` is the already-built update request body (produced by the caller, e.g.
 * via `buildUpdateRequest`). This function performs the PUT and classifies the result:
 *
 *   - success → `{ applied:true, statusNotFound:false }`.
 *   - status-not-found rejection → leave the task unchanged, do NOT retry, log ONE
 *     error Sync_Log entry (IID, milestone name, the rejected status, list id), and
 *     return `{ applied:false, statusNotFound:true }` (Req 7.2, 7.5).
 *   - any non-status error propagates (re-thrown).
 *
 * @param {Function} clickupRequest - async (method, path, body) => data
 * @param {string} taskId - the ClickUp task id to update
 * @param {Object} updates - the pre-built update request body
 * @param {Object} [ctx]
 * @param {*} [ctx.issueIid] - GitLab issue IID (for logging)
 * @param {*} [ctx.milestoneName] - resolved milestone name (for logging)
 * @param {*} [ctx.rejectedStatus] - optional explicit rejected status (defaults to updates.status)
 * @param {*} [ctx.listId] - the task's list id (for logging context)
 * @returns {Promise<{applied: boolean, statusNotFound: boolean}>}
 */
async function updateTask(clickupRequest, taskId, updates, { issueIid, milestoneName, rejectedStatus, listId } = {}) {
  try {
    await clickupRequest('PUT', `/task/${taskId}`, updates);
    return { applied: true, statusNotFound: false };
  } catch (err) {
    if (!isStatusNotFoundError(err)) {
      // Non-status errors propagate unchanged (Req 7.2).
      throw err;
    }

    // Status rejected: leave the task unchanged, do NOT retry, log one error (Req 7.2, 7.5).
    const badStatus = rejectedStatus != null ? rejectedStatus : updates.status;
    await logRun({
      source: 'clickup-apply',
      action: 'update',
      status: 'error',
      issueIid: issueIid || null,
      milestone: milestoneName || null,
      clickupTaskId: taskId,
      clickupStatus: badStatus != null ? badStatus : null,
      error: `ClickUp rejected status "${badStatus}" (not found in list ${listId != null ? listId : 'unknown'}); task left unchanged.`,
      details: { listId: listId != null ? listId : null, rejectedStatus: badStatus != null ? badStatus : null },
    });

    return { applied: false, statusNotFound: true };
  }
}

module.exports = {
  statusEquals,
  isStatusNotFoundError,
  buildUpdateRequest,
  createTask,
  updateTask,
};
