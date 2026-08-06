/**
 * Queue utility — stores pending issue syncs in Netlify Blobs or local /tmp.
 * 
 * Queue item format:
 * { iid, title, web_url, description, state, milestone_id, milestone_name, labels, assignees, added_at }
 */

const fs = require('fs');
const path = require('path');

const QUEUE_FILE = path.join('/tmp', 'sync-queue.json');
const META_FILE = path.join('/tmp', 'sync-meta.json');

// ─── Blob helpers ──────────────────────────────────────────────────────────────

async function getBlobStore(name) {
  try {
    const { getStore } = require('@netlify/blobs');
    return getStore(name);
  } catch (e) {
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
    } catch (e) { return []; }
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
    try { await store.setJSON('pending', queue); return; } catch (e) {}
  }
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
    } catch (e) {}
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
    try { await store.setJSON('last-sync', data); } catch (e) {}
  }
  try { fs.writeFileSync(META_FILE, JSON.stringify(data), 'utf8'); } catch (e) {}
}

module.exports = { getQueue, saveQueue, enqueue, dequeue, getQueueSize, getLastSyncTime, saveLastSyncTime };
