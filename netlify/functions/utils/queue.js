/**
 * Queue utility — stores pending issue syncs in Netlify Blobs or local /tmp.
 * 
 * Queue item format:
 * { iid, title, web_url, description, state, milestone_id, milestone_name, labels, assignees, added_at }
 * 
 * IMPORTANT: Call initBlobContext(event) before any queue operations in Lambda-mode functions.
 */

const fs = require('fs');
const path = require('path');

const QUEUE_FILE = path.join('/tmp', 'sync-queue.json');
const META_FILE = path.join('/tmp', 'sync-meta.json');

// ─── Blob context initialization ───────────────────────────────────────────────

/**
 * Must be called once per function invocation (with the Lambda event)
 * before any Blob operations. This configures the Blob environment for
 * Lambda-compatible functions (exports.handler pattern).
 */
function initBlobContext(event) {
  try {
    const { connectLambda } = require('@netlify/blobs');
    connectLambda(event);
    return true;
  } catch (e) {
    console.error(`[queue] Failed to init Blob context: ${e.message}`);
    return false;
  }
}

// ─── Blob helpers ──────────────────────────────────────────────────────────────

async function getBlobStore(name) {
  try {
    const { getStore } = require('@netlify/blobs');
    const store = getStore(name);
    return store;
  } catch (e) {
    console.error(`[queue] Failed to get Blob store "${name}": ${e.message}`);
    return null;
  }
}

// ─── Queue operations ──────────────────────────────────────────────────────────

async function getQueue() {
  const store = await getBlobStore('sync-queue');
  if (store) {
    try {
      const data = await store.get('pending', { type: 'json' });
      return data || [];
    } catch (e) {
      console.error(`[queue] Blob read error: ${e.message}`);
      return [];
    }
  }
  // Local fallback
  try {
    if (fs.existsSync(QUEUE_FILE)) return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  } catch (e) {}
  return [];
}

async function saveQueue(queue) {
  const store = await getBlobStore('sync-queue');
  if (store) {
    try {
      await store.setJSON('pending', queue);
      console.log(`[queue] Saved ${queue.length} items to Blob store`);
      return;
    } catch (e) {
      console.error(`[queue] Blob write error: ${e.message}`);
    }
  }
  // Fallback to /tmp (only works within same invocation)
  console.warn(`[queue] Falling back to /tmp — data will NOT persist across invocations`);
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue), 'utf8');
}

/**
 * Add issues to the queue. Deduplicates by IID — if an issue is already queued,
 * it gets updated with the latest data.
 */
async function enqueue(issues) {
  const queue = await getQueue();
  const existingMap = new Map(queue.map((item) => [String(item.iid), item]));

  for (const issue of issues) {
    existingMap.set(String(issue.iid), {
      iid: issue.iid,
      title: issue.title,
      web_url: issue.web_url,
      description: issue.description || '',
      state: issue.state || 'opened',
      milestone_id: issue.milestone ? String(issue.milestone.id) : '',
      milestone_name: issue.milestone ? issue.milestone.title : '',
      labels: issue.labels || [],
      assignees: (issue.assignees || []).map((a) => ({ username: a.username, name: a.name })),
      added_at: new Date().toISOString(),
    });
  }

  const newQueue = Array.from(existingMap.values());
  await saveQueue(newQueue);
  return newQueue.length;
}

/**
 * Take a batch of items from the queue (removes them).
 */
async function dequeue(batchSize) {
  const queue = await getQueue();
  const batch = queue.splice(0, batchSize);
  await saveQueue(queue);
  return batch;
}

async function getQueueSize() {
  const queue = await getQueue();
  return queue.length;
}

// ─── Last sync timestamp ───────────────────────────────────────────────────────

async function getLastSyncTime() {
  const store = await getBlobStore('sync-meta');
  if (store) {
    try {
      const data = await store.get('last-sync', { type: 'json' });
      if (data?.timestamp) return new Date(data.timestamp);
    } catch (e) {
      console.error(`[queue] Blob read last-sync error: ${e.message}`);
    }
  }
  try {
    if (fs.existsSync(META_FILE)) {
      const data = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
      if (data?.timestamp) return new Date(data.timestamp);
    }
  } catch (e) {}
  return null;
}

async function saveLastSyncTime(timestamp) {
  const data = { timestamp: timestamp.toISOString() };
  const store = await getBlobStore('sync-meta');
  if (store) {
    try {
      await store.setJSON('last-sync', data);
      return;
    } catch (e) {
      console.error(`[queue] Blob write last-sync error: ${e.message}`);
    }
  }
  try { fs.writeFileSync(META_FILE, JSON.stringify(data), 'utf8'); } catch (e) {}
}

module.exports = { initBlobContext, getQueue, saveQueue, enqueue, dequeue, getQueueSize, getLastSyncTime, saveLastSyncTime };
