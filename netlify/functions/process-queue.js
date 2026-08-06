/**
 * Queue Processor (every 5 minutes)
 * 
 * Takes a batch of issues from the queue and syncs them to ClickUp.
 * Each run processes up to BATCH_SIZE issues (default: 5) to stay within
 * the 10-second Netlify function timeout.
 * 
 * For each issue:
 *   - If exists in ClickUp: update status, name, assignees, tags
 *   - If not: create with correct status, assignees, tags
 * 
 * Schedule: Every 5 minutes
 */

const { dequeue, getQueueSize } = require('./utils/queue');
const { logRun } = require('./utils/logger');

const CLICKUP_API = 'https://api.clickup.com/api/v2';
const BATCH_SIZE = 5;

function getEnv(key, fallback) {
  const val = process.env[key];
  if (!val && fallback === undefined) throw new Error(`Missing: ${key}`);
  return val || fallback;
}

function jsonResponse(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
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
  if (method === 'DELETE' && res.status === 200) return { ok: true };
  const data = await res.json();
  if (!res.ok) throw new Error(`ClickUp ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function findExistingTask(iid) {
  const listId = getEnv('CLICKUP_LIST_ID');
  const searchPrefix = `${iid} - `;
  let page = 0;

  while (true) {
    const data = await clickupRequest('GET', `/list/${listId}/task?page=${page}&subtasks=true&include_closed=true`);
    const tasks = data.tasks || [];
    for (const task of tasks) {
      if (task.name.startsWith(searchPrefix)) {
        return { id: task.id, name: task.name, status: task.status?.status };
      }
    }
    if (tasks.length < 100) break;
    page++;
    if (page > 50) break;
  }
  return null;
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

function getClickUpAssignees(assignees) {
  if (!assignees || assignees.length === 0) return [];
  return assignees.map((a) => ASSIGNEE_MAP[a.username]).filter(Boolean);
}

// ─── Label / Status / Tag Mapping ──────────────────────────────────────────────

function hasLabel(labels, title) {
  return labels.some((l) => (typeof l === 'string' ? l : l.title) === title);
}

function getExpectedStatus(labels, issueState) {
  if (issueState === 'closed') return 'Closed';
  if (hasLabel(labels, 'Released')) return 'released to prod';
  if (hasLabel(labels, 'For Release')) return 'for release';
  if (hasLabel(labels, 'Done') || hasLabel(labels, 'Done Development')) return 'done development';
  if (hasLabel(labels, 'For Deployment to Hotfix')) return 'for deployment to hotfix';
  if (hasLabel(labels, 'For Testing')) return 'for testing in hotfix';
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

// ─── Process a single queued issue ─────────────────────────────────────────────

async function processIssue(item) {
  const startTime = Date.now();

  // Normalize labels (queue stores them as strings from GitLab API)
  const labels = (item.labels || []).map((l) => typeof l === 'string' ? { title: l } : l);
  const taskName = `${item.iid} - ${item.title} : ${item.web_url}`;
  const expectedStatus = getExpectedStatus(labels, item.state);
  const expectedTags = getExpectedTags(labels);
  const clickupAssignees = getClickUpAssignees(item.assignees || []);

  // Check if task exists in ClickUp
  const existing = await findExistingTask(item.iid);

  if (existing) {
    // ─── Update existing task ───
    const taskId = existing.id;
    const updates = { name: taskName };
    if (expectedStatus && existing.status !== expectedStatus) updates.status = expectedStatus;
    if (clickupAssignees.length > 0) updates.assignees = { add: clickupAssignees };

    await clickupRequest('PUT', `/task/${taskId}`, updates);

    // Add tags
    for (const tag of expectedTags) {
      try { await clickupRequest('POST', `/task/${taskId}/tag/${encodeURIComponent(tag)}`, {}); } catch (e) {}
    }

    await logRun({
      source: 'scheduled', action: 'updated', status: 'success',
      duration: Date.now() - startTime,
      issueIid: item.iid, issueTitle: item.title,
      clickupTaskId: taskId, clickupStatus: updates.status || existing.status,
      milestone: item.milestone_name, labels: item.labels,
    });

    return { iid: item.iid, action: 'updated', status: updates.status || 'synced' };
  }

  // ─── Create new task ───
  const listId = getEnv('CLICKUP_LIST_ID');
  const qaMilestoneId = getEnv('QA_MILESTONE_ID', '756');

  let status = expectedStatus || 'Open';
  let assigneeIds = clickupAssignees.length > 0 ? clickupAssignees : [];

  if (!expectedStatus && item.milestone_id === qaMilestoneId) {
    status = 'pending review (qa)';
  }

  const newTask = await clickupRequest('POST', `/list/${listId}/task`, {
    name: taskName,
    description: item.description || '',
    status,
    assignees: assigneeIds,
    tags: expectedTags,
  });

  await logRun({
    source: 'scheduled', action: 'created', status: 'success',
    duration: Date.now() - startTime,
    issueIid: item.iid, issueTitle: item.title,
    clickupTaskId: newTask.id, clickupStatus: status,
    milestone: item.milestone_name, labels: item.labels,
  });

  return { iid: item.iid, action: 'created', taskId: newTask.id, status };
}

// ─── Handler ───────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  console.log(`[process-queue] Running at ${new Date().toISOString()}`);

  try {
    const batch = await dequeue(BATCH_SIZE);

    if (batch.length === 0) {
      console.log('[process-queue] Queue empty, nothing to process');
      return jsonResponse(200, { processed: 0, remaining: 0 });
    }

    console.log(`[process-queue] Processing ${batch.length} issues`);

    const results = [];
    for (const item of batch) {
      try {
        const result = await processIssue(item);
        results.push(result);
      } catch (err) {
        console.error(`[process-queue] Error on #${item.iid}:`, err.message);
        await logRun({
          source: 'scheduled', action: 'error', status: 'error',
          issueIid: item.iid, issueTitle: item.title,
          error: err.message,
        });
        results.push({ iid: item.iid, error: err.message });
      }
    }

    const remaining = await getQueueSize();
    console.log(`[process-queue] Done. Processed: ${results.length}, Remaining in queue: ${remaining}`);

    return jsonResponse(200, { processed: results.length, remaining, results });
  } catch (err) {
    console.error('[process-queue] Fatal error:', err.message);
    return jsonResponse(500, { error: err.message });
  }
};
