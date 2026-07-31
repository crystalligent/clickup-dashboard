/**
 * GitLab to ClickUp Webhook Handler
 * 
 * Replaces the Activepieces flow with a self-hosted Netlify function.
 * No execution limits - runs as many times as GitLab sends webhooks.
 * 
 * Checks ClickUp list directly for existing tasks (no Google Sheets needed).
 * Task lookup is based on the naming convention: "{iid} - {title} : {url}"
 * 
 * Environment variables required (set in Netlify dashboard):
 *   CLICKUP_KEY         - ClickUp API token (pk_...)
 *   CLICKUP_LIST_ID     - ClickUp list ID for new tasks
 *   GITLAB_WEBHOOK_SECRET - Secret token to validate GitLab requests
 *   ALLOWED_MILESTONES  - Comma-separated milestone IDs to process (e.g. "802,752,756")
 *   QA_MILESTONE_ID     - Milestone ID that triggers "pending review (qa)" status (e.g. "756")
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

  if (body) {
    options.body = JSON.stringify(body);
  }

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
 * We search for tasks whose name starts with "{iid} - "
 */
async function findExistingTask(gitlabIid) {
  const listId = getEnv('CLICKUP_LIST_ID');
  const searchPrefix = `${gitlabIid} - `;

  // Use ClickUp's filtered task search — get tasks from the list
  // ClickUp API doesn't have a name search filter, so we paginate through tasks
  // Using subtasks=true and include_closed=true to check all tasks
  let page = 0;
  const perPage = 100;

  while (true) {
    const path = `/list/${listId}/task?page=${page}&subtasks=true&include_closed=true&order_by=created&reverse=true`;
    const data = await clickupRequest('GET', path);
    const tasks = data.tasks || [];

    for (const task of tasks) {
      // Match by IID prefix in task name (e.g. "6763 - Some Title : https://...")
      if (task.name.startsWith(searchPrefix)) {
        return task;
      }
    }

    // If we got fewer than a full page, we've reached the end
    if (tasks.length < perPage) break;
    page++;

    // Safety limit: don't paginate forever
    if (page > 20) break;
  }

  return null;
}

async function createClickUpTask(issue, status, assigneeIds) {
  const listId = getEnv('CLICKUP_LIST_ID');
  const taskName = `${issue.iid} - ${issue.title} : ${issue.url}`;

  const body = {
    name: taskName,
    description: issue.description || '',
    status,
    assignees: assigneeIds || [],
  };

  return clickupRequest('POST', `/list/${listId}/task`, body);
}

async function updateClickUpTask(taskId, updates) {
  return clickupRequest('PUT', `/task/${taskId}`, updates);
}

// ─── Label Detection ───────────────────────────────────────────────────────────

function labelsContainText(labels, text) {
  const str = JSON.stringify(labels);
  return str.includes(text);
}

// ─── Main Handler ──────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  // Only accept POST
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  // Validate GitLab webhook secret
  const secret = process.env.GITLAB_WEBHOOK_SECRET;
  if (secret) {
    const token = event.headers['x-gitlab-token'];
    if (token !== secret) {
      return jsonResponse(401, { error: 'Invalid webhook token' });
    }
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  // Only handle issue events
  if (payload.object_kind !== 'issue') {
    return jsonResponse(200, { skipped: true, reason: 'Not an issue event' });
  }

  const issue = payload.object_attributes;
  const labels = payload.labels || [];
  const assignees = payload.assignees || [];

  // Filter by allowed milestones
  const allowedMilestones = getEnv('ALLOWED_MILESTONES', '802,752,756')
    .split(',')
    .map((m) => m.trim());

  const milestoneId = String(issue.milestone_id || '');

  if (!milestoneId || !allowedMilestones.includes(milestoneId)) {
    await logRun({
      source: 'webhook', action: 'skipped', status: 'skipped',
      issueIid: issue.iid, issueTitle: issue.title,
      milestone: milestoneId || 'none',
      details: `Milestone not in allowed list [${allowedMilestones.join(', ')}]`,
    });
    return jsonResponse(200, {
      skipped: true,
      reason: `Milestone ${milestoneId || 'none'} not in allowed list [${allowedMilestones.join(', ')}]`,
    });
  }

  // Look up existing task directly in ClickUp list
  const existingTask = await findExistingTask(issue.iid);
  const taskName = `${issue.iid} - ${issue.title} : ${issue.url}`;

  if (existingTask) {
    // ─── Task exists: determine what to update ───
    const taskId = existingTask.id;
    const startTime = Date.now();

    if (labelsContainText(labels, '"title":"Released"')) {
      await updateClickUpTask(taskId, { name: taskName, status: 'Released to Prod' });
      await logRun({
        source: 'webhook', action: 'updated', status: 'success',
        duration: Date.now() - startTime,
        issueIid: issue.iid, issueTitle: issue.title,
        clickupTaskId: taskId, clickupStatus: 'Released to Prod',
        milestone: milestoneId, labels: labels.map((l) => l.title),
      });
      return jsonResponse(200, { action: 'updated', status: 'Released to Prod', taskId });
    }

    if (labelsContainText(labels, 'For Release')) {
      await updateClickUpTask(taskId, { name: taskName, status: 'For release' });
      await logRun({
        source: 'webhook', action: 'updated', status: 'success',
        duration: Date.now() - startTime,
        issueIid: issue.iid, issueTitle: issue.title,
        clickupTaskId: taskId, clickupStatus: 'For release',
        milestone: milestoneId, labels: labels.map((l) => l.title),
      });
      return jsonResponse(200, { action: 'updated', status: 'For release', taskId });
    }

    // Default: just update the task name
    await updateClickUpTask(taskId, { name: taskName });
    await logRun({
      source: 'webhook', action: 'updated', status: 'success',
      duration: Date.now() - startTime,
      issueIid: issue.iid, issueTitle: issue.title,
      clickupTaskId: taskId, clickupStatus: 'name update only',
      milestone: milestoneId, labels: labels.map((l) => l.title),
    });
    return jsonResponse(200, { action: 'updated', status: 'name only', taskId });
  }

  // ─── Task doesn't exist: create it ───
  const startTime = Date.now();
  const qaMilestone = getEnv('QA_MILESTONE_ID', '756');
  const defaultAssignee = process.env.DEFAULT_ASSIGNEE_ID;

  // Determine status based on labels first, then milestone
  let status;
  let assigneeIds = [];

  if (labelsContainText(labels, '"title":"Released"')) {
    status = 'Released to Prod';
  } else if (labelsContainText(labels, 'For Release')) {
    status = 'For release';
  } else if (milestoneId === qaMilestone) {
    status = 'pending review (qa)';
    if (defaultAssignee) {
      assigneeIds = [parseInt(defaultAssignee, 10)];
    }
  } else {
    status = 'Open';
  }

  try {
    const newTask = await createClickUpTask(issue, status, assigneeIds);

    await logRun({
      source: 'webhook', action: 'created', status: 'success',
      duration: Date.now() - startTime,
      issueIid: issue.iid, issueTitle: issue.title,
      clickupTaskId: newTask.id, clickupStatus: status,
      milestone: milestoneId, labels: labels.map((l) => l.title),
    });

    return jsonResponse(201, {
      action: 'created',
      taskId: newTask.id,
      status,
      name: taskName,
    });
  } catch (err) {
    await logRun({
      source: 'webhook', action: 'created', status: 'error',
      duration: Date.now() - startTime,
      issueIid: issue.iid, issueTitle: issue.title,
      milestone: milestoneId, labels: labels.map((l) => l.title),
      error: err.message,
    });
    return jsonResponse(500, { error: err.message });
  }
};
