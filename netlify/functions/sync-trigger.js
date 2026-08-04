/**
 * Manual Sync Trigger — HTTP-accessible wrapper for the sync logic.
 * 
 * Netlify blocks HTTP access to scheduled functions in production,
 * so this function exists as a regular (non-scheduled) endpoint for
 * manual and "Sync All" triggers from the UI.
 * 
 * GET /.netlify/functions/sync-trigger         → incremental sync (since last run)
 * GET /.netlify/functions/sync-trigger?full=true → full sync (all open issues)
 */

const { logRun } = require('./utils/logger');
const fs = require('fs');
const path = require('path');

const CLICKUP_API = 'https://api.clickup.com/api/v2';
const LAST_SYNC_FILE = path.join('/tmp', 'gitlab-sync-last-run.json');

// ─── Helpers ───────────────────────────────────────────────────────────────────

function getEnv(key, fallback) {
  const val = process.env[key];
  if (!val && fallback === undefined) {
    throw new Error(`Missing required env variable: ${key}`);
  }
  return val || fallback;
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// ─── Last Sync Timestamp ───────────────────────────────────────────────────────

async function getLastSyncTime() {
  try {
    const { getStore } = require('@netlify/blobs');
    const store = getStore('sync-meta');
    const data = await store.get('last-sync', { type: 'json' });
    if (data?.timestamp) return new Date(data.timestamp);
  } catch (e) { /* blobs not available */ }

  try {
    if (fs.existsSync(LAST_SYNC_FILE)) {
      const data = JSON.parse(fs.readFileSync(LAST_SYNC_FILE, 'utf8'));
      if (data?.timestamp) return new Date(data.timestamp);
    }
  } catch (e) { /* ignore */ }

  return null;
}

async function saveLastSyncTime(timestamp) {
  const data = { timestamp: timestamp.toISOString() };

  try {
    const { getStore } = require('@netlify/blobs');
    const store = getStore('sync-meta');
    await store.setJSON('last-sync', data);
  } catch (e) { /* blobs not available */ }

  try {
    fs.writeFileSync(LAST_SYNC_FILE, JSON.stringify(data), 'utf8');
  } catch (e) { /* ignore */ }
}

// ─── ClickUp API ───────────────────────────────────────────────────────────────

async function clickupRequest(method, apiPath, body) {
  const apiKey = getEnv('CLICKUP_KEY');

  const options = {
    method,
    headers: {
      'Authorization': apiKey,
      'Content-Type': 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${CLICKUP_API}${apiPath}`, options);
  const data = await res.json();

  if (!res.ok) {
    console.error(`ClickUp API error [${method} ${apiPath}]:`, res.status, data);
    throw new Error(`ClickUp API ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function getExistingTaskMap() {
  const listId = getEnv('CLICKUP_LIST_ID');
  const taskMap = new Map();

  let page = 0;
  while (true) {
    const apiPath = `/list/${listId}/task?page=${page}&subtasks=true&include_closed=true`;
    const data = await clickupRequest('GET', apiPath);
    const tasks = data.tasks || [];

    for (const task of tasks) {
      const match = task.name.match(/^(\d+)\s*-\s*/);
      if (match) {
        taskMap.set(match[1], { id: task.id, name: task.name, status: task.status?.status });
      }
    }

    if (tasks.length < 100) break;
    page++;
    if (page > 50) break;
  }

  return taskMap;
}

// ─── GitLab API ────────────────────────────────────────────────────────────────

async function getIssuesByMilestone(milestoneName, since, { useCreatedAfter = false } = {}) {
  const gitlabUrl = getEnv('GITLAB_URL');
  const token = getEnv('GITLAB_TOKEN');
  const projectId = getEnv('GITLAB_PROJECT_ID');

  let allIssues = [];
  let page = 1;

  while (true) {
    let url = `${gitlabUrl}/api/v4/projects/${projectId}/issues?milestone=${encodeURIComponent(milestoneName)}&per_page=100&page=${page}`;

    if (since) {
      const filterParam = useCreatedAfter ? 'created_after' : 'updated_after';
      url += `&${filterParam}=${since.toISOString()}`;
    }

    const res = await fetch(url, {
      headers: { 'PRIVATE-TOKEN': token },
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`GitLab API ${res.status}: ${errText}`);
    }

    const issues = await res.json();
    allIssues = allIssues.concat(issues);

    if (issues.length < 100) break;
    page++;
    if (page > 20) break;
  }

  return allIssues;
}

// ─── Assignee Mapping (GitLab username → ClickUp member ID) ────────────────────

const ASSIGNEE_MAP = {
  'agregorio': 89084186,    // Anriette Chyle Gregorio → AC Gregorio
  'atacipit': 100808559,    // Arvin Tacipit
  'bviloria': 3798865,      // Ben Viloria
  'cdimalanta': 270739823,  // Crystal Grace Dimalanta
  'dcomia': 95085613,       // Diana Rose Comia
  'emonding': 100842272,    // EJ Monding → Emil John Monding
  'jsacay': 94935510,       // Jan Marzeus Sacay
  'jgregorio': 89079122,    // Jomar Gregorio
  'mtanqueco': 3827858,     // Mikee Dorina Tanqueco
  'pcabalo': 89084187,      // Phillip Val Cabalo
  'rmendoza': 276899809,    // Ryzell Rowayne Mendoza → Wayne Mendoza
};

function getClickUpAssignees(gitlabAssignees) {
  if (!gitlabAssignees || gitlabAssignees.length === 0) return [];
  return gitlabAssignees
    .map((a) => ASSIGNEE_MAP[a.username])
    .filter(Boolean);
}

// ─── Label Detection ───────────────────────────────────────────────────────────

function hasLabel(labels, title) {
  return labels.some((l) => l.title === title);
}

/**
 * Determine the ClickUp status based on GitLab labels.
 * Priority order (first match wins):
 */
function getExpectedStatus(labels, issueState) {
  // Closed GitLab issue → closed in ClickUp
  if (issueState === 'closed') return 'Closed';

  if (hasLabel(labels, 'Released')) return 'released to prod';
  if (hasLabel(labels, 'For Release')) return 'for release';
  if (hasLabel(labels, 'Done') || hasLabel(labels, 'Done Development')) return 'done development';
  if (hasLabel(labels, 'For Testing')) return 'for testing in hotfix';
  if (hasLabel(labels, 'On-Going Testing')) return 'ongoing testing';
  if (hasLabel(labels, 'On-Going Development')) return 'ongoing dev';
  if (hasLabel(labels, 'Escalated to Dev')) return 'testing: failed';

  return null; // no label-based status change
}

/**
 * Determine tags to add to the ClickUp task based on GitLab labels.
 */
function getExpectedTags(labels) {
  const tags = [];
  if (hasLabel(labels, 'Data Correction')) tags.push('data correction');
  return tags;
}

// ─── Sync Logic ────────────────────────────────────────────────────────────────

async function syncIssue(issue, existingTaskMap) {
  const startTime = Date.now();
  const iidStr = String(issue.iid);
  const labels = (issue.labels || []).map((title) => ({ title }));
  const taskName = `${issue.iid} - ${issue.title} : ${issue.web_url}`;
  const milestoneId = issue.milestone ? String(issue.milestone.id) : '';
  const milestoneName = issue.milestone ? issue.milestone.title : '';
  const issueState = issue.state || 'opened';

  const expectedStatus = getExpectedStatus(labels, issueState);
  const expectedTags = getExpectedTags(labels);
  const clickupAssignees = getClickUpAssignees(issue.assignees || []);

  const existing = existingTaskMap.get(iidStr);

  if (existing) {
    const taskId = existing.id;

    // Build update payload — only include fields that changed
    const updates = {};
    if (existing.name !== taskName) updates.name = taskName;
    if (expectedStatus && existing.status !== expectedStatus) updates.status = expectedStatus;

    // Sync assignees
    if (clickupAssignees.length > 0) {
      updates.assignees = { add: clickupAssignees };
    }

    // Add tags if needed (ClickUp API: POST /task/{id}/tag/{tag_name})
    let tagsAdded = [];
    for (const tag of expectedTags) {
      try {
        await clickupRequest('POST', `/task/${taskId}/tag/${encodeURIComponent(tag)}`, {});
        tagsAdded.push(tag);
      } catch (e) {
        // Tag might already exist — ignore errors
      }
    }

    if (Object.keys(updates).length > 0 || tagsAdded.length > 0) {
      if (Object.keys(updates).length > 0) {
        await clickupRequest('PUT', `/task/${taskId}`, updates);
      }
      const statusNote = updates.status || (tagsAdded.length > 0 ? `tags: ${tagsAdded.join(', ')}` : 'name update only');
      await logRun({
        source: 'manual', action: 'updated', status: 'success',
        duration: Date.now() - startTime,
        issueIid: issue.iid, issueTitle: issue.title,
        clickupTaskId: taskId, clickupStatus: statusNote,
        milestone: milestoneName, labels: labels.map((l) => l.title),
      });
      return { iid: issue.iid, action: 'updated', status: statusNote };
    }

    return { iid: issue.iid, skipped: true, reason: 'already exists, no changes' };
  }

  // ─── Task doesn't exist: create it ───
  const qaMilestoneId = getEnv('QA_MILESTONE_ID', '756');
  const defaultAssignee = process.env.DEFAULT_ASSIGNEE_ID;
  const listId = getEnv('CLICKUP_LIST_ID');

  // Determine status: label-based first, then milestone fallback
  let status = expectedStatus || 'Open';
  let assigneeIds = clickupAssignees.length > 0 ? clickupAssignees : [];

  if (!expectedStatus && milestoneId === qaMilestoneId) {
    status = 'pending review (qa)';
    if (assigneeIds.length === 0 && defaultAssignee) {
      assigneeIds = [parseInt(defaultAssignee, 10)];
    }
  }

  const newTask = await clickupRequest('POST', `/list/${listId}/task`, {
    name: taskName,
    description: issue.description || '',
    status,
    assignees: assigneeIds,
    tags: expectedTags,
  });

  await logRun({
    source: 'manual', action: 'created', status: 'success',
    duration: Date.now() - startTime,
    issueIid: issue.iid, issueTitle: issue.title,
    clickupTaskId: newTask.id, clickupStatus: status,
    milestone: milestoneName, labels: labels.map((l) => l.title),
  });

  return { iid: issue.iid, action: 'created', taskId: newTask.id, status };
}

// ─── Handler ───────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  // ─── Password protection ───
  const requiredPassword = process.env.LOGS_PASSWORD;
  if (requiredPassword) {
    const provided = event.headers['x-sync-password'] || '';
    const isVerifyOnly = event.queryStringParameters?.verify === 'true';

    if (provided !== requiredPassword) {
      return jsonResponse(401, { error: 'Unauthorized' });
    }

    // If just verifying auth, return OK without running sync
    if (isVerifyOnly) {
      return jsonResponse(200, { authenticated: true });
    }
  }

  console.log(`[sync-trigger] Manual trigger at ${new Date().toISOString()}`);

  try {
    const milestoneNames = getEnv('GITLAB_MILESTONES', 'For review,Ongoing')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);

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
      // User-specified date (format: YYYY-MM-DD)
      since = new Date(sinceParam + 'T00:00:00.000Z');
      console.log(`[sync-trigger] Sync from user-specified date: ${since.toISOString()}`);
    } else if (lastSync) {
      since = new Date(lastSync.getTime() - bufferDays * 24 * 60 * 60 * 1000);
      console.log(`[sync-trigger] Incremental sync since: ${since.toISOString()}`);
    } else {
      since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      console.log(`[sync-trigger] First run — 3 day lookback`);
    }

    // Fetch existing ClickUp tasks
    const existingTaskMap = await getExistingTaskMap();
    console.log(`[sync-trigger] ${existingTaskMap.size} existing tasks in ClickUp`);

    // Fetch issues from GitLab
    let allIssues = [];
    const useCreatedAfter = !!sinceParam; // user-specified date = filter by creation date
    for (const milestone of milestoneNames) {
      const issues = await getIssuesByMilestone(milestone, since, { useCreatedAfter });
      console.log(`[sync-trigger] "${milestone}": ${issues.length} issues`);
      allIssues = allIssues.concat(issues);
    }

    // Deduplicate
    const seenIids = new Set();
    const uniqueIssues = allIssues.filter((issue) => {
      if (seenIids.has(issue.iid)) return false;
      seenIids.add(issue.iid);
      return true;
    });

    console.log(`[sync-trigger] Processing ${uniqueIssues.length} unique issues`);

    // Sync
    const results = [];
    for (const issue of uniqueIssues) {
      try {
        const result = await syncIssue(issue, existingTaskMap);
        results.push(result);
      } catch (err) {
        await logRun({
          source: 'manual', action: 'error', status: 'error',
          issueIid: issue.iid, issueTitle: issue.title,
          error: err.message,
        });
        results.push({ iid: issue.iid, error: err.message });
      }
    }

    // Save timestamp
    const now = new Date();
    await saveLastSyncTime(now);

    const created = results.filter((r) => r.action === 'created').length;
    const updated = results.filter((r) => r.action === 'updated').length;
    const skipped = results.filter((r) => r.skipped).length;
    const errors = results.filter((r) => r.error).length;

    console.log(`[sync-trigger] Done: ${created} created, ${updated} updated, ${skipped} skipped, ${errors} errors`);

    return jsonResponse(200, {
      synced: results.length,
      created,
      updated,
      skipped,
      errors,
      since: since ? since.toISOString() : null,
      timestamp: now.toISOString(),
      results,
    });
  } catch (err) {
    console.error('[sync-trigger] Fatal error:', err);
    return jsonResponse(500, { error: err.message });
  }
};
