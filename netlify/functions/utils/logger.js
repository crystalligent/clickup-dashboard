/**
 * Shared logger utility — writes to Netlify Blobs in production,
 * falls back to a local JSON file in dev.
 */

const path = require('path');
const fs = require('fs');

const MAX_LOGS = 500;
const STORE_NAME = 'sync-logs';
const INDEX_KEY = 'log-index';
const LOCAL_LOG_FILE = path.join('/tmp', 'clickup-sync-logs.json');

// ─── Local file helpers ────────────────────────────────────────────────────────

function readLocalLogs() {
  try {
    if (fs.existsSync(LOCAL_LOG_FILE)) {
      return JSON.parse(fs.readFileSync(LOCAL_LOG_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return [];
}

function writeLocalLogs(logs) {
  fs.writeFileSync(LOCAL_LOG_FILE, JSON.stringify(logs), 'utf8');
}

// ─── Main logRun function ──────────────────────────────────────────────────────

async function logRun(entry) {
  const logEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    source: entry.source || 'unknown',
    action: entry.action || 'unknown',
    status: entry.status || 'success',
    duration: entry.duration || null,
    issueIid: entry.issueIid || null,
    issueTitle: entry.issueTitle || null,
    clickupTaskId: entry.clickupTaskId || null,
    clickupStatus: entry.clickupStatus || null,
    milestone: entry.milestone || null,
    labels: entry.labels || [],
    error: entry.error || null,
    details: entry.details || null,
  };

  console.log(`[sync-log] ${logEntry.source} | ${logEntry.action} | ${logEntry.status} | issue #${logEntry.issueIid || '-'}`);

  // Try Netlify Blobs first (production)
  try {
    const { getStore } = require('@netlify/blobs');
    const store = getStore(STORE_NAME);
    let logs = [];
    try {
      logs = (await store.get(INDEX_KEY, { type: 'json' })) || [];
    } catch (e) {
      logs = [];
    }
    logs.unshift(logEntry);
    if (logs.length > MAX_LOGS) logs = logs.slice(0, MAX_LOGS);
    await store.setJSON(INDEX_KEY, logs);
    return;
  } catch (e) {
    // Blobs not available — use local file
  }

  // Local dev fallback: write to /tmp file
  let logs = readLocalLogs();
  logs.unshift(logEntry);
  if (logs.length > MAX_LOGS) logs = logs.slice(0, MAX_LOGS);
  writeLocalLogs(logs);
}

module.exports = { logRun, readLocalLogs, writeLocalLogs, LOCAL_LOG_FILE };
