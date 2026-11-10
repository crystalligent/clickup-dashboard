/**
 * "ticket dates" checklist helper.
 *
 * Maintains a ClickUp checklist named "ticket dates" on each synced task with up
 * to three rows:
 *   created_at: <date>      - the GitLab issue's own created_at (refreshed in place)
 *   for_release_at: <date>  - sync time when the "For Release" label (or a status
 *                             at/after "for release") was FIRST observed. Frozen.
 *   released_at: <date>     - sync time when the "Released" label was FIRST
 *                             observed. Frozen.
 *
 * GitLab does not expose when a label was added, so the two release dates are the
 * sync's own observation time. Once written they are never rewritten, even if the
 * label is later removed.
 *
 * A checklist is used instead of ClickUp custom fields because the Free plan caps
 * custom fields at 60 lifetime uses.
 *
 * Mirrors syncSignoffChecklist in ./signoff.js: reads the task, finds/creates the
 * checklist, reconciles items, and NEVER throws (returns { ok:false, error }).
 */

const CHECKLIST_NAME = 'ticket dates';

const FIELDS = ['created_at', 'for_release_at', 'released_at'];
const FROZEN_FIELDS = ['for_release_at', 'released_at'];

const FOR_RELEASE_LABEL = 'For Release';
const RELEASED_LABEL = 'Released';

// ClickUp statuses at or after "for release" (see getExpectedStatus / STATUS_LADDER).
const FOR_RELEASE_OR_LATER_STATUSES = ['for release', 'released to prod'];

const pad = (n, width = 2) => String(n).padStart(width, '0');

/**
 * Format a date value as "YYYY-MM-DD HH:mm:ss UTC".
 * Accepts an ISO 8601 string, GitLab webhook style "2024-03-07 14:05:09 UTC",
 * epoch milliseconds, or a Date. Returns null for missing/empty/unparseable input.
 */
function formatDateUtc(value) {
  if (value === null || value === undefined || value === '') return null;

  let d = value instanceof Date ? new Date(value.getTime()) : new Date(value);

  // Fallback for "YYYY-MM-DD HH:mm:ss UTC" / "YYYY-MM-DD HH:mm:ss +0800" forms.
  if (Number.isNaN(d.getTime()) && typeof value === 'string') {
    const normalized = value
      .trim()
      .replace(' ', 'T')
      .replace(/\s*UTC$/i, 'Z')
      .replace(/\s*([+-]\d{2}):?(\d{2})$/, '$1:$2');
    d = new Date(normalized);
  }

  if (Number.isNaN(d.getTime())) return null;

  return (
    `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
  );
}

/**
 * Normalize labels (webhook uses [{title}], REST uses ["title"]) to lowercase titles.
 */
function labelTitlesLower(labels) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((l) => (typeof l === 'string' ? l : l && l.title))
    .filter((t) => typeof t === 'string' && t.length > 0)
    .map((t) => t.trim().toLowerCase());
}

function hasLabelCI(labels, title) {
  return labelTitlesLower(labels).includes(String(title).trim().toLowerCase());
}

/** Returns the date field a checklist item text belongs to, or null. */
function fieldOf(itemText) {
  if (typeof itemText !== 'string') return null;
  const text = itemText.trim();
  return FIELDS.find((f) => text.startsWith(`${f}:`)) || null;
}

function isFrozenField(field) {
  return FROZEN_FIELDS.includes(field);
}

/** Text after "field:" trimmed, e.g. "2024-03-07 14:05:09 UTC". */
function itemValue(itemText) {
  if (typeof itemText !== 'string') return '';
  const idx = itemText.indexOf(':');
  return idx === -1 ? '' : itemText.slice(idx + 1).trim();
}

function itemText(field, date) {
  return `${field}: ${date}`;
}

function isForReleaseOrLater(status) {
  if (!status) return false;
  return FOR_RELEASE_OR_LATER_STATUSES.includes(String(status).trim().toLowerCase());
}

/**
 * Group checklist items by field. For each field keep one item (for frozen fields
 * prefer the first one with a value, so a recorded date is never the one deleted)
 * and list the rest as duplicates.
 */
function groupItems(items) {
  const byField = {};
  for (const f of FIELDS) byField[f] = [];
  for (const it of items || []) {
    const f = fieldOf(it && it.name);
    if (f) byField[f].push(it);
  }

  const kept = {};
  const duplicates = [];
  for (const f of FIELDS) {
    const list = byField[f];
    if (list.length === 0) {
      kept[f] = null;
      continue;
    }
    const keep = list.find((it) => itemValue(it.name) !== '') || list[0];
    kept[f] = keep;
    for (const it of list) if (it !== keep) duplicates.push(it);
  }
  return { kept, duplicates };
}

/**
 * Reconcile the "ticket dates" checklist on a task.
 *
 * @param {function} clickupRequest - async (method, path, body?) => data
 * @param {string}   taskId
 * @param {object}   issue  - GitLab issue (or queued item); reads created_at, labels
 * @param {string}   status - the ClickUp status just applied by the core sync
 * @param {object}   [options]
 * @param {Date}     [options.now] - observation time (defaults to new Date())
 *
 * Never throws. Returns { ok:true, checklistId, items, wrote, warnings } or
 * { ok:false, error }.
 */
async function syncTicketDatesChecklist(clickupRequest, taskId, issue, status, options = {}) {
  try {
    const observedAt = formatDateUtc(options.now || new Date());
    const labels = (issue && issue.labels) || [];
    const wrote = [];
    const warnings = [];

    // 1) Read the task before any mutation.
    const task = await clickupRequest('GET', `/task/${taskId}`);
    const checklists = (task && task.checklists) || [];

    // 2) Find (first match) or create the checklist.
    let checklist = checklists.find((c) => c && typeof c.name === 'string' && c.name.trim() === CHECKLIST_NAME);
    if (!checklist) {
      const created = await clickupRequest('POST', `/task/${taskId}/checklist`, { name: CHECKLIST_NAME });
      checklist = (created && created.checklist) || created;
      checklist.items = checklist.items || [];
      wrote.push('checklist');
    }
    const checklistId = checklist.id;
    const itemPath = (id) => `/checklist/${checklistId}/checklist_item${id ? `/${id}` : ''}`;

    // 3) Dedupe: one item per field.
    const { kept, duplicates } = groupItems(checklist.items);
    for (const dup of duplicates) {
      await clickupRequest('DELETE', itemPath(dup.id));
      wrote.push(`delete:${fieldOf(dup.name)}`);
    }

    const result = {
      created_at: kept.created_at ? itemValue(kept.created_at.name) || null : null,
      for_release_at: kept.for_release_at ? itemValue(kept.for_release_at.name) || null : null,
      released_at: kept.released_at ? itemValue(kept.released_at.name) || null : null,
    };

    // 4) created_at: add, or update in place when the value differs.
    const createdAt = formatDateUtc(issue && issue.created_at);
    if (!createdAt) {
      warnings.push(`created_at missing or unparseable: ${JSON.stringify(issue && issue.created_at)}`);
    } else if (!kept.created_at) {
      await clickupRequest('POST', itemPath(), { name: itemText('created_at', createdAt) });
      result.created_at = createdAt;
      wrote.push('created_at');
    } else if (itemValue(kept.created_at.name) !== createdAt) {
      await clickupRequest('PUT', itemPath(kept.created_at.id), { name: itemText('created_at', createdAt) });
      result.created_at = createdAt;
      wrote.push('created_at');
    }

    // 5/6) Frozen fields: write once on first observation, never touch afterwards.
    const shouldRecord = {
      for_release_at: hasLabelCI(labels, FOR_RELEASE_LABEL) || isForReleaseOrLater(status),
      released_at: hasLabelCI(labels, RELEASED_LABEL),
    };

    for (const field of FROZEN_FIELDS) {
      const existing = kept[field];
      if (existing && itemValue(existing.name) !== '') continue; // frozen
      if (!shouldRecord[field]) continue;

      const body = { name: itemText(field, observedAt) };
      if (existing) {
        // An empty "field:" row exists; fill it instead of adding a duplicate.
        await clickupRequest('PUT', itemPath(existing.id), body);
      } else {
        await clickupRequest('POST', itemPath(), body);
      }
      result[field] = observedAt;
      wrote.push(field);
    }

    return { ok: true, checklistId, items: result, wrote, warnings };
  } catch (err) {
    console.error(`[ticket-dates] Failed to sync checklist on task ${taskId}:`, err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  CHECKLIST_NAME,
  formatDateUtc,
  labelTitlesLower,
  hasLabelCI,
  fieldOf,
  isFrozenField,
  itemValue,
  syncTicketDatesChecklist,
};
