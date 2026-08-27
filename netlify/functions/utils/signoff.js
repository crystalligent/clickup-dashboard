/**
 * Developer / QA sign-off checklist helper.
 *
 * Builds and maintains a "Sign-off" checklist on each ClickUp task, driven by:
 *   DEVELOPER_USERNAMES - comma-separated GitLab usernames treated as developers
 *   QA_USERNAMES        - comma-separated GitLab usernames treated as QAs
 *   NO_QA_LABELS        - comma-separated GitLab label titles for which QA is skipped
 *                         (e.g. "Data Correction"). Case-insensitive match.
 *   SIGNOFF_RESOLVE_STATUSES - comma-separated ClickUp statuses that resolve (check)
 *                         all rows. Defaults to "released to prod".
 *
 * Design rules (agreed with the team):
 *   - One developer and (usually) one QA per ticket. Latest assignee wins, so the
 *     row text is always overwritten to reflect the current assignee.
 *   - QA row is included for every ticket EXCEPT those carrying a no-QA label.
 *   - A required role with no matching assignee shows "(unassigned)" so it is
 *     visibly pending.
 *   - Assignees who are in neither role list are ignored.
 *   - The checklist is reconciled (never duplicated) on repeated syncs.
 */

const CHECKLIST_NAME = 'Sign-off';

function parseCsvEnv(key, fallback = '') {
  const raw = process.env[key];
  return String(raw == null ? fallback : raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Normalize a GitLab assignees array into { username, name } objects.
 * Webhook payload and REST API both expose .username; .name may be absent.
 */
function normalizeAssignees(gitlabAssignees) {
  if (!Array.isArray(gitlabAssignees)) return [];
  return gitlabAssignees
    .filter((a) => a && a.username)
    .map((a) => ({ username: a.username, name: a.name || a.username }));
}

/**
 * Normalize labels (webhook uses [{title}], REST uses ["title"]) to lowercase titles.
 */
function labelTitlesLower(labels) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((l) => (typeof l === 'string' ? l : l && l.title))
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

function qaIsRequired(labels) {
  const noQaLabels = parseCsvEnv('NO_QA_LABELS', 'Data Correction').map((l) => l.toLowerCase());
  if (noQaLabels.length === 0) return true;
  const present = labelTitlesLower(labels);
  return !present.some((t) => noQaLabels.includes(t));
}

/**
 * Decide the rows the Sign-off checklist should contain for this ticket.
 * Returns an ordered array of { role: 'Developer'|'QA', text: 'Developer: X' }.
 */
function buildSignoffRows(gitlabAssignees, labels) {
  const developers = parseCsvEnv('DEVELOPER_USERNAMES');
  const qas = parseCsvEnv('QA_USERNAMES');
  const assignees = normalizeAssignees(gitlabAssignees);

  // Latest assignee wins: last matching assignee in the array is used.
  const findLatest = (roleUsernames) => {
    let match = null;
    for (const a of assignees) {
      if (roleUsernames.includes(a.username)) match = a;
    }
    return match;
  };

  const rows = [];

  const dev = findLatest(developers);
  rows.push({ role: 'Developer', text: `Developer: ${dev ? dev.name : '(unassigned)'}` });

  if (qaIsRequired(labels)) {
    const qa = findLatest(qas);
    rows.push({ role: 'QA', text: `QA: ${qa ? qa.name : '(unassigned)'}` });
  }

  return rows;
}

function shouldResolveSignoff(status) {
  if (!status) return false;
  const resolveStatuses = parseCsvEnv('SIGNOFF_RESOLVE_STATUSES', 'released to prod').map((s) =>
    s.toLowerCase()
  );
  return resolveStatuses.includes(String(status).toLowerCase());
}

/**
 * Once a ticket reaches "for release" (or any later status), the developer of
 * record is frozen: GitLab may reassign the ticket to a release handler / PM
 * (e.g. Crystal Dimalanta), and we must NOT let that overwrite the Developer row.
 *
 * "For release and later" is expressed as an ordered status ladder so we don't
 * have to enumerate every downstream status. The freeze point is configurable
 * via DEVELOPER_FREEZE_STATUS (default "for release"); every status at or after
 * it on the ladder freezes the Developer row. Statuses not on the ladder (e.g.
 * "Closed", "resolved - no code changes") are treated as frozen too, since they
 * only occur at/after release.
 *
 * QA rows are never affected by the freeze.
 */
const STATUS_LADDER = [
  'open',
  'pending review (qa)',
  'ongoing dev',
  'testing: failed',
  'ongoing testing',
  'done development',
  'for deployment to hotfix',
  'for testing in hotfix',
  'for release',
  'released to prod',
];

function developerIsFrozen(status) {
  if (!status) return false;
  const s = String(status).toLowerCase();
  const freezePoint = (process.env.DEVELOPER_FREEZE_STATUS || 'for release').toLowerCase();
  const freezeIdx = STATUS_LADDER.indexOf(freezePoint);
  const statusIdx = STATUS_LADDER.indexOf(s);

  // Status not on the ladder (Closed, resolved - no code changes, etc.) only
  // happens at/after release, so treat it as frozen.
  if (statusIdx === -1) return true;
  if (freezeIdx === -1) return false;
  return statusIdx >= freezeIdx;
}

/**
 * Reconcile the "Sign-off" checklist on a task.
 *
 * @param {function} clickupRequest - async (method, path, body?) => data, as defined per function.
 * @param {string}   taskId
 * @param {Array}    gitlabAssignees - raw GitLab assignees array
 * @param {Array}    labels          - raw GitLab labels (string[] or {title}[])
 * @param {string}   status          - the ClickUp status just applied (for resolve trigger)
 *
 * Behavior:
 *   - Fetches the task to read existing checklists (dedup).
 *   - Creates the "Sign-off" checklist if missing.
 *   - Adds/updates rows so text matches the current developer/QA (latest wins).
 *   - Removes stale rows (e.g. a QA row that should no longer exist).
 *   - Resolves (checks) all rows when status is a resolve status; otherwise leaves
 *     resolved state untouched.
 *
 * Never throws — failures are caught and returned as { ok:false, error } so the
 * core sync (name/status/assignee) is never broken by checklist issues.
 */
async function syncSignoffChecklist(clickupRequest, taskId, gitlabAssignees, labels, status) {
  try {
    const desiredRows = buildSignoffRows(gitlabAssignees, labels);
    const resolveAll = shouldResolveSignoff(status);
    const devFrozen = developerIsFrozen(status);

    // Read the full task to inspect existing checklists.
    const task = await clickupRequest('GET', `/task/${taskId}`);
    const checklists = task.checklists || [];
    let checklist = checklists.find((c) => c.name === CHECKLIST_NAME);

    // Create the checklist if it doesn't exist yet.
    if (!checklist) {
      const created = await clickupRequest('POST', `/task/${taskId}/checklist`, {
        name: CHECKLIST_NAME,
      });
      // Response wraps the checklist under `.checklist`.
      checklist = created.checklist || created;
      checklist.items = checklist.items || [];
    }

    const existingItems = checklist.items || [];

    // Match existing items to desired rows by role prefix ("Developer:" / "QA:").
    const rolePrefix = (name) => {
      if (/^Developer:/i.test(name)) return 'Developer';
      if (/^QA:/i.test(name)) return 'QA';
      return null;
    };

    const desiredRoles = new Set(desiredRows.map((r) => r.role));

    // 1) Add or update a row per desired role.
    for (const row of desiredRows) {
      const match = existingItems.find((it) => rolePrefix(it.name) === row.role);

      // Freeze the Developer of record at/after "for release": if a Developer
      // row already exists, preserve it verbatim (GitLab may have reassigned the
      // ticket to a release handler / PM). QA rows always update normally.
      // A missing Developer row is still created from current data so the row
      // isn't absent for tickets first seen at/after release.
      if (devFrozen && row.role === 'Developer' && match) {
        continue;
      }

      if (!match) {
        // Create the item.
        await clickupRequest('POST', `/checklist/${checklist.id}/checklist_item`, {
          name: row.text,
        });
      } else {
        // Update text if the assignee changed.
        if (match.name !== row.text) {
          await clickupRequest('PUT', `/checklist_item/${match.id}`, { name: row.text });
        }
      }
    }

    // 2) Remove stale rows whose role is no longer desired (e.g. QA dropped).
    for (const it of existingItems) {
      const role = rolePrefix(it.name);
      if (role && !desiredRoles.has(role)) {
        await clickupRequest('DELETE', `/checklist_item/${it.id}`);
      }
    }

    // 3) Resolve (or unresolve) rows based on status.
    //    Re-fetch item ids: for newly created items we don't have ids locally,
    //    so read the checklist fresh from the task.
    if (resolveAll) {
      const refreshed = await clickupRequest('GET', `/task/${taskId}`);
      const cl = (refreshed.checklists || []).find((c) => c.name === CHECKLIST_NAME);
      const items = (cl && cl.items) || [];
      for (const it of items) {
        if (rolePrefix(it.name) && !it.resolved) {
          await clickupRequest('PUT', `/checklist_item/${it.id}`, { resolved: true });
        }
      }
    }

    return { ok: true, rows: desiredRows.map((r) => r.text), resolved: resolveAll };
  } catch (err) {
    console.error(`[signoff] Failed to sync checklist on task ${taskId}:`, err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  CHECKLIST_NAME,
  buildSignoffRows,
  qaIsRequired,
  shouldResolveSignoff,
  developerIsFrozen,
  syncSignoffChecklist,
};
