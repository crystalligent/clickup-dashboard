/**
 * Status_Resolver — pure module (no I/O) that determines the target ClickUp
 * status for a GitLab issue.
 *
 * This module is shared by all four sync paths (gitlab-webhook, sync-single,
 * process-queue, run-queue) so that status resolution lives in exactly one
 * place. It owns the Milestone_Status_Map, the normalization rules, the label
 * rules, the tag rules, and the precedence (closed > milestone > label).
 *
 * NOTE: This file is built up across tasks 2.1–2.3. Task 2.1 adds the
 * Milestone_Status_Map, normalization, and getMilestoneStatus. Tasks 2.2 and
 * 2.3 will add getLabelStatus, getExpectedTags, hasLabel, and resolveStatus,
 * and will extend module.exports accordingly.
 */

// ─── Status origin values (for observability) ──────────────────────────────────

const STATUS_ORIGIN = {
  MILESTONE: 'milestone',
  LABEL: 'label',
  NONE: 'none',
};

// ─── Milestone_Status_Map ───────────────────────────────────────────────────────

/**
 * Ordered list of { milestone, status } pairs. An array (not a plain object) is
 * used so that configured order is well-defined: this gives match-order
 * determinism and a first-wins outcome when two keys normalize to the same
 * value (Req 2.9). Order is significant.
 */
const MILESTONE_STATUS_MAP = [
  { milestone: '2026 Review - For QA Verification', status: '2026 Review - QA' },
  { milestone: '2026 Review - For Dev Verification', status: '2026 Review - Dev' },
];

// Maximum milestone-name length considered for a match (Req 1.8).
const MAX_MILESTONE_LENGTH = 255;

// ─── Normalization ──────────────────────────────────────────────────────────────

/**
 * Normalize a milestone name/key for comparison:
 * trim, collapse each run of internal whitespace to a single space, lowercase.
 *
 * @param {string} name
 * @returns {string}
 */
function normalizeMilestone(name) {
  if (typeof name !== 'string') return '';
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

// ─── Milestone-derived status ─────────────────────────────────────────────────

/**
 * Milestone-derived status via the Milestone_Status_Map.
 *
 * Returns null for absent/empty/over-255-char names, when the map is not a
 * usable array, or when the normalized name matches no map key. Otherwise
 * iterates the map in configured order and returns the status of the first
 * entry whose normalized key equals the normalized input (first-wins).
 *
 * @param {string} milestoneName
 * @returns {string | null}
 */
function getMilestoneStatus(milestoneName) {
  // Absent / empty / over-length names never match (Req 1.8).
  if (typeof milestoneName !== 'string') return null;
  if (milestoneName.trim() === '') return null;
  if (milestoneName.length > MAX_MILESTONE_LENGTH) return null;

  // Guard against a non-array or empty map (Req 2.8).
  if (!Array.isArray(MILESTONE_STATUS_MAP) || MILESTONE_STATUS_MAP.length === 0) {
    return null;
  }

  const normalizedInput = normalizeMilestone(milestoneName);

  for (const entry of MILESTONE_STATUS_MAP) {
    if (!entry || typeof entry.milestone !== 'string') continue;
    if (normalizeMilestone(entry.milestone) === normalizedInput) {
      return entry.status;
    }
  }

  return null;
}

// ─── Label matching ─────────────────────────────────────────────────────────

/**
 * Tolerant label matcher. Accepts a labels array whose entries may be either
 * raw strings or GitLab-style `{ title }` objects, and reports whether any
 * entry matches the given title exactly.
 *
 * @param {Array<string | { title: string }>} labels
 * @param {string} title
 * @returns {boolean}
 */
function hasLabel(labels, title) {
  return labels.some((l) => (typeof l === 'string' ? l : l.title) === title);
}

// ─── Label-derived status ─────────────────────────────────────────────────────

/**
 * Label-derived status: the canonical merge of the four former getExpectedStatus
 * copies, using the webhook ordering (`For Testing` before
 * `For Deployment to Hotfix`). A closed issue always resolves to 'Closed'.
 * Returns null when no rule matches.
 *
 * @param {Array<string | { title: string }>} labels
 * @param {string} issueState
 * @returns {string | null}
 */
function getLabelStatus(labels, issueState) {
  if (issueState === 'closed') return 'Closed';
  if (hasLabel(labels, 'RESOLVED - NO CODE CHANGES')) return 'resolved - no code changes';
  if (hasLabel(labels, 'Released')) return 'released to prod';
  if (hasLabel(labels, 'For Release')) return 'for release';
  if (hasLabel(labels, 'Done') || hasLabel(labels, 'Done Development')) return 'done development';
  if (hasLabel(labels, 'For Testing')) return 'for testing in hotfix';
  if (hasLabel(labels, 'For Deployment to Hotfix')) return 'for deployment to hotfix';
  if (hasLabel(labels, 'On-Going Testing')) return 'ongoing testing';
  if (hasLabel(labels, 'On-Going Development')) return 'ongoing dev';
  if (hasLabel(labels, 'Escalated to Dev')) return 'testing: failed';
  return null;
}

// ─── Tag rules ──────────────────────────────────────────────────────────────

/**
 * Derive the expected ClickUp tags from GitLab labels. Ported verbatim from the
 * existing sync paths.
 *
 * @param {Array<string | { title: string }>} labels
 * @returns {string[]}
 */
function getExpectedTags(labels) {
  const tags = [];
  if (hasLabel(labels, 'Data Correction')) tags.push('data correction');
  if (hasLabel(labels, 'Enhancement')) tags.push('enhancement');
  if (hasLabel(labels, 'Lynexus')) tags.push('lynexus');
  if (hasLabel(labels, 'Internal Enhancement')) tags.push('internal enhancement');
  if (hasLabel(labels, 'openAPI')) tags.push('openapi');
  if (hasLabel(labels, 'Chargeable')) tags.push('chargeable');
  if (hasLabel(labels, 'For Investigation')) tags.push('for investigation');
  return tags;
}

// ─── Status resolution entry point ────────────────────────────────────────────

/**
 * The single entry point used by all sync paths. Resolves the Target_Status for
 * a GitLab issue and reports its origin for observability.
 *
 * Precedence: closed > milestone > label.
 *   1. Closed state → { status: 'Closed', origin: LABEL } (closed is the first
 *      line of the former getExpectedStatus copies, so its origin is LABEL).
 *   2. Milestone_Status_Map match → { status, origin: MILESTONE }.
 *   3. Label rule match → { status, origin: LABEL }.
 *   4. Otherwise → { status: null, origin: NONE }.
 *
 * @param {string} milestoneName
 * @param {Array<string | { title: string }>} labels
 * @param {string} issueState
 * @returns {{ status: string | null, origin: string }}
 */
function resolveStatus(milestoneName, labels, issueState) {
  if (issueState === 'closed') return { status: 'Closed', origin: STATUS_ORIGIN.LABEL };

  const m = getMilestoneStatus(milestoneName);
  if (m !== null) return { status: m, origin: STATUS_ORIGIN.MILESTONE };

  const l = getLabelStatus(labels, issueState);
  if (l !== null) return { status: l, origin: STATUS_ORIGIN.LABEL };

  return { status: null, origin: STATUS_ORIGIN.NONE };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  MILESTONE_STATUS_MAP,
  normalizeMilestone,
  getLabelStatus,
  getExpectedTags,
  getMilestoneStatus,
  resolveStatus,
  hasLabel,
  STATUS_ORIGIN,
};
