/**
 * Sync Single Issue — Syncs a specific GitLab issue to ClickUp by URL.
 * 
 * GET /.netlify/functions/sync-single?url=https://tools.iripple.com/barter-11/bxi-backend/-/issues/6763
 * 
 * Checks if the issue already exists in ClickUp (by searching task names for the URL).
 * If exists: updates status/name/assignees based on labels.
 * If not: creates it.
 */

const { logRun } = require('./utils/logger');

const CLICKUP_API = 'https://api.clickup.com/api/v2';

function getEnv(key, fallback) {
  const val = process.env[key];
  if (!val && fallback === undefined) throw new Error(`Missing: ${key}`);
  return val || fallback;
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// ─── Assignee Mapping ──────────────────────────────────────────────────────────

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
  return gitlabAssignees.map((a) => ASSIGNEE_MAP[a.username]).filter(Boolean);
}

// ─── Label / Status Mapping ────────────────────────────────────────────────────

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

// ─── ClickUp API ───────────────────────────────────────────────────────────────

async function clickupRequest(method, path, body) {
  const apiKey = getEnv('CLICKUP_KEY');
  const options = {
    method,
    headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${CLICKUP_API}${path}`, options);
  const data = await res.json();
  if (!res.ok) throw new Error(`ClickUp ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

/**
 * Search for existing task by checking if any task name contains the GitLab issue URL.
 */
async function findTaskByUrl(gitlabUrl) {
  const listId = getEnv('CLICKUP_LIST_ID');
  let page = 0;

  while (true) {
    const data = await clickupRequest('GET', `/list/${listId}/task?page=${page}&subtasks=true&include_closed=true`);
    const tasks = data.tasks || [];

    for (const task of tasks) {
      if (task.name.includes(gitlabUrl)) {
        return task;
      }
    }

    if (tasks.length < 100) break;
    page++;
    if (page > 50) break;
  }

  return null;
}

// ─── GitLab API ────────────────────────────────────────────────────────────────

async function fetchIssueByUrl(issueUrl) {
  const gitlabUrl = getEnv('GITLAB_URL');
  const token = getEnv('GITLAB_TOKEN');

  // Parse URL: https://tools.iripple.com/barter-11/bxi-backend/-/issues/6763
  const urlObj = new URL(issueUrl);
  const pathParts = urlObj.pathname.split('/-/issues/');
  if (pathParts.length !== 2) throw new Error('Invalid GitLab issue URL format');

  const projectPath = pathParts[0].replace(/^\//, '');
  const iid = pathParts[1].replace(/\/$/, '');

  // Get project ID from path
  const projRes = await fetch(`${gitlabUrl}/api/v4/projects/${encodeURIComponent(projectPath)}`, {
    headers: { 'PRIVATE-TOKEN': token },
  });
  if (!projRes.ok) throw new Error(`GitLab project lookup failed: ${projRes.status}`);
  const project = await projRes.json();

  // Fetch the issue
  const issueRes = await fetch(`${gitlabUrl}/api/v4/projects/${project.id}/issues/${iid}`, {
    headers: { 'PRIVATE-TOKEN': token },
  });
  if (!issueRes.ok) throw new Error(`GitLab issue lookup failed: ${issueRes.status}`);
  return issueRes.json();
}

// ─── Handler ───────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  // Password protection
  const requiredPassword = process.env.LOGS_PASSWORD;
  if (requiredPassword) {
    const provided = event.headers['x-sync-password'] || '';
    if (provided !== requiredPassword) {
      return jsonResponse(401, { error: 'Unauthorized' });
    }
  }

  const issueUrl = event.queryStringParameters?.url;
  if (!issueUrl) {
    return jsonResponse(400, { error: 'Missing "url" query parameter' });
  }

  console.log(`[sync-single] Syncing: ${issueUrl}`);

  try {
    const startTime = Date.now();

    // Fetch issue from GitLab
    const issue = await fetchIssueByUrl(issueUrl);
    const labels = (issue.labels || []).map((title) => ({ title }));
    const issueState = issue.state || 'opened';
    const taskName = `${issue.iid} - ${issue.title} : ${issue.web_url}`;
    const milestoneId = issue.milestone ? String(issue.milestone.id) : '';
    const milestoneName = issue.milestone ? issue.milestone.title : '';

    const expectedStatus = getExpectedStatus(labels, issueState);
    const expectedTags = getExpectedTags(labels);
    const clickupAssignees = getClickUpAssignees(issue.assignees || []);

    // Check if task already exists by URL in task name
    const existingTask = await findTaskByUrl(issue.web_url);

    if (existingTask) {
      // Update existing task
      const taskId = existingTask.id;
      const updates = { name: taskName };
      if (expectedStatus) updates.status = expectedStatus;

      // Only update assignee if different (replace — one assignee only)
      const currentAssignees = (existingTask.assignees || []).map((a) => a.id);
      const expectedAssignee = clickupAssignees[0] || null;
      const currentMatch = expectedAssignee && currentAssignees.length === 1 && currentAssignees[0] === expectedAssignee;
      if (expectedAssignee && !currentMatch) {
        updates.assignees = { add: [expectedAssignee], rem: currentAssignees.filter((id) => id !== expectedAssignee) };
      }

      await clickupRequest('PUT', `/task/${taskId}`, updates);

      for (const tag of expectedTags) {
        try { await clickupRequest('POST', `/task/${taskId}/tag/${encodeURIComponent(tag)}`, {}); } catch (e) {}
      }

      await logRun({
        source: 'manual', action: 'updated', status: 'success',
        duration: Date.now() - startTime,
        issueIid: issue.iid, issueTitle: issue.title,
        clickupTaskId: taskId, clickupStatus: expectedStatus || 'name update',
        milestone: milestoneName, labels: labels.map((l) => l.title),
      });

      return jsonResponse(200, { action: 'updated', taskId, iid: issue.iid, title: issue.title, status: expectedStatus || 'updated' });
    }

    // Create new task
    const listId = getEnv('CLICKUP_LIST_ID');
    const qaMilestoneId = getEnv('QA_MILESTONE_ID', '756');

    let status = expectedStatus || 'Open';
    let assigneeIds = clickupAssignees.length > 0 ? clickupAssignees : [];

    if (!expectedStatus && milestoneId === qaMilestoneId) {
      status = 'pending review (qa)';
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

    return jsonResponse(201, { action: 'created', taskId: newTask.id, iid: issue.iid, title: issue.title, status });
  } catch (err) {
    console.error('[sync-single] Error:', err.message);
    return jsonResponse(500, { error: err.message });
  }
};
