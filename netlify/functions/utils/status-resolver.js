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

// ─── Exports ──────────────────────────────────────────────────────────────────
// Tasks 2.2 and 2.3 extend this surface with getLabelStatus, getExpectedTags,
// hasLabel, and resolveStatus.

module.exports = {
  MILESTONE_STATUS_MAP,
  normalizeMilestone,
  getMilestoneStatus,
  STATUS_ORIGIN,
};
