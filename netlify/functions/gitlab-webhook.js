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

async function createClickUpTask(issue, status, assigneeIds, tags) {
  const listId = getEnv('CLICKUP_LIST_ID');
  const taskName = `${issue.iid} - ${issue.title} : ${issue.url}`;

  const body = {
    name: taskName,
    description: issue.description || '',
    status,
    assignees: assigneeIds || [],
    tags: tags || [],
  };

  return clickupRequest('POST', `/list/${listId}/task`, body);
}

async function updateClickUpTask(taskId, updates) {
  return clickupRequest('PUT', `/task/${taskId}`, updates);
}

// ─── Label Detection ───────────────────────────────────────────────────────────

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
  if (hasLabel(labels, 'For Deployment to Hotfix')) return 'for deployment to hotfix';
  if (hasLabel(labels, 'On-Going Testing')) return 'ongoing testing';
  if (hasLabel(labels, 'On-Going Development')) return 'ongoing dev';
  if (hasLabel(labels, 'Escalated to Dev')) return 'testing: failed';
  return null;
}

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

// ─── Main Handler ──────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

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

  if (payload.object_kind !== 'issue') {
    return jsonResponse(200, { skipped: true, reason: 'Not an issue event' });
  }

  const issue = payload.object_attributes;
  const labels = payload.labels || [];
  const assignees = payload.assignees || [];
  const issueState = issue.state || 'opened';

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

  const existingTask = await findExistingTask(issue.iid);
  const taskName = `${issue.iid} - ${issue.title} : ${issue.url}`;
  const expectedStatus = getExpectedStatus(labels, issueState);
  const expectedTags = getExpectedTags(labels);
  const clickupAssignees = getClickUpAssignees(assignees);
  const startTime = Date.now();

  if (existingTask) {
    // ─── Task exists: update status/name/tags/assignees ───
    const taskId = existingTask.id;
    const updates = {};

    updates.name = taskName;
    if (expectedStatus) updates.status = expectedStatus;

    // Only update assignees if they differ (replace, not add)
    const currentAssignees = (existingTask.assignees || []).map((a) => a.id);
    const expectedAssignee = clickupAssignees[0] || null;
    const currentMatch = expectedAssignee && currentAssignees.length === 1 && currentAssignees[0] === expectedAssignee;
    if (expectedAssignee && !currentMatch) {
      // Remove current assignees, set the correct one
      updates.assignees = { add: [expectedAssignee], rem: currentAssignees.filter((id) => id !== expectedAssignee) };
    }

    await updateClickUpTask(taskId, updates);

    // Add tags
    for (const tag of expectedTags) {
      try {
        await clickupRequest('POST', `/task/${taskId}/tag/${encodeURIComponent(tag)}`, {});
      } catch (e) { /* tag may already exist */ }
    }

    const statusNote = updates.status || 'name update only';
    await logRun({
      source: 'webhook', action: 'updated', status: 'success',
      duration: Date.now() - startTime,
      issueIid: issue.iid, issueTitle: issue.title,
      clickupTaskId: taskId, clickupStatus: statusNote,
      milestone: milestoneId, labels: labels.map((l) => l.title),
    });
    return jsonResponse(200, { action: 'updated', status: statusNote, taskId });
  }

  // ─── Task doesn't exist: create it ───
  const qaMilestone = getEnv('QA_MILESTONE_ID', '756');
  const defaultAssignee = process.env.DEFAULT_ASSIGNEE_ID;
  const listId = getEnv('CLICKUP_LIST_ID');

  let status = expectedStatus || 'Open';
  let assigneeIds = clickupAssignees.length > 0 ? clickupAssignees : [];

  if (!expectedStatus && milestoneId === qaMilestone) {
    status = 'pending review (qa)';
    if (assigneeIds.length === 0 && defaultAssignee) {
      assigneeIds = [parseInt(defaultAssignee, 10)];
    }
  }

  try {
    const newTask = await createClickUpTask(issue, status, assigneeIds, expectedTags);

    await logRun({
      source: 'webhook', action: 'created', status: 'success',
      duration: Date.now() - startTime,
      issueIid: issue.iid, issueTitle: issue.title,
      clickupTaskId: newTask.id, clickupStatus: status,
      milestone: milestoneId, labels: labels.map((l) => l.title),
    });

    return jsonResponse(201, { action: 'created', taskId: newTask.id, status, name: taskName });
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
