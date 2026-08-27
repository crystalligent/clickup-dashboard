/**
 * Developer / QA sign-off checklist helper.
 *
 * Builds and maintains a "Sign-off" checklist on each ClickUp task. Each row is a
 * fixed role label ("Developer" / "QA"); the actual person is set as the checklist
 * item's ASSIGNEE (avatar), not embedded in the text.
 *
 * Config (env):
 *   DEVELOPER_USERNAMES - comma-separated GitLab usernames treated as developers
 *   QA_USERNAMES        - comma-separated GitLab usernames treated as QAs
 *   NO_QA_LABELS        - comma-separated GitLab label titles for which QA is skipped
 *                         (e.g. "Data Correction"). Case-insensitive match.
 *   SIGNOFF_RESOLVE_STATUSES - comma-separated ClickUp statuses that resolve (check)
 *                         all rows. Defaults to "released to prod".
 *   DEVELOPER_FREEZE_STATUS - at/after this status the Developer row's assignee is
 *                         frozen (default "for release").
 *
 * Design rules (agreed with the team):
 *   - One developer and (usually) one QA per ticket. Latest matching assignee wins.
 *   - The row's person is the checklist item ASSIGNEE (a ClickUp member id resolved
 *     from the GitLab username). If no ClickUp id is known, the row stays present
 *     but unassigned (no avatar) so the pending role is still visible.
 *   - QA row is included for every ticket EXCEPT those carrying a no-QA label.
 *   - Assignees who are in neither role list are ignored.
 *   - Once a ticket reaches "for release" (or later), the Developer row's assignee
 *     is frozen (GitLab may reassign to a release handler/PM). QA keeps updating.
 *   - The checklist is reconciled (never duplicated) on repeated syncs.
 */

const CHECKLIST_NAME = 'Sign-off';

// GitLab username -> ClickUp member id. Sourced from the ClickUp list members.
// Used to set the checklist item ASSIGNEE for the person in each role.
const CLICKUP_MEMBER_IDS = {
  // Developers
  jgregorio: 89079122, // Jomar Gregorio
  cdimalanta: 270739823, // Crystal Dimalanta
  mtanqueco: 3827858, // Mikee Tanqueco
  emonding: 100842272, // Emil John Monding
  // QAs
  agregorio: 89084186, // AC Gregorio
  dcomia: 95085613, // Diana Comia
  jcochangco: 95085608, // Jose Mari Cochangco
};

function parseCsvEnv(key, fallback = '') {
  const raw = process.env[key];
  return String(raw == null ? fallback : raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Normalize a GitLab assignees array into { username, name } objects.
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
 * Returns an ordered array of { role: 'Developer'|'QA', assigneeId: number|null }.
 * assigneeId is the ClickUp member id for the person in that role, or null if the
 * role is unassigned / the person has no known ClickUp id.
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

  const assigneeIdFor = (person) =>
    person && CLICKUP_MEMBER_IDS[person.username] ? CLICKUP_MEMBER_IDS[person.username] : null;

  const rows = [{ role: 'Developer', assigneeId: assigneeIdFor(findLatest(developers)) }];

  if (qaIsRequired(labels)) {
    rows.push({ role: 'QA', assigneeId: assigneeIdFor(findLatest(qas)) });
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
 * @param {function} clickupRequest - async (method, path, body?) => data.
 * @param {string}   taskId
 * @param {Array}    gitlabAssignees - raw GitLab assignees array
 * @param {Array}    labels          - raw GitLab labels (string[] or {title}[])
 * @param {string}   status          - the ClickUp status just applied
 *
 * Rows are fixed-label items ("Developer" / "QA") whose ASSIGNEE is set to the
 * corresponding ClickUp member. Reconciled without duplicating; Developer assignee
 * frozen at/after "for release"; all rows resolved when status is a resolve status.
 *
 * Never throws — failures are caught and returned as { ok:false, error } so the
 * core sync is never broken by checklist issues.
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
      checklist = created.checklist || created;
      checklist.items = checklist.items || [];
    }

    const existingItems = checklist.items || [];

    // Match existing items to a role by exact fixed label ("Developer" / "QA").
    // Also tolerate the legacy "Developer: <name>" / "QA: <name>" text so old
    // checklists get migrated to the new label-only + assignee form.
    const roleOf = (name) => {
      if (/^Developer\b/i.test(name)) return 'Developer';
      if (/^QA\b/i.test(name)) return 'QA';
      return null;
    };

    const desiredRoles = new Set(desiredRows.map((r) => r.role));
    const currentAssigneeId = (it) => (it.assignee && it.assignee.id) || null;

    // 1) Add or update a row per desired role.
    for (const row of desiredRows) {
      const match = existingItems.find((it) => roleOf(it.name) === row.role);

      // Freeze the Developer assignee at/after "for release": preserve the
      // existing item as-is (GitLab may have reassigned to a release handler/PM).
      // A missing Developer row is still created from current data.
      if (devFrozen && row.role === 'Developer' && match) {
        // Still normalize the label to the fixed form if it's a legacy row.
        if (match.name !== row.role) {
          await clickupRequest('PUT', `/checklist/${checklist.id}/checklist_item/${match.id}`, {
            name: row.role,
          });
        }
        continue;
      }

      if (!match) {
        // Create the item with the fixed label and (optional) assignee.
        const body = { name: row.role };
        if (row.assigneeId) body.assignee = row.assigneeId;
        await clickupRequest('POST', `/checklist/${checklist.id}/checklist_item`, body);
      } else {
        // Update label to the fixed form and/or assignee if changed.
        const updates = {};
        if (match.name !== row.role) updates.name = row.role;
        if (row.assigneeId && currentAssigneeId(match) !== row.assigneeId) {
          updates.assignee = row.assigneeId;
        }
        if (Object.keys(updates).length > 0) {
          await clickupRequest(
            'PUT',
            `/checklist/${checklist.id}/checklist_item/${match.id}`,
            updates
          );
        }
      }
    }

    // 2) Remove stale rows whose role is no longer desired (e.g. QA dropped).
    for (const it of existingItems) {
      const role = roleOf(it.name);
      if (role && !desiredRoles.has(role)) {
        await clickupRequest('DELETE', `/checklist/${checklist.id}/checklist_item/${it.id}`);
      }
    }

    // 3) Resolve (check) rows based on status. Re-read to get current item ids.
    if (resolveAll) {
      const refreshed = await clickupRequest('GET', `/task/${taskId}`);
      const cl = (refreshed.checklists || []).find((c) => c.name === CHECKLIST_NAME);
      const items = (cl && cl.items) || [];
      for (const it of items) {
        if (roleOf(it.name) && !it.resolved) {
          await clickupRequest('PUT', `/checklist/${cl.id}/checklist_item/${it.id}`, {
            resolved: true,
          });
        }
      }
    }

    return {
      ok: true,
      rows: desiredRows.map((r) => `${r.role}${r.assigneeId ? ` (assignee ${r.assigneeId})` : ' (unassigned)'}`),
      resolved: resolveAll,
    };
  } catch (err) {
    console.error(`[signoff] Failed to sync checklist on task ${taskId}:`, err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  CHECKLIST_NAME,
  CLICKUP_MEMBER_IDS,
  buildSignoffRows,
  qaIsRequired,
  shouldResolveSignoff,
  developerIsFrozen,
  syncSignoffChecklist,
};
