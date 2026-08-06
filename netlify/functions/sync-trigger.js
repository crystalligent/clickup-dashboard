/**
 * Manual Sync Trigger — Fetches issues from GitLab and adds to the queue.
 * 
 * GET /.netlify/functions/sync-trigger            → incremental (since last sync)
 * GET /.netlify/functions/sync-trigger?full=true  → all open issues (no date filter)
 * GET /.netlify/functions/sync-trigger?since=YYYY-MM-DD → from specific date
 * GET /.netlify/functions/sync-trigger?verify=true → auth check only
 * 
 * Issues are queued and processed by process-queue (every 5 min).
 */

const { enqueue, getQueueSize, getLastSyncTime, saveLastSyncTime } = require('./utils/queue');

function getEnv(key, fallback) {
  const val = process.env[key];
  if (!val && fallback === undefined) throw new Error(`Missing: ${key}`);
  return val || fallback;
}

function jsonResponse(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function getIssuesByMilestone(milestoneName, since, { useCreatedAfter = false } = {}) {
  const gitlabUrl = getEnv('GITLAB_URL');
  const token = getEnv('GITLAB_TOKEN');
  const projectId = getEnv('GITLAB_PROJECT_ID');

  let allIssues = [];
  let page = 1;

  while (true) {
    let url = `${gitlabUrl}/api/v4/projects/${projectId}/issues?milestone=${encodeURIComponent(milestoneName)}&per_page=100&page=${page}`;
    if (since) {
      const param = useCreatedAfter ? 'created_after' : 'updated_after';
      url += `&${param}=${since.toISOString()}`;
    }

    const res = await fetch(url, { headers: { 'PRIVATE-TOKEN': token } });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`GitLab ${res.status}: ${errText}`);
    }

    const issues = await res.json();
    allIssues = allIssues.concat(issues);
    if (issues.length < 100) break;
    page++;
    if (page > 20) break;
  }

  return allIssues;
}

exports.handler = async (event) => {
  // ─── Password protection ───
  const requiredPassword = process.env.LOGS_PASSWORD;
  if (requiredPassword) {
    const provided = event.headers['x-sync-password'] || '';
    if (provided !== requiredPassword) {
      return jsonResponse(401, { error: 'Unauthorized' });
    }
    if (event.queryStringParameters?.verify === 'true') {
      return jsonResponse(200, { authenticated: true });
    }
  }

  console.log(`[sync-trigger] Manual trigger at ${new Date().toISOString()}`);

  try {
    const milestoneNames = getEnv('GITLAB_MILESTONES', 'For Development,For Review,Ongoing')
      .split(',').map((m) => m.trim()).filter(Boolean);

    // Determine lookback
    const bufferDays = parseInt(getEnv('SYNC_BUFFER_DAYS', '2'), 10);
    const lastSync = await getLastSyncTime();
    let since = null;

    const isFullSync = event.queryStringParameters?.full === 'true';
    const sinceParam = event.queryStringParameters?.since || '';

    if (isFullSync) {
      since = null;
      console.log('[sync-trigger] Full sync — no date filter');
    } else if (sinceParam) {
      since = new Date(sinceParam + 'T00:00:00.000Z');
      console.log(`[sync-trigger] Sync from date: ${since.toISOString()}`);
    } else if (lastSync) {
      since = new Date(lastSync.getTime() - bufferDays * 24 * 60 * 60 * 1000);
      console.log(`[sync-trigger] Incremental since: ${since.toISOString()}`);
    } else {
      since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      console.log('[sync-trigger] First run, 3-day lookback');
    }

    const useCreatedAfter = !!sinceParam;

    // Fetch issues from GitLab
    let allIssues = [];
    for (const milestone of milestoneNames) {
      const issues = await getIssuesByMilestone(milestone, since, { useCreatedAfter });
      console.log(`[sync-trigger] "${milestone}": ${issues.length} issues`);
      allIssues = allIssues.concat(issues);
    }

    // Deduplicate
    const seen = new Set();
    const unique = allIssues.filter((i) => { if (seen.has(i.iid)) return false; seen.add(i.iid); return true; });

    // Prepare queue items
    const queueItems = unique.map((issue) => ({
      iid: issue.iid,
      title: issue.title,
      web_url: issue.web_url,
      description: issue.description || '',
      state: issue.state || 'opened',
      milestone_id: issue.milestone ? String(issue.milestone.id) : '',
      milestone_name: issue.milestone ? issue.milestone.title : '',
      labels: issue.labels || [],
      assignees: (issue.assignees || []).map((a) => ({ username: a.username, name: a.name })),
      added_at: new Date().toISOString(),
    }));

    // Write to queue via HTTP POST to queue-status (ensures Blobs context works)
    const siteUrl = process.env.URL || '';
    let queueSize = 0;

    if (siteUrl) {
      try {
        const res = await fetch(`${siteUrl}/.netlify/functions/queue-status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Sync-Password': process.env.LOGS_PASSWORD || '' },
          body: JSON.stringify({ issues: queueItems }),
        });
        const data = await res.json();
        queueSize = data.queueSize || 0;
      } catch (e) {
        console.log(`[sync-trigger] HTTP queue write failed: ${e.message}, trying direct`);
        queueSize = await enqueue(unique);
      }
    } else {
      queueSize = await enqueue(unique);
    }

    await saveLastSyncTime(new Date());
    console.log(`[sync-trigger] Queued ${unique.length} issues. Total queue: ${queueSize}`);

    return jsonResponse(200, {
      queued: unique.length,
      queueSize,
      since: since ? since.toISOString() : null,
      message: `${unique.length} issues added to queue. Processing every 5 minutes (batch of 5).`,
    });
  } catch (err) {
    console.error('[sync-trigger] Error:', err.message);
    return jsonResponse(500, { error: err.message });
  }
};
