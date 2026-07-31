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

async function getIssuesByMilestone(milestoneName, since) {
  const gitlabUrl = getEnv('GITLAB_URL');
  const token = getEnv('GITLAB_TOKEN');
  const projectId = getEnv('GITLAB_PROJECT_ID');

  let allIssues = [];
  let page = 1;

  while (true) {
    let url = `${gitlabUrl}/api/v4/projects/${projectId}/issues?milestone=${encodeURIComponent(milestoneName)}&state=opened&per_page=100&page=${page}`;

    if (since) {
      url += `&updated_after=${since.toISOString()}`;
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

// ─── Label Detection ───────────────────────────────────────────────────────────

function labelsContainText(labels, text) {
  return JSON.stringify(labels).includes(text);
}

// ─── Sync Logic ────────────────────────────────────────────────────────────────

async function syncIssue(issue, existingTaskMap) {
  const startTime = Date.now();
  const iidStr = String(issue.iid);
  const labels = (issue.labels || []).map((title) => ({ title }));
  const taskName = `${issue.iid} - ${issue.title} : ${issue.web_url}`;
  const milestoneId = issue.milestone ? String(issue.milestone.id) : '';
  const milestoneName = issue.milestone ? issue.milestone.title : '';

  const existing = existingTaskMap.get(iidStr);

  if (existing) {
    const taskId = existing.id;

    // Determine expected status based on GitLab labels
    let expectedStatus = null;
    if (labelsContainText(labels, 'Released')) {
      expectedStatus = 'Released to Prod';
    } else if (labelsContainText(labels, 'For Release')) {
      expectedStatus = 'For release';
    }

    // Build update payload — only include fields that changed
    const updates = {};
    if (existing.name !== taskName) updates.name = taskName;
    if (expectedStatus && existing.status !== expectedStatus) updates.status = expectedStatus;

    if (Object.keys(updates).length > 0) {
      await clickupRequest('PUT', `/task/${taskId}`, updates);
      const statusNote = updates.status || 'name update only';
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

  let status = 'Open';
  let assigneeIds = [];

  if (labelsContainText(labels, 'Released')) {
    status = 'Released to Prod';
  } else if (labelsContainText(labels, 'For Release')) {
    status = 'For release';
  } else if (milestoneId === qaMilestoneId) {
    status = 'pending review (qa)';
    if (defaultAssignee) assigneeIds = [parseInt(defaultAssignee, 10)];
  }

  const newTask = await clickupRequest('POST', `/list/${listId}/task`, {
    name: taskName,
    description: issue.description || '',
    status,
    assignees: assigneeIds,
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

    if (isFullSync) {
      since = null;
      console.log('[sync-trigger] Full sync — no date filter');
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
    for (const milestone of milestoneNames) {
      const issues = await getIssuesByMilestone(milestone, since);
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
