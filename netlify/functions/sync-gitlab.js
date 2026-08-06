/**
 * Scheduled GitLab Issue Fetcher (every 30 minutes)
 * 
 * Fetches recently updated issues from GitLab and adds them to the sync queue.
 * Does NOT write to ClickUp — that's handled by process-queue.
 * 
 * Schedule: Every 30 minutes
 */

const { enqueue, getLastSyncTime, saveLastSyncTime } = require('./utils/queue');
const { logRun } = require('./utils/logger');

function getEnv(key, fallback) {
  const val = process.env[key];
  if (!val && fallback === undefined) throw new Error(`Missing: ${key}`);
  return val || fallback;
}

function jsonResponse(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function getIssuesByMilestone(milestoneName, since) {
  const gitlabUrl = getEnv('GITLAB_URL');
  const token = getEnv('GITLAB_TOKEN');
  const projectId = getEnv('GITLAB_PROJECT_ID');

  let allIssues = [];
  let page = 1;

  while (true) {
    let url = `${gitlabUrl}/api/v4/projects/${projectId}/issues?milestone=${encodeURIComponent(milestoneName)}&per_page=100&page=${page}`;
    if (since) url += `&updated_after=${since.toISOString()}`;

    const res = await fetch(url, { headers: { 'PRIVATE-TOKEN': token } });
    if (!res.ok) {
      console.error(`GitLab error (${milestoneName} p${page}): ${res.status}`);
      break;
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
  console.log(`[sync-gitlab] Fetching issues at ${new Date().toISOString()}`);

  try {
    const milestoneNames = getEnv('GITLAB_MILESTONES', 'For Development,For Review,Ongoing')
      .split(',').map((m) => m.trim()).filter(Boolean);

    const bufferDays = parseInt(getEnv('SYNC_BUFFER_DAYS', '2'), 10);
    const lastSync = await getLastSyncTime();
    let since = null;

    if (lastSync) {
      since = new Date(lastSync.getTime() - bufferDays * 24 * 60 * 60 * 1000);
      console.log(`[sync-gitlab] Since: ${since.toISOString()}`);
    } else {
      since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      console.log(`[sync-gitlab] First run, 3-day lookback`);
    }

    let allIssues = [];
    for (const milestone of milestoneNames) {
      const issues = await getIssuesByMilestone(milestone, since);
      console.log(`[sync-gitlab] "${milestone}": ${issues.length} issues`);
      allIssues = allIssues.concat(issues);
    }

    // Deduplicate by IID
    const seen = new Set();
    const unique = allIssues.filter((i) => { if (seen.has(i.iid)) return false; seen.add(i.iid); return true; });

    // Add to queue
    const queueSize = await enqueue(unique);
    await saveLastSyncTime(new Date());

    console.log(`[sync-gitlab] Queued ${unique.length} issues. Queue size: ${queueSize}`);

    return jsonResponse(200, { fetched: unique.length, queueSize });
  } catch (err) {
    console.error('[sync-gitlab] Error:', err.message);
    return jsonResponse(500, { error: err.message });
  }
};
