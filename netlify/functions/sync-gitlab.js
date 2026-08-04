/**
 * Scheduled GitLab → ClickUp Sync (every 5 minutes)
 * 
 * On each run:
 *   1. Reads the last successful sync timestamp (stored in /tmp or Netlify Blobs)
 *   2. Queries GitLab for issues updated since (last_sync - 2 day buffer)
 *   3. Filters to configured milestones only
 *   4. Creates/updates ClickUp tasks as needed
 *   5. Saves the new sync timestamp
 * 
 * First run (no previous timestamp): uses 3-day lookback window.
 * 
 * Schedule: Every 5 minutes (configured in netlify.toml)
 * Manual trigger: GET /.netlify/functions/sync-gitlab
 * 
 * Environment variables:
 *   CLICKUP_KEY         - ClickUp API token (pk_...)
 *   CLICKUP_LIST_ID     - ClickUp list ID for new tasks
 *   GITLAB_URL          - GitLab base URL (e.g. https://tools.iripple.com)
 *   GITLAB_TOKEN        - GitLab personal access token (for API calls)
 *   GITLAB_PROJECT_ID   - GitLab project ID to poll (e.g. 394)
 *   GITLAB_MILESTONES   - Comma-separated milestone names to sync (e.g. "For review,Ongoing")
 *   QA_MILESTONE_ID     - Milestone ID that triggers "pending review (qa)" status
 *   DEFAULT_ASSIGNEE_ID - ClickUp assignee ID for QA milestone tasks (optional)
 *   SYNC_BUFFER_DAYS    - Days to look back from last sync (default: 2)
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
  // Try Netlify Blobs first (persists across deploys in production)
  try {
    const { getStore } = require('@netlify/blobs');
    const store = getStore('sync-meta');
    const data = await store.get('last-sync', { type: 'json' });
    if (data?.timestamp) return new Date(data.timestamp);
  } catch (e) {
    // Blobs not available — try local file
  }

  // Local fallback
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

  // Try Netlify Blobs
  try {
    const { getStore } = require('@netlify/blobs');
    const store = getStore('sync-meta');
    await store.setJSON('last-sync', data);
  } catch (e) {
    // Blobs not available
  }

  // Always save to local file too (for local dev)
  try {
    fs.writeFileSync(LAST_SYNC_FILE, JSON.stringify(data), 'utf8');
  } catch (e) { /* ignore */ }
}

// ─── ClickUp API ───────────────────────────────────────────────────────────────

async function clickupRequest(method, path, body) {
  const apiKey = getEnv('CLICKUP_KEY');

  const options = {
    method,
    headers: {
      'Authorization': apiKey,
      'Content-Type': 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${CLICKUP_API}${path}`, options);
  const data = await res.json();

  if (!res.ok) {
    console.error(`ClickUp API error [${method} ${path}]:`, res.status, data);
    throw new Error(`ClickUp API ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * Get all task names from the ClickUp list for duplicate detection.
 * Returns a Map of IID string → { id, name, status }
 */
async function getExistingTaskMap() {
  const listId = getEnv('CLICKUP_LIST_ID');
  const taskMap = new Map();

  let page = 0;
  while (true) {
    const path = `/list/${listId}/task?page=${page}&subtasks=true&include_closed=true`;
    const data = await clickupRequest('GET', path);
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

/**
 * Fetch issues from a milestone that were updated after `since` date.
 */
async function getIssuesByMilestone(milestoneName, since) {
  const gitlabUrl = getEnv('GITLAB_URL');
  const token = getEnv('GITLAB_TOKEN');
  const projectId = getEnv('GITLAB_PROJECT_ID');

  let allIssues = [];
  let page = 1;

  while (true) {
    let url = `${gitlabUrl}/api/v4/projects/${projectId}/issues?milestone=${encodeURIComponent(milestoneName)}&per_page=100&page=${page}`;

    // Add updated_after filter if we have a since date
    if (since) {
      url += `&updated_after=${since.toISOString()}`;
    }

    const res = await fetch(url, {
      headers: { 'PRIVATE-TOKEN': token },
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`GitLab API error (milestone "${milestoneName}", page ${page}):`, res.status, errText);
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
  'agregorio': 89084186,
  'atacipit': 100808559,
  'bviloria': 3798865,
  'cdimalanta': 270739823,
  'dcomia': 95085613,
  'emonding': 100842272,
  'jsacay': 94935510,
  'jgregorio': 89079122,
  'mtanqueco': 3827858,
  'pcabalo': 89084187,
  'rmendoza': 276899809,
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

function getExpectedStatus(labels, issueState) {
  if (issueState === 'closed') return 'Closed';
  if (hasLabel(labels, 'Released')) return 'released to prod';
  if (hasLabel(labels, 'For Release')) return 'for release';
  if (hasLabel(labels, 'Done') || hasLabel(labels, 'Done Development')) return 'done development';
  if (hasLabel(labels, 'For Testing')) return 'for testing in hotfix';
  if (hasLabel(labels, 'On-Going Testing')) return 'ongoing testing';
  if (hasLabel(labels, 'On-Going Development')) return 'ongoing dev';
  if (hasLabel(labels, 'Escalated to Dev')) return 'testing: failed';
  return null;
}

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

    const updates = {};
    if (existing.name !== taskName) updates.name = taskName;
    if (expectedStatus && existing.status !== expectedStatus) updates.status = expectedStatus;

    // Sync assignees
    if (clickupAssignees.length > 0) {
      updates.assignees = { add: clickupAssignees };
    }

    let tagsAdded = [];
    for (const tag of expectedTags) {
      try {
        await clickupRequest('POST', `/task/${taskId}/tag/${encodeURIComponent(tag)}`, {});
        tagsAdded.push(tag);
      } catch (e) { /* tag may already exist */ }
    }

    if (Object.keys(updates).length > 0 || tagsAdded.length > 0) {
      if (Object.keys(updates).length > 0) {
        await clickupRequest('PUT', `/task/${taskId}`, updates);
      }
      const statusNote = updates.status || (tagsAdded.length > 0 ? `tags: ${tagsAdded.join(', ')}` : 'name update only');
      await logRun({
        source: 'scheduled', action: 'updated', status: 'success',
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
    source: 'scheduled', action: 'created', status: 'success',
    duration: Date.now() - startTime,
    issueIid: issue.iid, issueTitle: issue.title,
    clickupTaskId: newTask.id, clickupStatus: status,
    milestone: milestoneName, labels: labels.map((l) => l.title),
  });

  return { iid: issue.iid, action: 'created', taskId: newTask.id, status };
}

// ─── Handler ───────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const triggerSource = event.httpMethod === 'GET' ? 'manual' : 'scheduled';
  console.log(`[sync-gitlab] Triggered (${triggerSource}) at ${new Date().toISOString()}`);

  try {
    // Get milestone names to sync
    const milestoneNames = getEnv('GITLAB_MILESTONES', 'For review,Ongoing')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);

    // Determine the lookback window
    const bufferDays = parseInt(getEnv('SYNC_BUFFER_DAYS', '2'), 10);
    const lastSync = await getLastSyncTime();
    let since = null;

    // Check if "full" sync was requested (no time filter)
    const isFullSync = event.queryStringParameters?.full === 'true';

    if (isFullSync) {
      since = null;
      console.log(`[sync-gitlab] Full sync requested — fetching ALL open issues (no date filter)`);
    } else if (lastSync) {
      since = new Date(lastSync.getTime() - bufferDays * 24 * 60 * 60 * 1000);
      console.log(`[sync-gitlab] Last sync: ${lastSync.toISOString()}`);
      console.log(`[sync-gitlab] Fetching issues updated after: ${since.toISOString()} (${bufferDays}-day buffer)`);
    } else {
      // First run ever — look back 3 days
      since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      console.log(`[sync-gitlab] First run — looking back 3 days from now: ${since.toISOString()}`);
    }

    console.log(`[sync-gitlab] Syncing milestones: ${milestoneNames.join(', ')}`);

    // Fetch existing ClickUp tasks for dedup
    console.log('[sync-gitlab] Fetching existing ClickUp tasks...');
    const existingTaskMap = await getExistingTaskMap();
    console.log(`[sync-gitlab] Found ${existingTaskMap.size} existing tasks in ClickUp`);

    // Fetch issues from each milestone (only those updated since our window)
    let allIssues = [];
    for (const milestone of milestoneNames) {
      console.log(`[sync-gitlab] Fetching issues for milestone: "${milestone}"`);
      const issues = await getIssuesByMilestone(milestone, since);
      console.log(`[sync-gitlab]   → ${issues.length} issues updated since ${since.toISOString()}`);
      allIssues = allIssues.concat(issues);
    }

    // Deduplicate
    const seenIids = new Set();
    const uniqueIssues = allIssues.filter((issue) => {
      if (seenIids.has(issue.iid)) return false;
      seenIids.add(issue.iid);
      return true;
    });

    console.log(`[sync-gitlab] Processing ${uniqueIssues.length} unique issues`);

    // Sync each issue
    const results = [];
    for (const issue of uniqueIssues) {
      try {
        const result = await syncIssue(issue, existingTaskMap);
        results.push(result);
      } catch (err) {
        await logRun({
          source: 'scheduled', action: 'error', status: 'error',
          issueIid: issue.iid, issueTitle: issue.title,
          error: err.message,
        });
        results.push({ iid: issue.iid, error: err.message });
      }
    }

    // Save this run's timestamp
    const now = new Date();
    await saveLastSyncTime(now);

    const created = results.filter((r) => r.action === 'created').length;
    const updated = results.filter((r) => r.action === 'updated').length;
    const skipped = results.filter((r) => r.skipped).length;
    const errors = results.filter((r) => r.error).length;

    console.log(`[sync-gitlab] Done: ${created} created, ${updated} updated, ${skipped} skipped, ${errors} errors`);

    return jsonResponse(200, {
      synced: results.length,
      created,
      updated,
      skipped,
      errors,
      since: since.toISOString(),
      timestamp: now.toISOString(),
      results,
    });
  } catch (err) {
    console.error('[sync-gitlab] Fatal error:', err);
    return jsonResponse(500, { error: err.message });
  }
};
