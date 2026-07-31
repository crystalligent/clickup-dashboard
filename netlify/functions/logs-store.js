/**
 * Logs Store — Persistent run history
 * 
 * Uses Netlify Blobs in production, falls back to local /tmp file in dev.
 * 
 * GET  → returns recent logs (query: ?limit=50)
 * POST → stores a new log entry
 * DELETE → clears all logs
 */

const { readLocalLogs, writeLocalLogs } = require('./utils/logger');

const MAX_LOGS = 500;

// ─── Storage ───────────────────────────────────────────────────────────────────

async function getLogs() {
  try {
    const { getStore } = require('@netlify/blobs');
    const store = getStore('sync-logs');
    const data = await store.get('log-index', { type: 'json' });
    return data || [];
  } catch (e) {
    console.log('[logs-store] Blobs read failed:', e.message);
    return readLocalLogs();
  }
}

async function saveLogs(logs) {
  try {
    const { getStore } = require('@netlify/blobs');
    const store = getStore('sync-logs');
    await store.setJSON('log-index', logs);
  } catch (e) {
    console.log('[logs-store] Blobs write failed:', e.message);
    writeLocalLogs(logs);
  }
}

// ─── Handler ───────────────────────────────────────────────────────────────────

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return jsonResponse(204, '');
  }

  // ─── GET: Retrieve logs ────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    try {
      const limit = parseInt(event.queryStringParameters?.limit || '50', 10);
      const source = event.queryStringParameters?.source || '';
      const status = event.queryStringParameters?.status || '';

      let logs = await getLogs();

      if (source) logs = logs.filter((l) => l.source === source);
      if (status) logs = logs.filter((l) => l.status === status);

      logs = logs.slice(0, limit);
      return jsonResponse(200, { total: logs.length, logs });
    } catch (err) {
      return jsonResponse(200, { total: 0, logs: [] });
    }
  }

  // ─── POST: Store a new log entry ──────────────────────────────────
  if (event.httpMethod === 'POST') {
    try {
      const entry = JSON.parse(event.body);

      if (!entry.source || !entry.action) {
        return jsonResponse(400, { error: 'Missing source or action' });
      }

      const logEntry = {
        id: entry.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: entry.timestamp || new Date().toISOString(),
        source: entry.source,
        action: entry.action,
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

      let logs = await getLogs();
      logs.unshift(logEntry);
      if (logs.length > MAX_LOGS) logs = logs.slice(0, MAX_LOGS);
      await saveLogs(logs);

      return jsonResponse(201, { stored: true, id: logEntry.id });
    } catch (err) {
      return jsonResponse(500, { error: err.message });
    }
  }

  // ─── DELETE: Clear all logs ────────────────────────────────────────
  if (event.httpMethod === 'DELETE') {
    try {
      await saveLogs([]);
      return jsonResponse(200, { cleared: true });
    } catch (err) {
      return jsonResponse(500, { error: err.message });
    }
  }

  return jsonResponse(405, { error: 'Method not allowed' });
};
