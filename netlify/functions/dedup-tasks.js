/**
 * Dedup Tasks — Removes duplicate ClickUp tasks from the list.
 * Keeps the OLDEST task for each GitLab IID, deletes newer duplicates.
 * 
 * GET /.netlify/functions/dedup-tasks → run dedup (requires password)
 */

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

exports.handler = async (event) => {
  // Password protection
  const requiredPassword = process.env.LOGS_PASSWORD;
  if (requiredPassword) {
    const provided = event.headers['x-sync-password'] || '';
    if (provided !== requiredPassword) {
      return jsonResponse(401, { error: 'Unauthorized' });
    }
  }

  const listId = getEnv('CLICKUP_LIST_ID');
  const previewOnly = event.queryStringParameters?.preview === 'true';

  // Fetch all tasks
  let allTasks = [];
  let page = 0;
  while (true) {
    const data = await clickupRequest('GET', `/list/${listId}/task?page=${page}&subtasks=true&include_closed=true`);
    const tasks = data.tasks || [];
    allTasks = allTasks.concat(tasks);
    if (tasks.length < 100) break;
    page++;
    if (page > 50) break;
  }

  // Group by IID
  const iidMap = {};
  for (const task of allTasks) {
    const match = task.name.match(/^(\d+)\s*-\s*/);
    if (match) {
      const iid = match[1];
      if (!iidMap[iid]) iidMap[iid] = [];
      iidMap[iid].push({ id: task.id, name: task.name, created: parseInt(task.date_created || '0', 10) });
    }
  }

  // Find duplicates
  const duplicates = [];
  for (const [iid, copies] of Object.entries(iidMap)) {
    if (copies.length <= 1) continue;
    copies.sort((a, b) => a.created - b.created);
    duplicates.push({
      iid,
      kept: { id: copies[0].id, name: copies[0].name },
      toDelete: copies.slice(1).map((c) => ({ id: c.id, name: c.name })),
    });
  }

  // Preview mode: return list without deleting
  if (previewOnly) {
    return jsonResponse(200, {
      total: allTasks.length,
      unique: Object.keys(iidMap).length,
      duplicateCount: duplicates.reduce((sum, d) => sum + d.toDelete.length, 0),
      duplicates,
    });
  }

  // Delete newer copies (keep oldest)
  let deleted = 0;
  const deletedIds = [];

  for (const dup of duplicates) {
    for (const copy of dup.toDelete) {
      try {
        await clickupRequest('DELETE', `/task/${copy.id}`);
        deleted++;
        deletedIds.push({ iid: dup.iid, taskId: copy.id });
      } catch (e) {
        console.error(`Failed to delete task ${copy.id} (IID ${dup.iid}):`, e.message);
      }
    }
  }

  return jsonResponse(200, {
    total: allTasks.length,
    unique: Object.keys(iidMap).length,
    duplicatesRemoved: deleted,
    deletedIds,
  });
};
