/**
 * Sync by URL — Frontend for syncing a single GitLab issue to ClickUp.
 * Calls /.netlify/functions/sync-single?url=<encoded_url>
 */

const SYNC_API = '/.netlify/functions/sync-single';
let syncHistory = [];

// ─── Authentication ─────────────────────────────────────────────

function getStoredPassword() {
    return sessionStorage.getItem('sync-auth') || '';
}

function authenticate() {
    const password = document.getElementById('loginPassword').value;
    if (!password) return;

    // Verify password by making a test call
    fetch(SYNC_API + '?url=verify', {
        headers: { 'X-Sync-Password': password }
    }).then(function (res) {
        if (res.status === 401) {
            document.getElementById('loginError').style.display = 'block';
            document.getElementById('loginPassword').value = '';
        } else {
            // Password accepted (even if the URL was invalid, 400/500 means auth passed)
            sessionStorage.setItem('sync-auth', password);
            document.getElementById('loginGate').style.display = 'none';
            document.getElementById('mainApp').style.display = 'block';
        }
    }).catch(function () {
        document.getElementById('loginError').style.display = 'block';
    });
}

function checkAuth() {
    const saved = sessionStorage.getItem('sync-auth');
    if (saved) {
        document.getElementById('loginGate').style.display = 'none';
        document.getElementById('mainApp').style.display = 'block';
        return true;
    }
    return false;
}

// ─── Sync Issue ─────────────────────────────────────────────────

async function syncIssue() {
    const urlInput = document.getElementById('issueUrl').value.trim();

    if (!urlInput) {
        alert('Please enter a GitLab issue URL.');
        return;
    }

    if (!urlInput.includes('/-/issues/')) {
        alert('Invalid URL. Must be a GitLab issue URL (contains /-/issues/).');
        return;
    }

    const btn = document.getElementById('syncBtn');
    btn.disabled = true;
    btn.textContent = '⏳ Syncing...';

    showResult('loading', 'Syncing...', `Fetching issue from GitLab and syncing to ClickUp...<br><code>${escapeHtml(urlInput)}</code>`);

    try {
        const password = getStoredPassword();
        const res = await fetch(SYNC_API + '?url=' + encodeURIComponent(urlInput), {
            headers: { 'X-Sync-Password': password }
        });

        if (res.status === 401) {
            sessionStorage.removeItem('sync-auth');
            location.reload();
            return;
        }

        const data = await res.json();

        if (res.ok) {
            const action = data.action === 'created' ? 'Created' : 'Updated';
            const icon = data.action === 'created' ? '✅' : '🔄';
            const duration = data.duration ? ` in ${(data.duration / 1000).toFixed(1)}s` : '';

            showResult('success', `${icon} Task ${action}!`,
                `<strong>#${data.iid}</strong> — ${escapeHtml(data.title)}<br>` +
                `Status: <strong>${escapeHtml(data.status)}</strong>${duration}`
            );

            addToHistory({
                action: data.action,
                iid: data.iid,
                title: data.title,
                status: data.status,
                url: urlInput,
                time: new Date()
            });

            // Clear input on success
            document.getElementById('issueUrl').value = '';
        } else {
            showResult('error', '❌ Sync Failed', escapeHtml(data.error || 'Unknown error'));
            addToHistory({
                action: 'error',
                iid: extractIidFromUrl(urlInput),
                title: data.error || 'Failed',
                url: urlInput,
                time: new Date()
            });
        }
    } catch (err) {
        showResult('error', '❌ Request Failed', escapeHtml(err.message));
        addToHistory({
            action: 'error',
            iid: extractIidFromUrl(urlInput),
            title: err.message,
            url: urlInput,
            time: new Date()
        });
    }

    btn.disabled = false;
    btn.textContent = '🚀 Sync Issue';
}

// ─── UI Helpers ─────────────────────────────────────────────────

function showResult(type, title, detail) {
    const section = document.getElementById('resultSection');
    const container = document.getElementById('syncResult');
    section.style.display = 'block';

    const iconMap = { success: '✅', error: '❌', loading: '⏳' };
    const icon = iconMap[type] || '📋';

    container.className = 'sync-result result-' + type;
    container.innerHTML = `
        <div class="sync-result-icon">${icon}</div>
        <div class="sync-result-body">
            <div class="sync-result-title">${title}</div>
            <div class="sync-result-detail">${detail}</div>
        </div>
    `;
}

function addToHistory(entry) {
    syncHistory.unshift(entry);
    renderHistory();
}

function clearHistory() {
    syncHistory = [];
    renderHistory();
}

function renderHistory() {
    const container = document.getElementById('syncHistory');

    if (syncHistory.length === 0) {
        container.innerHTML = '<div class="sync-empty">No syncs performed yet in this session.</div>';
        return;
    }

    container.innerHTML = syncHistory.map(entry => {
        const icon = entry.action === 'created' ? '✅' : entry.action === 'updated' ? '🔄' : '❌';
        const badgeClass = entry.action === 'created' ? 'history-badge-created' :
            entry.action === 'updated' ? 'history-badge-updated' : 'history-badge-error';
        const badgeText = entry.action === 'created' ? 'Created' :
            entry.action === 'updated' ? 'Updated' : 'Error';
        const timeStr = formatTime(entry.time);

        return `<div class="sync-history-item">
            <span class="history-icon">${icon}</span>
            <div class="history-body">
                <div class="history-title">#${entry.iid || '?'} — ${escapeHtml(entry.title || '')}</div>
                <div class="history-meta">${entry.status ? 'Status: ' + escapeHtml(entry.status) : ''}</div>
            </div>
            <span class="history-badge ${badgeClass}">${badgeText}</span>
            <span class="history-time">${timeStr}</span>
        </div>`;
    }).join('');
}

function extractIidFromUrl(url) {
    const parts = url.split('/-/issues/');
    if (parts.length === 2) {
        return parts[1].replace(/\/$/, '');
    }
    return '?';
}

function formatTime(date) {
    if (!date) return '';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ─── Init ───────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function () {
    if (!checkAuth()) {
        document.getElementById('loginGate').style.display = 'flex';
    }

    // Allow Enter key to trigger sync
    document.getElementById('issueUrl')?.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') syncIssue();
    });
});
