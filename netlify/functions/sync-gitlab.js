/**
 * Scheduled GitLab → ClickUp Sync (every 5 minutes)
 * 
 * Polls GitLab for recently updated issues and syncs them to ClickUp.
 * This acts as a fallback in case webhooks are missed, and also supports
 * manual triggering via GET request.
 * 
 * Checks ClickUp list directly for existing tasks (no Google Sheets needed).
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
 *   ALLOWED_MILESTONES  - Comma-separated milestone IDs to process
 *   QA_MILESTONE_ID     - Milestone ID that triggers "pending review (qa)" status
 *   DEFAULT_ASSIGNEE_ID - ClickUp assignee ID for QA milestone tasks (optional)
 */

const { logRun } = require('./utils/logger');

const CLICKUP_API = 'https://api.clickup.com/api/v2';

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
 * Search for an existing task in the ClickUp list by GitLab IID.
 * Task names follow the pattern: "{iid} - {title} : {url}"
 */
async function findExistingTask(gitlabIid) {
  const listId = getEnv('CLICKUP_LIST_ID');
  const searchPrefix = `${gitlabIid} - `;

  let page = 0;
  const perPage = 100;

  while (true) {
    const path = `/list/${listId}/task?page=${page}&subtasks=true&include_closed=true&order_by=created&reverse=true`;
    const data = await clickupRequest('GET', path);
    const tasks = data.tasks || [];

    for (const task of tasks) {
      if (task.name.startsWith(searchPrefix)) {
        return task;
      }
    }

    if (tasks.length < perPage) break;
    page++;
    if (page > 20) break;
  }

  return null;
}

// ─── GitLab API ────────────────────────────────────────────────────────────────

async function getRecentIssues() {
  const gitlabUrl = getEnv('GITLAB_URL');
  const token = getEnv('GITLAB_TOKEN');
  const projectId = getEnv('GITLAB_PROJECT_ID');

  // Get issues updated in the last 6 minutes (overlap with 5-min schedule for safety)
  const since = new Date(Date.now() - 6 * 60 * 1000).toISOString();

  const url = `${gitlabUrl}/api/v4/projects/${projectId}/issues?updated_after=${since}&per_page=100&state=all`;

  const res = await fetch(url, {
    headers: { 'PRIVATE-TOKEN': token },
  });

  if (!res.ok) {
    console.error('GitLab API error:', res.status, await res.text());
    return [];
  }

  return res.json();
}

// ─── Label Detection ───────────────────────────────────────────────────────────

function labelsContainText(labels, text) {
  const str = JSON.stringify(labels);
  return str.includes(text);
}

// ─── Sync Logic ────────────────────────────────────────────────────────────────

async function syncIssue(issue) {
  const allowedMilestones = getEnv('ALLOWED_MILESTONES', '802,752,756')
    .split(',')
    .map((m) => m.trim());

  // GitLab REST API returns milestone as an object
  const milestoneId = issue.milestone ? String(issue.milestone.id) : '';

  if (!milestoneId || !allowedMilestones.includes(milestoneId)) {
    return { iid: issue.iid, skipped: true, reason: 'milestone not allowed' };
  }

  const startTime = Date.now();
  // GitLab REST API returns labels as array of strings
  const labels = (issue.labels || []).map((title) => ({ title }));
  const taskName = `${issue.iid} - ${issue.title} : ${issue.web_url}`;

  // Check ClickUp directly for existing task
  const existingTask = await findExistingTask(issue.iid);

  if (existingTask) {
    const taskId = existingTask.id;

    if (labelsContainText(labels, 'Released')) {
      await clickupRequest('PUT', `/task/${taskId}`, { name: taskName, status: 'Released to Prod' });
      await logRun({
        source: 'scheduled', action: 'updated', status: 'success',
        duration: Date.now() - startTime,
        issueIid: issue.iid, issueTitle: issue.title,
        clickupTaskId: taskId, clickupStatus: 'Released to Prod',
        milestone: milestoneId, labels: labels.map((l) => l.title),
      });
      return { iid: issue.iid, action: 'updated', status: 'Released to Prod' };
    }

    if (labelsContainText(labels, 'For Release')) {
      await clickupRequest('PUT', `/task/${taskId}`, { name: taskName, status: 'For release' });
      await logRun({
        source: 'scheduled', action: 'updated', status: 'success',
        duration: Date.now() - startTime,
        issueIid: issue.iid, issueTitle: issue.title,
        clickupTaskId: taskId, clickupStatus: 'For release',
        milestone: milestoneId, labels: labels.map((l) => l.title),
      });
      return { iid: issue.iid, action: 'updated', status: 'For release' };
    }

    await clickupRequest('PUT', `/task/${taskId}`, { name: taskName });
    await logRun({
      source: 'scheduled', action: 'updated', status: 'success',
      duration: Date.now() - startTime,
      issueIid: issue.iid, issueTitle: issue.title,
      clickupTaskId: taskId, clickupStatus: 'name update only',
      milestone: milestoneId, labels: labels.map((l) => l.title),
    });
    return { iid: issue.iid, action: 'updated', status: 'name only' };
  }

  // Create new task
  const qaMilestone = getEnv('QA_MILESTONE_ID', '756');
  const defaultAssignee = process.env.DEFAULT_ASSIGNEE_ID;
  const listId = getEnv('CLICKUP_LIST_ID');

  let status = 'Open';
  let assigneeIds = [];

  if (milestoneId === qaMilestone) {
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
    source: 'scheduled', action: 'created', status: 'success',
    duration: Date.now() - startTime,
    issueIid: issue.iid, issueTitle: issue.title,
    clickupTaskId: newTask.id, clickupStatus: status,
    milestone: milestoneId, labels: labels.map((l) => l.title),
  });

  return { iid: issue.iid, action: 'created', taskId: newTask.id, status };
}

// ─── Handler ───────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  // Support both scheduled invocation and manual GET trigger
  console.log(`[sync-gitlab] Triggered at ${new Date().toISOString()}`);

  try {
    const issues = await getRecentIssues();
    console.log(`[sync-gitlab] Found ${issues.length} recently updated issues`);

    const results = [];
    for (const issue of issues) {
      try {
        const result = await syncIssue(issue);
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

    return jsonResponse(200, {
      synced: results.length,
      timestamp: new Date().toISOString(),
      results,
    });
  } catch (err) {
    console.error('[sync-gitlab] Fatal error:', err);
    return jsonResponse(500, { error: err.message });
  }
};
