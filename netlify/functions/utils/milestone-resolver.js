/**
 * Milestone_Resolver — turns a GitLab `milestone_id` into a milestone name.
 *
 * Used on the webhook path, where the GitLab issue event payload exposes only
 * `object_attributes.milestone_id` and no milestone name. Each factory instance
 * holds its own cache that lives for the lifetime of a single function
 * invocation and is discarded when that invocation ends.
 *
 * Lookup contract (Req 4.2, 4.3, 4.4, 4.6):
 *   - GET {gitlabUrl}/api/v4/projects/{projectId}/milestones/{milestoneId}
 *     with header `PRIVATE-TOKEN: token`.
 *   - 10-second per-attempt timeout via AbortController.
 *   - Exactly one retry on timeout or connection failure (2 attempts total).
 *   - Resolve to `null` (and cache it) on HTTP >= 400, both attempts failing,
 *     or an absent/empty `title` after trim.
 *   - Cache hits issue no request. `null` outcomes are cached too, so a
 *     known-bad ID is not re-fetched within the same invocation.
 */

const REQUEST_TIMEOUT_MS = 10000;

/**
 * Create an invocation-scoped milestone resolver with its own cache.
 *
 * @param {object} opts
 * @param {string} opts.gitlabUrl   Base GitLab URL (e.g. https://gitlab.com).
 * @param {string} opts.token       GitLab personal/project access token.
 * @param {string|number} opts.projectId  GitLab project ID.
 * @param {Function} [opts.fetchImpl]     Fetch implementation (defaults to global fetch).
 * @returns {{ resolveName: (milestoneId: string|number) => Promise<string|null> }}
 */
function createMilestoneResolver({ gitlabUrl, token, projectId, fetchImpl = fetch }) {
  // milestoneId(string) -> name(string) | null
  const cache = new Map();

  /**
   * Perform a single GitLab milestones API request with a 10s timeout.
   * Resolves to the Response, or throws on timeout/connection failure.
   */
  async function attemptFetch(milestoneId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const url = `${gitlabUrl}/api/v4/projects/${projectId}/milestones/${milestoneId}`;
      return await fetchImpl(url, {
        headers: { 'PRIVATE-TOKEN': token },
        signal: controller.signal,
      });
    } finally {
      // Always clear the timeout timer.
      clearTimeout(timer);
    }
  }

  /**
   * Resolve a milestone ID to its name, or null when unresolvable.
   */
  async function resolveName(milestoneId) {
    const key = String(milestoneId);
    if (cache.has(key)) {
      return cache.get(key);
    }

    let res = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await attemptFetch(milestoneId);
        break; // got a response (success or error status) — stop retrying
      } catch (e) {
        // Timeout (AbortError) or connection failure. Retry exactly once.
        res = null;
      }
    }

    // Both attempts failed/timed out, or the server returned an error status.
    if (!res || res.status >= 400) {
      cache.set(key, null);
      return null;
    }

    let title = null;
    try {
      const data = await res.json();
      title = data && typeof data.title === 'string' ? data.title.trim() : '';
    } catch (e) {
      title = '';
    }

    if (!title) {
      cache.set(key, null);
      return null;
    }

    cache.set(key, title);
    return title;
  }

  return { resolveName };
}

module.exports = { createMilestoneResolver };
