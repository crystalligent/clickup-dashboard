/**
 * Logs Monitor — Frontend for viewing GitLab to ClickUp sync history
 */

const LOGS_API = '/.netlify/functions/logs-store';
const SYNC_API = '/.netlify/functions/sync-trigger';
const PAGE_SIZE = 30;

let allLogs = [];
let filteredLogs = [];
let currentPage = 1;

// ─── Authentication ────────────────────────────────────────────────────────────

function getStoredPassword() {
  return sessionStorage.getItem('logs-auth') || '';
}

function authenticate() {
  const password = document.getElementById('loginPassword').value;
  if (!password) return;

  // Verify against server
  fetch(`${SYNC_API}?verify=true`, {
    headers: { 'X-Sync-Password': password }
  }).then((res) => {
    if (res.status === 401) {
      document.getElementById('loginError').style.display = 'block';
      document.getElementById('loginPassword').value = '';
    } else {
      sessionStorage.setItem('logs-auth', password);
      document.getElementById('loginGate').style.display = 'none';
      document.getElementById('mainApp').style.display = 'block';
      loadLogs();
    }
  }).catch(() => {
    document.getElementById('loginError').style.display = 'block';
  });
}

function checkAuth() {
  const saved = sessionStorage.getItem('logs-auth');
  if (saved) {
    document.getElementById('loginGate').style.display = 'none';
    document.getElementById('mainApp').style.display = 'block';
    loadLogs();
    return true;
  }
  return false;
}

// ─── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  if (!checkAuth()) {
    document.getElementById('loginGate').style.display = 'flex';
  }
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

// ─── Sync Actions ──────────────────────────────────────────────────────────────

async function triggerManualSync() {
  await doSync('syncBtn', SYNC_API, 'Manual Sync');
}

async function triggerFullSync() {
  if (!confirm('This will sync ALL issues across all milestones. Continue?')) return;
  await doSync('fullSyncBtn', `${SYNC_API}?full=true`, 'Sync All');
}

function showDateSync() {
  document.getElementById('dateSyncPanel').style.display = 'block';
  document.getElementById('singleSyncPanel').style.display = 'none';
}

function hideDateSync() {
  document.getElementById('dateSyncPanel').style.display = 'none';
}

function showSingleSync() {
  document.getElementById('singleSyncPanel').style.display = 'block';
  document.getElementById('dateSyncPanel').style.display = 'none';
}

function hideSingleSync() {
  document.getElementById('singleSyncPanel').style.display = 'none';
}

async function triggerSingleSync() {
  const urlInput = document.getElementById('singleIssueUrl').value.trim();
  if (!urlInput) { alert('Please enter a GitLab issue URL.'); return; }
  if (!urlInput.includes('/-/issues/')) { alert('Invalid URL. Must be a GitLab issue URL (contains /-/issues/).'); return; }

  var btn = document.getElementById('singleSyncBtn');
  btn.disabled = true;
  btn.textContent = '\u23F3 Syncing...';

  try {
    const password = getStoredPassword();
    const res = await fetch('/.netlify/functions/sync-single?url=' + encodeURIComponent(urlInput), {
      headers: { 'X-Sync-Password': password }
    });

    if (res.status === 401) { sessionStorage.removeItem('logs-auth'); location.reload(); return; }

    const data = await res.json();
    if (res.ok) {
      btn.textContent = '\u2705 ' + (data.action === 'created' ? 'Created' : 'Updated') + ' #' + data.iid;
    } else {
      btn.textContent = '\u274C ' + (data.error || 'Failed');
    }
    setTimeout(() => { btn.textContent = '\uD83D\uDE80 Sync Issue'; btn.disabled = false; }, 4000);
    setTimeout(loadLogs, 1500);
  } catch (err) {
    btn.textContent = '\u274C Failed';
    setTimeout(() => { btn.textContent = '\uD83D\uDE80 Sync Issue'; btn.disabled = false; }, 3000);
  }
}

async function triggerDateSync() {
  const dateInput = document.getElementById('syncFromDate').value;
  if (!dateInput) {
    alert('Please select a date.');
    return;
  }
  await doSync('dateSyncBtn', `${SYNC_API}?since=${dateInput}`, 'Run Sync');
}

async function doSync(btnId, url, label) {
  var allBtns = ['syncBtn', 'fullSyncBtn', 'dateSyncBtn'];
  allBtns.forEach(function(id) { var b = document.getElementById(id); if (b) b.disabled = true; });

  const btn = document.getElementById(btnId);
  btn.classList.add('btn-syncing');
  btn.textContent = '\u23F3 Syncing...';

  function enableButtons() {
    allBtns.forEach(function(id) { var b = document.getElementById(id); if (b) b.disabled = false; });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);

    const password = getStoredPassword();
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'X-Sync-Password': password }
    });
    clearTimeout(timeout);

    if (res.status === 401) {
      sessionStorage.removeItem('logs-auth');
      location.reload();
      return;
    }

    let data = {};
    const text = await res.text();
    if (text) {
      try { data = JSON.parse(text); } catch (e) { /* ignore */ }
    }

    const count = data.created || data.synced || '\u2713';
    btn.textContent = '\u2705 Done (' + count + ' synced)';
    setTimeout(() => {
      btn.textContent = getButtonLabel(btnId);
      btn.classList.remove('btn-syncing');
      enableButtons();
    }, 3000);

    setTimeout(loadLogs, 1500);
  } catch (err) {
    if (err.name === 'AbortError') {
      btn.textContent = '\u23F3 Still running...';
      setTimeout(() => {
        btn.textContent = getButtonLabel(btnId);
        btn.classList.remove('btn-syncing');
        enableButtons();
        loadLogs();
      }, 5000);
    } else {
      btn.textContent = '\u274C Failed';
      setTimeout(() => {
        btn.textContent = getButtonLabel(btnId);
        btn.classList.remove('btn-syncing');
        enableButtons();
      }, 3000);
    }
    setTimeout(loadLogs, 2000);
  }
}

function getButtonLabel(btnId) {
  if (btnId === 'syncBtn') return '\u26A1 Manual Sync';
  if (btnId === 'fullSyncBtn') return '\uD83D\uDD04 Sync All';
  if (btnId === 'dateSyncBtn') return '\uD83D\uDE80 Run Sync';
  return 'Sync';
}

// ─── Remove Duplicates ─────────────────────────────────────────────────────────

async function removeDuplicates() {
  if (!confirm('This will delete duplicate ClickUp tasks (keeps oldest copy of each). Continue?')) return;

  var btn = document.getElementById('dedupBtn');
  btn.disabled = true;
  btn.textContent = '\u23F3 Cleaning...';

  try {
    const password = getStoredPassword();
    const res = await fetch('/.netlify/functions/dedup-tasks', {
      headers: { 'X-Sync-Password': password }
    });

    if (res.status === 401) { sessionStorage.removeItem('logs-auth'); location.reload(); return; }

    const data = await res.json();
    btn.textContent = '\u2705 Removed ' + (data.duplicatesRemoved || 0) + ' duplicates';
    setTimeout(() => { btn.textContent = '\uD83E\uDDF9 Remove Duplicates'; btn.disabled = false; }, 4000);
  } catch (err) {
    btn.textContent = '\u274C Failed';
    setTimeout(() => { btn.textContent = '\uD83E\uDDF9 Remove Duplicates'; btn.disabled = false; }, 3000);
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
    el.innerHTML = '<span class="status-dot status-dot-idle"></span><span>Last run: \u2014</span>';
    return;
  }

  const last = allLogs[0];
  const dotClass = last.status === 'error' ? 'status-dot-error' : 'status-dot-active';
  const timeStr = formatRelativeTime(new Date(last.timestamp));
  el.innerHTML = '<span class="status-dot ' + dotClass + '"></span><span>Last run: ' + timeStr + ' (' + last.source + ')</span>';
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
      const searchStr = (log.issueIid || '') + ' ' + (log.issueTitle || '') + ' ' + (log.clickupTaskId || '') + ' ' + (log.error || '');
      if (!searchStr.toLowerCase().includes(search)) return false;
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

  document.getElementById('logsCount').textContent = 'Showing ' + filteredLogs.length + ' of ' + allLogs.length + ' log entries';

  const totalPages = Math.ceil(filteredLogs.length / PAGE_SIZE);
  if (currentPage > totalPages) currentPage = 1;
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageItems = filteredLogs.slice(start, start + PAGE_SIZE);

  const timeline = document.getElementById('logsTimeline');
  timeline.innerHTML = pageItems.map((log) => renderLogEntry(log)).join('');
  renderPagination(totalPages);
}

function renderLogEntry(log) {
  const statusClass = 'log-' + log.status;
  const sourceIcon = log.source === 'webhook' ? '\uD83D\uDD14' : log.source === 'scheduled' ? '\u23F0' : '\uD83D\uDC46';
  const actionIcon = log.action === 'created' ? '\u2728' : log.action === 'updated' ? '\uD83D\uDCDD' : log.action === 'skipped' ? '\u23ED\uFE0F' : '\u274C';

  const title = log.issueTitle
    ? '#' + log.issueIid + ' \u2014 ' + log.issueTitle
    : log.issueIid
      ? 'Issue #' + log.issueIid
      : log.action === 'error' ? 'Error occurred' : 'No issue data';

  const duration = log.duration ? log.duration + 'ms' : '';

  let details = '';
  if (log.clickupTaskId) details += '<span class="log-detail"><span class="log-detail-label">Task:</span> <span class="log-detail-value">' + log.clickupTaskId + '</span></span>';
  if (log.clickupStatus) details += '<span class="log-detail"><span class="log-detail-label">Status:</span> <span class="log-detail-value">' + log.clickupStatus + '</span></span>';
  if (log.milestone) details += '<span class="log-detail"><span class="log-detail-label">Milestone:</span> <span class="log-detail-value">' + log.milestone + '</span></span>';
  if (duration) details += '<span class="log-detail"><span class="log-detail-label">Duration:</span> <span class="log-duration">' + duration + '</span></span>';

  const labelsHtml = (log.labels && log.labels.length > 0)
    ? '<div class="log-labels">' + log.labels.map((l) => '<span class="log-label-tag">' + escapeHtml(l) + '</span>').join('') + '</div>'
    : '';

  const errorHtml = log.error ? '<div class="log-error-msg">' + escapeHtml(log.error) + '</div>' : '';

  return '<div class="log-entry ' + statusClass + '" onclick="toggleExpand(this)">' +
    '<div class="log-header"><div class="log-header-left">' +
    '<span class="log-source log-source-' + log.source + '">' + sourceIcon + ' ' + log.source + '</span>' +
    '<span class="log-action-badge log-action-' + log.action + '">' + actionIcon + ' ' + log.action + '</span>' +
    '</div><span class="log-timestamp">' + formatRelativeTime(new Date(log.timestamp)) + '</span></div>' +
    '<div class="log-body"><div class="log-issue-title">' + escapeHtml(title) + '</div>' +
    '<div class="log-details-row">' + details + '</div>' + labelsHtml + errorHtml + '</div>' +
    '<div class="log-expanded"><div class="log-detail-grid">' +
    '<div class="log-detail-item"><label>Log ID</label><span>' + log.id + '</span></div>' +
    '<div class="log-detail-item"><label>Timestamp</label><span>' + new Date(log.timestamp).toLocaleString() + '</span></div>' +
    (log.clickupTaskId ? '<div class="log-detail-item"><label>ClickUp Task</label><span>' + log.clickupTaskId + '</span></div>' : '') +
    (log.clickupStatus ? '<div class="log-detail-item"><label>Status Set</label><span>' + log.clickupStatus + '</span></div>' : '') +
    (log.duration ? '<div class="log-detail-item"><label>Duration</label><span>' + log.duration + 'ms</span></div>' : '') +
    '</div></div></div>';
}

function toggleExpand(el) { el.classList.toggle('expanded'); }

// ─── Pagination ────────────────────────────────────────────────────────────────

function renderPagination(totalPages) {
  const container = document.getElementById('logsPagination');
  if (totalPages <= 1) { container.innerHTML = ''; return; }

  let html = '';
  if (currentPage > 1) html += '<button class="page-btn" onclick="goToPage(' + (currentPage - 1) + ')">\u2190 Prev</button>';
  for (let i = 1; i <= totalPages; i++) {
    if (i === currentPage) html += '<button class="page-btn active">' + i + '</button>';
    else if (i === 1 || i === totalPages || Math.abs(i - currentPage) <= 2) html += '<button class="page-btn" onclick="goToPage(' + i + ')">' + i + '</button>';
    else if (Math.abs(i - currentPage) === 3) html += '<span class="page-btn" style="border:none;background:none;">\u2026</span>';
  }
  if (currentPage < totalPages) html += '<button class="page-btn" onclick="goToPage(' + (currentPage + 1) + ')">Next \u2192</button>';
  container.innerHTML = html;
}

function goToPage(page) { currentPage = page; renderLogs(); window.scrollTo({ top: 0, behavior: 'smooth' }); }

// ─── Utilities ─────────────────────────────────────────────────────────────────

function formatTime(date) { return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

function formatRelativeTime(date) {
  const diff = new Date() - date;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
  return date.toLocaleDateString();
}

function escapeHtml(text) {
  if (!text) return '';
  var d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function showLoading(show) { document.getElementById('loading').style.display = show ? 'block' : 'none'; }
function showError(msg) { var e = document.getElementById('error'); e.textContent = msg; e.style.display = 'block'; }
function hideError() { document.getElementById('error').style.display = 'none'; }
