/**
 * Queue Monitor — View pending sync items
 */

const QUEUE_API = '/.netlify/functions/queue-status';
const SYNC_API = '/.netlify/functions/sync-trigger';

// ─── Authentication ────────────────────────────────────────────────────────────

function getStoredPassword() {
  return sessionStorage.getItem('logs-auth') || '';
}

function authenticate() {
  var password = document.getElementById('loginPassword').value;
  if (!password) return;

  fetch(SYNC_API + '?verify=true', {
    headers: { 'X-Sync-Password': password }
  }).then(function(res) {
    if (res.status === 401) {
      document.getElementById('loginError').style.display = 'block';
      document.getElementById('loginPassword').value = '';
    } else {
      sessionStorage.setItem('logs-auth', password);
      document.getElementById('loginGate').style.display = 'none';
      document.getElementById('mainApp').style.display = 'block';
      loadQueue();
    }
  }).catch(function() {
    document.getElementById('loginError').style.display = 'block';
  });
}

function checkAuth() {
  var saved = sessionStorage.getItem('logs-auth');
  if (saved) {
    document.getElementById('loginGate').style.display = 'none';
    document.getElementById('mainApp').style.display = 'block';
    loadQueue();
    return true;
  }
  return false;
}

document.addEventListener('DOMContentLoaded', function() {
  if (!checkAuth()) {
    document.getElementById('loginGate').style.display = 'flex';
  }
});

// ─── Load Queue ────────────────────────────────────────────────────────────────

async function loadQueue() {
  document.getElementById('loading').style.display = 'block';
  document.getElementById('queueSection').style.display = 'none';
  document.getElementById('emptyState').style.display = 'none';

  try {
    var password = getStoredPassword();
    var res = await fetch(QUEUE_API, { headers: { 'X-Sync-Password': password } });

    if (res.status === 401) { sessionStorage.removeItem('logs-auth'); location.reload(); return; }

    var data = await res.json();
    var items = data.items || [];

    // Update summary
    var sizeEl = document.getElementById('queueSizeInfo');
    var etaEl = document.getElementById('etaInfo');
    var dotClass = items.length > 0 ? 'status-dot-active' : 'status-dot-idle';
    sizeEl.innerHTML = '<span class="status-dot ' + dotClass + '"></span><span>Queue: ' + items.length + ' items</span>';

    if (items.length > 0) {
      var batches = Math.ceil(items.length / 5);
      var minutes = batches * 5;
      etaEl.innerHTML = '<span>ETA: ~' + minutes + ' min (' + batches + ' batches remaining)</span>';
    } else {
      etaEl.innerHTML = '<span>ETA: done</span>';
    }

    if (items.length === 0) {
      document.getElementById('emptyState').style.display = 'block';
    } else {
      document.getElementById('queueSection').style.display = 'block';
      renderQueue(items);
    }
  } catch (err) {
    document.getElementById('emptyState').style.display = 'block';
  } finally {
    document.getElementById('loading').style.display = 'none';
  }
}

function renderQueue(items) {
  var tbody = document.getElementById('queueBody');
  tbody.innerHTML = items.map(function(item, idx) {
    var labels = (item.labels || []).map(function(l) {
      var name = typeof l === 'string' ? l : l.title || l;
      return '<span class="log-label-tag">' + escapeHtml(name) + '</span>';
    }).join('');

    var assignee = (item.assignees && item.assignees.length > 0)
      ? escapeHtml(item.assignees[0].name || item.assignees[0].username)
      : '—';

    var added = item.added_at ? formatRelativeTime(new Date(item.added_at)) : '—';

    return '<tr id="row-' + item.iid + '">' +
      '<td>' + (idx + 1) + '</td>' +
      '<td><strong>' + item.iid + '</strong></td>' +
      '<td><a href="' + escapeHtml(item.web_url) + '" target="_blank" class="task-link">' + escapeHtml(truncate(item.title, 60)) + '</a></td>' +
      '<td>' + escapeHtml(item.milestone_name || '—') + '</td>' +
      '<td>' + escapeHtml(item.state || '—') + '</td>' +
      '<td>' + labels + '</td>' +
      '<td>' + assignee + '</td>' +
      '<td>' + added + '</td>' +
      '<td><button class="btn btn-sm btn-primary" onclick="syncNow(' + item.iid + ', this)">Sync now</button></td>' +
      '</tr>';
  }).join('');
}

// ─── Sync Single from Queue ────────────────────────────────────────────────────

async function syncNow(iid, btn) {
  btn.disabled = true;
  btn.textContent = '\u23F3...';

  try {
    var password = getStoredPassword();

    // Get the issue URL from the queue item
    var res = await fetch(QUEUE_API, { headers: { 'X-Sync-Password': password } });
    var data = await res.json();
    var item = (data.items || []).find(function(i) { return i.iid === iid; });

    if (!item) { btn.textContent = 'Gone'; return; }

    // Sync via sync-single
    var syncRes = await fetch('/.netlify/functions/sync-single?url=' + encodeURIComponent(item.web_url), {
      headers: { 'X-Sync-Password': password }
    });
    var syncData = await syncRes.json();

    if (syncRes.ok) {
      // Remove from queue
      await fetch('/.netlify/functions/queue-status?remove=' + iid, {
        method: 'PATCH',
        headers: { 'X-Sync-Password': password }
      });

      // Remove row from table
      var row = document.getElementById('row-' + iid);
      if (row) row.remove();

      // Update queue size display
      loadQueue();
    } else {
      btn.textContent = '\u274C';
      setTimeout(function() { btn.textContent = 'Sync now'; btn.disabled = false; }, 3000);
    }
  } catch (err) {
    btn.textContent = '\u274C';
    setTimeout(function() { btn.textContent = 'Sync now'; btn.disabled = false; }, 3000);
  }
}

// ─── Process Now (manual trigger) ──────────────────────────────────────────────

async function processNow() {
  var btn = document.getElementById('processBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Processing...';

  try {
    var password = getStoredPassword();
    var res = await fetch('/.netlify/functions/run-queue', {
      headers: { 'X-Sync-Password': password }
    });

    // Handle non-JSON responses (e.g., Netlify 403 HTML pages)
    var contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      var text = await res.text();
      alert('Error ' + res.status + ': ' + text.substring(0, 200));
      btn.disabled = false;
      btn.textContent = '⚡ Process Now';
      return;
    }

    var data = await res.json();

    if (res.ok) {
      var msg = 'Processed: ' + data.processed + ' | Remaining: ' + data.remaining;
      if (data.duration) msg += ' | Duration: ' + (data.duration / 1000).toFixed(1) + 's';
      if (data.results) {
        var errors = data.results.filter(function(r) { return r.error; });
        if (errors.length > 0) msg += '\n\nErrors:\n' + errors.map(function(e) { return '#' + e.iid + ': ' + e.error; }).join('\n');
      }
      alert(msg);
      loadQueue();
    } else {
      alert('Error ' + res.status + ': ' + (data.error || JSON.stringify(data)));
    }
  } catch (err) {
    alert('Request failed: ' + err.message);
  }

  btn.disabled = false;
  btn.textContent = '⚡ Process Now';
}

// ─── Clear Queue ───────────────────────────────────────────────────────────────

async function clearQueue() {
  if (!confirm('Clear all queued items? They will not be synced.')) return;

  var btn = document.getElementById('clearBtn');
  btn.disabled = true;

  try {
    var password = getStoredPassword();
    await fetch(QUEUE_API, { method: 'DELETE', headers: { 'X-Sync-Password': password } });
    loadQueue();
  } catch (e) {}

  btn.disabled = false;
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

function truncate(str, len) { return str && str.length > len ? str.substring(0, len) + '...' : str || ''; }

function formatRelativeTime(date) {
  var diff = new Date() - date;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return date.toLocaleDateString();
}

function escapeHtml(text) {
  if (!text) return '';
  var d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}
