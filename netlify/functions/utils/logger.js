/**
 * Shared logger utility.
 * 
 * In production: POSTs logs to the logs-store function via HTTP (same site).
 * This ensures consistent storage since logs-store manages the blob store.
 * 
 * In local dev: writes to /tmp file directly.
 */

const path = require('path');
const fs = require('fs');

const MAX_LOGS = 500;
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

  // In production: POST to the logs-store function endpoint
  const siteUrl = process.env.URL || process.env.DEPLOY_URL || '';
  if (siteUrl) {
    try {
      const res = await fetch(`${siteUrl}/.netlify/functions/logs-store`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(logEntry),
      });
      if (res.ok) return;
      console.log(`[sync-log] POST to logs-store failed: ${res.status}`);
    } catch (e) {
      console.log(`[sync-log] POST to logs-store error: ${e.message}`);
    }
  }

  // Local dev fallback: write directly to /tmp file
  let logs = readLocalLogs();
  logs.unshift(logEntry);
  if (logs.length > MAX_LOGS) logs = logs.slice(0, MAX_LOGS);
  writeLocalLogs(logs);
}

module.exports = { logRun, readLocalLogs, writeLocalLogs, LOCAL_LOG_FILE };
