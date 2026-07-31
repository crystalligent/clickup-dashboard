/**
 * Logs Monitor — Frontend for viewing GitLab→ClickUp sync history
 */

const LOGS_API = '/.netlify/functions/logs-store';
const SYNC_API = '/.netlify/functions/sync-gitlab';
const PAGE_SIZE = 30;

let allLogs = [];
let filteredLogs = [];
let currentPage = 1;

// ─── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadLogs();
});

// ─── Fetch Logs ────────────────────────────────────────────────────────────────

async function loadLogs() {
  showLoading(true);
  hideError();

  try {
    const res = await fetch(`${LOGS_API}?limit=500`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    allLogs = data.logs || [];
    document.getElementById('lastRefresh').textContent = `Updated ${formatTime(new Date())}`;

    updateKPIs();
    updateLastRunStatus();
    renderLogs();
  } catch (err) {
    showError(`Failed to load logs: ${err.message}`);
  } finally {
    showLoading(false);
  }
}

// ─── Manual Sync ───────────────────────────────────────────────────────────────

async function triggerManualSync() {
  const btn = document.getElementById('syncBtn');
  btn.classList.add('btn-syncing');
  btn.textContent = '⏳ Syncing...';

  try {
    const res = await fetch(SYNC_API);
    const data = await res.json();

    btn.textContent = `✅ Done (${data.synced || 0} issues)`;
    setTimeout(() => {
      btn.textContent = '⚡ Manual Sync';
      btn.classList.remove('btn-syncing');
    }, 3000);

    // Reload logs after sync
    setTimeout(loadLogs, 1500);
  } catch (err) {
    btn.textContent = '❌ Failed';
    setTimeout(() => {
      btn.textContent = '⚡ Manual Sync';
      btn.classList.remove('btn-syncing');
    }, 3000);
  }
}

// ─── Clear Logs ────────────────────────────────────────────────────────────────

async function clearLogs() {
  if (!confirm('Clear all sync logs? This cannot be undone.')) return;

  try {
    await fetch(LOGS_API, { method: 'DELETE' });
    allLogs = [];
    updateKPIs();
    renderLogs();
  } catch (err) {
    showError(`Failed to clear logs: ${err.message}`);
  }
}

// ─── KPIs ──────────────────────────────────────────────────────────────────────

function updateKPIs() {
  const total = allLogs.length;
  const success = allLogs.filter((l) => l.status === 'success').length;
  const errors = allLogs.filter((l) => l.status === 'error').length;
  const skipped = allLogs.filter((l) => l.status === 'skipped').length;
  const created = allLogs.filter((l) => l.action === 'created' && l.status === 'success').length;
  const updated = allLogs.filter((l) => l.action === 'updated' && l.status === 'success').length;

  document.getElementById('totalRuns').textContent = total;
  document.getElementById('successRuns').textContent = success;
  document.getElementById('errorRuns').textContent = errors;
  document.getElementById('skippedRuns').textContent = skipped;
  document.getElementById('createdCount').textContent = created;
  document.getElementById('updatedCount').textContent = updated;
}

function updateLastRunStatus() {
  const el = document.getElementById('lastRunStatus');
  if (allLogs.length === 0) {
    el.innerHTML = '<span class="status-dot status-dot-idle"></span><span>Last run: —</span>';
    return;
  }

  const last = allLogs[0];
  const dotClass = last.status === 'error' ? 'status-dot-error' : 'status-dot-active';
  const timeStr = formatRelativeTime(new Date(last.timestamp));

  el.innerHTML = `<span class="status-dot ${dotClass}"></span><span>Last run: ${timeStr} (${last.source})</span>`;
}

// ─── Filter & Render ───────────────────────────────────────────────────────────

function renderLogs() {
  const source = document.getElementById('filterSource').value;
  const status = document.getElementById('filterStatus').value;
  const action = document.getElementById('filterAction').value;
  const search = document.getElementById('filterSearch').value.toLowerCase();

  filteredLogs = allLogs.filter((log) => {
    if (source && log.source !== source) return false;
    if (status && log.status !== status) return false;
    if (action && log.action !== action) return false;
    if (search) {
      const searchStr = `${log.issueIid || ''} ${log.issueTitle || ''} ${log.clickupTaskId || ''} ${log.error || ''}`.toLowerCase();
      if (!searchStr.includes(search)) return false;
    }
    return true;
  });

  const logsSection = document.getElementById('logsSection');
  const emptyState = document.getElementById('emptyState');

  if (filteredLogs.length === 0 && allLogs.length === 0) {
    logsSection.style.display = 'none';
    emptyState.style.display = 'block';
    return;
  }

  logsSection.style.display = 'block';
  emptyState.style.display = 'none';

  document.getElementById('logsCount').textContent = `Showing ${filteredLogs.length} of ${allLogs.length} log entries`;

  // Paginate
  const totalPages = Math.ceil(filteredLogs.length / PAGE_SIZE);
  if (currentPage > totalPages) currentPage = 1;
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageItems = filteredLogs.slice(start, start + PAGE_SIZE);

  // Render entries
  const timeline = document.getElementById('logsTimeline');
  timeline.innerHTML = pageItems.map((log) => renderLogEntry(log)).join('');

  // Render pagination
  renderPagination(totalPages);
}

function renderLogEntry(log) {
  const sourceClass = `log-source-${log.source}`;
  const actionClass = `log-action-${log.action}`;
  const statusClass = `log-${log.status}`;

  const sourceIcon = log.source === 'webhook' ? '🔔' : log.source === 'scheduled' ? '⏰' : '👆';
  const actionIcon = log.action === 'created' ? '✨' : log.action === 'updated' ? '📝' : log.action === 'skipped' ? '⏭️' : '❌';

  const title = log.issueTitle
    ? `#${log.issueIid} — ${log.issueTitle}`
    : log.issueIid
      ? `Issue #${log.issueIid}`
      : log.action === 'error' ? 'Error occurred' : 'No issue data';

  const duration = log.duration ? `${log.duration}ms` : '';

  let details = '';
  if (log.clickupTaskId) {
    details += `<span class="log-detail"><span class="log-detail-label">Task:</span> <span class="log-detail-value">${log.clickupTaskId}</span></span>`;
  }
  if (log.clickupStatus) {
    details += `<span class="log-detail"><span class="log-detail-label">Status:</span> <span class="log-detail-value">${log.clickupStatus}</span></span>`;
  }
  if (log.milestone) {
    details += `<span class="log-detail"><span class="log-detail-label">Milestone:</span> <span class="log-detail-value">${log.milestone}</span></span>`;
  }
  if (duration) {
    details += `<span class="log-detail"><span class="log-detail-label">Duration:</span> <span class="log-duration">${duration}</span></span>`;
  }

  const labelsHtml = (log.labels && log.labels.length > 0)
    ? `<div class="log-labels">${log.labels.map((l) => `<span class="log-label-tag">${escapeHtml(l)}</span>`).join('')}</div>`
    : '';

  const errorHtml = log.error
    ? `<div class="log-error-msg">${escapeHtml(log.error)}</div>`
    : '';

  const expandedHtml = `
    <div class="log-expanded">
      <div class="log-detail-grid">
        <div class="log-detail-item"><label>Log ID</label><span>${log.id}</span></div>
        <div class="log-detail-item"><label>Source</label><span>${log.source}</span></div>
        <div class="log-detail-item"><label>Action</label><span>${log.action}</span></div>
        <div class="log-detail-item"><label>Timestamp</label><span>${new Date(log.timestamp).toLocaleString()}</span></div>
        ${log.clickupTaskId ? `<div class="log-detail-item"><label>ClickUp Task ID</label><span>${log.clickupTaskId}</span></div>` : ''}
        ${log.clickupStatus ? `<div class="log-detail-item"><label>ClickUp Status</label><span>${log.clickupStatus}</span></div>` : ''}
        ${log.milestone ? `<div class="log-detail-item"><label>Milestone ID</label><span>${log.milestone}</span></div>` : ''}
        ${log.duration ? `<div class="log-detail-item"><label>Duration</label><span>${log.duration}ms</span></div>` : ''}
        ${log.details ? `<div class="log-detail-item"><label>Details</label><span>${escapeHtml(log.details)}</span></div>` : ''}
      </div>
    </div>
  `;

  return `
    <div class="log-entry ${statusClass}" onclick="toggleExpand(this)">
      <div class="log-header">
        <div class="log-header-left">
          <span class="log-source ${sourceClass}">${sourceIcon} ${log.source}</span>
          <span class="log-action-badge ${actionClass}">${actionIcon} ${log.action}</span>
        </div>
        <span class="log-timestamp">${formatRelativeTime(new Date(log.timestamp))}</span>
      </div>
      <div class="log-body">
        <div class="log-issue-title">${escapeHtml(title)}</div>
        <div class="log-details-row">${details}</div>
        ${labelsHtml}
        ${errorHtml}
      </div>
      ${expandedHtml}
    </div>
  `;
}

function toggleExpand(el) {
  el.classList.toggle('expanded');
}

// ─── Pagination ────────────────────────────────────────────────────────────────

function renderPagination(totalPages) {
  const container = document.getElementById('logsPagination');
  if (totalPages <= 1) {
    container.innerHTML = '';
    return;
  }

  let html = '';
  if (currentPage > 1) {
    html += `<button class="page-btn" onclick="goToPage(${currentPage - 1})">← Prev</button>`;
  }

  for (let i = 1; i <= totalPages; i++) {
    if (i === currentPage) {
      html += `<button class="page-btn active">${i}</button>`;
    } else if (i === 1 || i === totalPages || Math.abs(i - currentPage) <= 2) {
      html += `<button class="page-btn" onclick="goToPage(${i})">${i}</button>`;
    } else if (Math.abs(i - currentPage) === 3) {
      html += `<span class="page-btn" style="border:none;background:none;">…</span>`;
    }
  }

  if (currentPage < totalPages) {
    html += `<button class="page-btn" onclick="goToPage(${currentPage + 1})">Next →</button>`;
  }

  container.innerHTML = html;
}

function goToPage(page) {
  currentPage = page;
  renderLogs();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatRelativeTime(date) {
  const now = new Date();
  const diff = now - date;

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return date.toLocaleDateString();
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showLoading(show) {
  document.getElementById('loading').style.display = show ? 'block' : 'none';
}

function showError(msg) {
  const el = document.getElementById('error');
  el.textContent = msg;
  el.style.display = 'block';
}

function hideError() {
  document.getElementById('error').style.display = 'none';
}
