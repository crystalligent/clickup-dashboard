// ============================================================
// Sign-off dashboard (shared) — Developer / QA progress tracker
//
// Each HTML page sets `window.SIGNOFF_ROLE = 'Developer'` or 'QA'
// before loading this script. The dashboard attributes each ticket to
// the person assigned in that role's row of the "Sign-off" checklist.
// ============================================================

const DEFAULT_LIST_ID = '901616211048'; // list that carries the Sign-off checklists
const CHECKLIST_NAME = 'Sign-off';
const ROLE = (window.SIGNOFF_ROLE || 'Developer');
const ROLE_RE = ROLE === 'QA' ? /^QA\b/i : /^Developer\b/i;

// Concurrency for per-task checklist fetches (throttle to be nice to ClickUp)
const FETCH_CONCURRENCY = 6;

// Status phase grouping (for the per-person progress bar / stage view)
const STATUS_PHASES = {
    'open': 'Backlog',
    'pending review (qa)': 'Backlog',
    'ongoing dev': 'Development',
    'done development': 'Development',
    'testing: failed': 'Testing',
    'for verification': 'Testing',
    'for testing in hotfix': 'Testing',
    'ongoing testing': 'Testing',
    'for deployment to hotfix': 'Release',
    'for release': 'Release',
    'released to prod': 'Done',
    'resolved - no code changes': 'Done',
    'closed': 'Done',
};
const PHASE_COLORS = {
    Backlog: '#5a6e82',
    Development: '#b660e0',
    Testing: '#4da6ff',
    Release: '#ffb547',
    Done: '#00d68f',
    Other: '#7c6cf0',
};

// --- Proxy fetch ---

function getApiBase() {
    if (window.location.hostname !== '' && window.location.protocol !== 'file:') {
        return '/.netlify/functions/clickup-proxy?path=';
    }
    return null;
}

async function clickupFetch(apiPath) {
    const proxyBase = getApiBase();
    if (proxyBase) {
        return fetch(proxyBase + encodeURIComponent(apiPath));
    }
    throw new Error('This dashboard must be hosted on Netlify to access ClickUp data.');
}

// --- State ---

let allTasks = [];        // attributed tasks (before exclusion)
let tasks = [];           // after exclusion
let excluded = new Set();
let chartInstances = {};
let currentSort = { field: 'updated', direction: 'desc' };
let currentPage = 1;
const PAGE_SIZE = 25;

// --- Config ---

function getConfig() {
    return { listId: localStorage.getItem('signoff_list_id') || DEFAULT_LIST_ID };
}
function loadConfig() {
    const el = document.getElementById('listId');
    if (el) el.value = getConfig().listId;
}
function saveConfig() {
    const listId = document.getElementById('listId').value.trim();
    if (!listId) return;
    localStorage.setItem('signoff_list_id', listId);
    toggleConfig();
    fetchData();
}
function toggleConfig() {
    const panel = document.getElementById('configPanel');
    if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

// --- Date range ---

function formatDate(d) { return d.toISOString().split('T')[0]; }

function setPreset(preset, btn) {
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');

    const now = new Date();
    let from, to;
    switch (preset) {
        case 'this-month': from = new Date(now.getFullYear(), now.getMonth(), 1); to = now; break;
        case 'last-month': from = new Date(now.getFullYear(), now.getMonth() - 1, 1); to = new Date(now.getFullYear(), now.getMonth(), 0); break;
        case 'this-week': { const d = now.getDay(); from = new Date(now); from.setDate(now.getDate() - (d === 0 ? 6 : d - 1)); to = now; break; }
        case 'last-week': { const d = now.getDay(); const lm = new Date(now); lm.setDate(now.getDate() - (d === 0 ? 6 : d - 1) - 7); from = lm; to = new Date(lm); to.setDate(lm.getDate() + 6); break; }
        case 'last-7': from = new Date(now); from.setDate(now.getDate() - 7); to = now; break;
        case 'last-14': from = new Date(now); from.setDate(now.getDate() - 14); to = now; break;
        case 'last-30': from = new Date(now); from.setDate(now.getDate() - 30); to = now; break;
        case 'custom': return;
    }
    document.getElementById('dateFrom').value = formatDate(from);
    document.getElementById('dateTo').value = formatDate(to);
    fetchData();
}

function onDateChange() {
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
}

// --- UI helpers ---

function showLoading(on) { document.getElementById('loading').style.display = on ? 'block' : 'none'; }
function showError(msg) { const e = document.getElementById('error'); e.textContent = msg; e.style.display = 'block'; }
function hideError() { document.getElementById('error').style.display = 'none'; }
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function isGitlabUrl(name) { return /https?:\/\/\S*\/-\/issues\/\d+/.test(name || ''); }
function getGitlabId(name) { const m = String(name || '').match(/\/-\/issues\/(\d+)/); return m ? m[1] : ''; }
function phaseOf(status) { return STATUS_PHASES[(status || '').toLowerCase()] || 'Other'; }

// Extract the role assignee from a task's Sign-off checklist.
// Returns { assignee, resolved, hasRow } — assignee is a ClickUp user object or null.
function getSignoffRole(task) {
    const cl = (task.checklists || []).find(c => c.name === CHECKLIST_NAME);
    if (!cl) return { assignee: null, resolved: false, hasRow: false };
    const item = (cl.items || []).find(it => ROLE_RE.test(it.name || ''));
    if (!item) return { assignee: null, resolved: false, hasRow: false };
    return { assignee: item.assignee || null, resolved: !!item.resolved, hasRow: true };
}

// --- Concurrency pool ---

async function mapPool(items, worker, concurrency, onProgress) {
    const results = new Array(items.length);
    let idx = 0;
    let completed = 0;
    async function run() {
        while (idx < items.length) {
            const my = idx++;
            try { results[my] = await worker(items[my], my); }
            catch (e) { results[my] = null; }
            completed++;
            if (onProgress) onProgress(completed, items.length);
        }
    }
    const runners = [];
    for (let i = 0; i < Math.min(concurrency, items.length); i++) runners.push(run());
    await Promise.all(runners);
    return results;
}

// --- Fetch ---

async function fetchData() {
    const { listId } = getConfig();
    const dateFrom = document.getElementById('dateFrom').value;
    const dateTo = document.getElementById('dateTo').value;
    if (!dateFrom || !dateTo) { showError('Please select a date range.'); return; }

    const fromTs = new Date(dateFrom).getTime();
    const toTs = new Date(dateTo + 'T23:59:59').getTime();

    showLoading(true);
    hideError();
    document.getElementById('dashboard').style.display = 'none';

    try {
        // 1) Page through the list within the date window (cheap; no checklists here).
        let listTasks = [];
        let page = 0, hasMore = true;
        while (hasMore) {
            document.getElementById('loadingProgress').textContent =
                `Loading task list, page ${page + 1}... (${listTasks.length} so far)`;
            const res = await clickupFetch(
                `/api/v2/list/${listId}/task?page=${page}&subtasks=true&include_closed=true&date_updated_gt=${fromTs}&date_updated_lt=${toTs}`
            );
            if (!res.ok) {
                if (res.status === 401) throw new Error('Invalid API token.');
                if (res.status === 404) throw new Error('List not found. Check the List ID in settings.');
                throw new Error(`API error: ${res.status}`);
            }
            const data = await res.json();
            listTasks = listTasks.concat(data.tasks || []);
            hasMore = !data.last_page;
            page++;
        }

        // 2) Fan out per-task GETs to read the Sign-off checklist (list response omits it).
        const detailed = await mapPool(listTasks, async (t) => {
            const res = await clickupFetch(`/api/v2/task/${t.id}?include_subtasks=false`);
            if (!res.ok) return null;
            return res.json();
        }, FETCH_CONCURRENCY, (done, total) => {
            document.getElementById('loadingProgress').textContent =
                `Reading Sign-off checklists... ${done}/${total}`;
        });

        // 3) Attribute each task to the role's assignee. Keep only tasks that have
        //    a role row in the checklist (so we track "who is assigned this role").
        allTasks = [];
        for (const full of detailed) {
            if (!full) continue;
            const role = getSignoffRole(full);
            if (!role.hasRow) continue; // no Developer/QA row -> not relevant to this dashboard
            full.__role = role;
            allTasks.push(full);
        }

        buildExcludeChips();
        applyExclusions();

        const label = `${new Date(dateFrom).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} — ${new Date(dateTo).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
        document.getElementById('dateRangeInfo').textContent =
            `${listTasks.length} tickets updated in ${label} → ${allTasks.length} with a ${ROLE} sign-off row`;

        render();
        document.getElementById('dashboard').style.display = 'block';
    } catch (err) {
        showError(err.message);
    } finally {
        showLoading(false);
    }
}

// --- Exclude chips ---

function personName(assignee) {
    if (!assignee) return 'Unassigned';
    return assignee.username || assignee.email || `#${assignee.id}`;
}

function buildExcludeChips() {
    const names = new Set();
    allTasks.forEach(t => names.add(personName(t.__role.assignee)));
    const sorted = [...names].sort();
    const container = document.getElementById('excludeCheckboxes');
    container.innerHTML = sorted.map(name => {
        const isEx = excluded.has(name);
        return `<label class="exclude-chip ${isEx ? 'excluded' : ''}" onclick="toggleExclude('${escapeHtml(name)}', this)">
            <span>${escapeHtml(name)}</span><span class="chip-x">✕</span></label>`;
    }).join('');
}

function toggleExclude(name, el) {
    if (excluded.has(name)) { excluded.delete(name); el.classList.remove('excluded'); }
    else { excluded.add(name); el.classList.add('excluded'); }
    applyExclusions();
    render();
}

function applyExclusions() {
    tasks = excluded.size === 0 ? [...allTasks] : allTasks.filter(t => !excluded.has(personName(t.__role.assignee)));
}

// --- Render ---

function render() {
    renderKpis();
    renderPersonChart();
    renderStatusChart();
    renderPersonCards();
    populateFilters();
    currentPage = 1;
    renderTable();
}

function renderKpis() {
    const total = tasks.length;
    const signed = tasks.filter(t => t.__role.resolved).length;
    const unassigned = tasks.filter(t => !t.__role.assignee).length;
    const people = new Set(tasks.filter(t => t.__role.assignee).map(t => personName(t.__role.assignee)));
    const done = tasks.filter(t => phaseOf(t.status && t.status.status) === 'Done').length;
    const rate = total ? Math.round((signed / total) * 100) : 0;

    setText('kpiTotal', total);
    setText('kpiSigned', signed);
    setText('kpiUnassigned', unassigned);
    setText('kpiPeople', people.size);
    setText('kpiRate', rate + '%');
    setText('kpiDone', done);
}
function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }

function destroyChart(id) { if (chartInstances[id]) { chartInstances[id].destroy(); delete chartInstances[id]; } }

function renderPersonChart() {
    const counts = {};
    tasks.forEach(t => { const n = personName(t.__role.assignee); counts[n] = (counts[n] || 0) + 1; });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    destroyChart('personChart');
    chartInstances['personChart'] = new Chart(document.getElementById('personChart'), {
        type: 'bar',
        data: { labels: sorted.map(s => s[0]), datasets: [{ data: sorted.map(s => s[1]), backgroundColor: ROLE === 'QA' ? '#4da6ff' : '#7c6cf0', borderRadius: 6, maxBarThickness: 40 }] },
        options: {
            indexAxis: 'y', responsive: true, plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { color: '#7d8fa3', stepSize: 1 }, grid: { color: 'rgba(125,143,163,0.08)' } },
                y: { ticks: { color: '#7d8fa3', font: { size: 11 } }, grid: { display: false } }
            }
        }
    });
}

function renderStatusChart() {
    const counts = {}; const colors = {};
    tasks.forEach(t => { const s = (t.status && t.status.status) || 'Unknown'; counts[s] = (counts[s] || 0) + 1; if (t.status && t.status.color) colors[s] = t.status.color; });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    destroyChart('statusChart');
    chartInstances['statusChart'] = new Chart(document.getElementById('statusChart'), {
        type: 'doughnut',
        data: { labels: sorted.map(s => s[0]), datasets: [{ data: sorted.map(s => s[1]), backgroundColor: sorted.map(s => colors[s[0]] || '#7c6cf0'), borderWidth: 0, hoverOffset: 8 }] },
        options: { responsive: true, cutout: '55%', plugins: { legend: { position: 'right', labels: { color: '#7d8fa3', padding: 8, font: { size: 10 } } } } }
    });
}

function renderPersonCards() {
    const byPerson = {};
    tasks.forEach(t => {
        const a = t.__role.assignee;
        const name = personName(a);
        if (!byPerson[name]) byPerson[name] = { name, color: (a && a.color) || '#5a6e82', initials: (a && a.initials) || (name === 'Unassigned' ? '—' : '?'), tasks: [], signed: 0, phases: {} };
        byPerson[name].tasks.push(t);
        if (t.__role.resolved) byPerson[name].signed++;
        const ph = phaseOf(t.status && t.status.status);
        byPerson[name].phases[ph] = (byPerson[name].phases[ph] || 0) + 1;
    });

    const sorted = Object.values(byPerson).sort((a, b) => b.tasks.length - a.tasks.length);
    document.getElementById('personGrid').innerHTML = sorted.map(p => {
        const total = p.tasks.length;
        const signedPct = total ? Math.round((p.signed / total) * 100) : 0;

        // progress bar segments by phase
        const phaseOrder = ['Backlog', 'Development', 'Testing', 'Release', 'Done', 'Other'];
        const segments = phaseOrder.filter(ph => p.phases[ph]).map(ph => {
            const pct = (p.phases[ph] / total) * 100;
            return `<div class="person-progress-segment" style="width:${pct}%;background:${PHASE_COLORS[ph]}" title="${ph}: ${p.phases[ph]}"></div>`;
        }).join('');
        const legend = phaseOrder.filter(ph => p.phases[ph]).map(ph =>
            `<span class="person-legend-item"><span class="person-legend-dot" style="background:${PHASE_COLORS[ph]}"></span>${ph} ${p.phases[ph]}</span>`
        ).join('');

        const tasksList = p.tasks.slice(0, 12).map(t => {
            const sc = (t.status && t.status.color) || '#8b99a8';
            const sn = (t.status && t.status.status) || '?';
            return `<div class="person-task-item">
                <span class="person-task-dot" style="background:${sc}"></span>
                <a href="${t.url || '#'}" target="_blank" rel="noopener" class="person-task-name">${escapeHtml(t.name)}</a>
                <span class="person-task-status">${escapeHtml(sn)}</span>
            </div>`;
        }).join('');
        const more = p.tasks.length > 12 ? `<div class="person-task-item" style="color:var(--text-dim);font-style:italic;">+${p.tasks.length - 12} more</div>` : '';

        return `<div class="person-card">
            <div class="person-card-header">
                <div class="person-avatar" style="background:${p.color}">${escapeHtml(p.initials)}</div>
                <div><div class="person-name">${escapeHtml(p.name)}</div>
                     <div class="person-summary">${total} ${ROLE.toLowerCase()} ticket${total === 1 ? '' : 's'} · ${signedPct}% signed off</div></div>
            </div>
            <div class="person-stats-row">
                <div class="person-stat-box"><div class="person-stat-value">${total}</div><div class="person-stat-label">Total</div></div>
                <div class="person-stat-box"><div class="person-stat-value" style="color:var(--success)">${p.signed}</div><div class="person-stat-label">Signed off</div></div>
                <div class="person-stat-box"><div class="person-stat-value" style="color:var(--warning)">${total - p.signed}</div><div class="person-stat-label">Pending</div></div>
            </div>
            <div class="person-progress-bar">${segments}</div>
            <div class="person-progress-legend">${legend}</div>
            <div class="person-tasks-list">${tasksList}${more}</div>
        </div>`;
    }).join('');
}

// --- Table ---

function populateFilters() {
    // Person dropdown
    const sel = document.getElementById('filterPerson');
    const names = [...new Set(tasks.map(t => personName(t.__role.assignee)))].sort();
    const cur = sel.value;
    sel.innerHTML = `<option value="">All ${ROLE}s</option>` + names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
    if (names.includes(cur)) sel.value = cur;

    // Status dropdown
    const statusSel = document.getElementById('filterStatus');
    const statuses = [...new Set(tasks.map(t => t.status && t.status.status).filter(Boolean))].sort();
    const curStatus = statusSel.value;
    statusSel.innerHTML = `<option value="">All Statuses</option>` + statuses.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    if (statuses.includes(curStatus)) statusSel.value = curStatus;
}

function getFilteredTasks() {
    const person = document.getElementById('filterPerson').value;
    const statusF = document.getElementById('filterStatus').value;
    const search = (document.getElementById('filterSearch').value || '').toLowerCase();
    let f = tasks.filter(t => {
        if (person && personName(t.__role.assignee) !== person) return false;
        if (statusF && (t.status && t.status.status) !== statusF) return false;
        if (search && !(t.name || '').toLowerCase().includes(search)) return false;
        return true;
    });
    const dir = currentSort.direction === 'asc' ? 1 : -1;
    f.sort((a, b) => {
        let av, bv;
        switch (currentSort.field) {
            case 'name': av = a.name || ''; bv = b.name || ''; return av.localeCompare(bv) * dir;
            case 'status': av = (a.status && a.status.status) || ''; bv = (b.status && b.status.status) || ''; return av.localeCompare(bv) * dir;
            case 'person': av = personName(a.__role.assignee); bv = personName(b.__role.assignee); return av.localeCompare(bv) * dir;
            case 'created': av = parseInt(a.date_created || 0); bv = parseInt(b.date_created || 0); return (av - bv) * dir;
            case 'updated':
            default: av = parseInt(a.date_updated || 0); bv = parseInt(b.date_updated || 0); return (av - bv) * dir;
        }
    });
    return f;
}

function sortBy(field) {
    if (currentSort.field === field) currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
    else { currentSort.field = field; currentSort.direction = 'desc'; }
    renderTable();
}

function renderTable() {
    const filtered = getFilteredTasks();
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * PAGE_SIZE;
    const pageItems = filtered.slice(start, start + PAGE_SIZE);

    document.getElementById('tableStats').textContent = `${filtered.length} ticket${filtered.length === 1 ? '' : 's'}`;

    document.getElementById('tableBody').innerHTML = pageItems.map(t => {
        const status = (t.status && t.status.status) || 'Unknown';
        const sc = (t.status && t.status.color) || '#8b99a8';
        const person = personName(t.__role.assignee);
        const signed = t.__role.resolved;
        const updated = t.date_updated ? new Date(parseInt(t.date_updated)).toLocaleDateString() : '—';
        const created = t.date_created ? new Date(parseInt(t.date_created)).toLocaleDateString() : '—';
        const url = t.url || '#';
        const gid = getGitlabId(t.name);
        const gurl = isGitlabUrl(t.name) ? t.name : '';
        return `<tr>
            <td><a href="${url}" target="_blank" rel="noopener" class="task-link">${escapeHtml(t.name)}</a></td>
            <td>${gurl ? `<a href="${gurl}" target="_blank" rel="noopener" class="gitlab-btn">#${gid}</a>` : '—'}</td>
            <td><span class="status-badge" style="background:${sc}22;color:${sc}">${escapeHtml(status)}</span></td>
            <td>${escapeHtml(person)}</td>
            <td><span class="signed-badge ${signed ? 'yes' : 'no'}">${signed ? 'Signed off' : 'Pending'}</span></td>
            <td>${updated}</td>
            <td>${created}</td>
        </tr>`;
    }).join('');

    renderPagination(totalPages);
}

function renderPagination(totalPages) {
    if (totalPages <= 1) { document.getElementById('tablePagination').innerHTML = ''; return; }
    let html = `<button class="page-btn" onclick="goToPage(${currentPage - 1})" ${currentPage === 1 ? 'disabled' : ''}>‹</button>`;
    for (let i = 1; i <= totalPages; i++) {
        if (i === 1 || i === totalPages || Math.abs(i - currentPage) <= 2) {
            html += `<button class="page-btn ${i === currentPage ? 'active' : ''}" onclick="goToPage(${i})">${i}</button>`;
        } else if (Math.abs(i - currentPage) === 3) { html += `<span style="color:var(--text-dim)">…</span>`; }
    }
    html += `<button class="page-btn" onclick="goToPage(${currentPage + 1})" ${currentPage === totalPages ? 'disabled' : ''}>›</button>`;
    document.getElementById('tablePagination').innerHTML = html;
}
function goToPage(p) { currentPage = p; renderTable(); }

// --- Export ---

function exportToCSV() {
    const filtered = getFilteredTasks();
    if (!filtered.length) { alert('No data to export.'); return; }
    const rows = [['Task', 'GitLab IID', ROLE, 'Signed off', 'Status', 'Updated', 'Created', 'URL']];
    filtered.forEach(t => {
        rows.push([
            (t.name || '').replace(/"/g, '""'),
            getGitlabId(t.name),
            personName(t.__role.assignee),
            t.__role.resolved ? 'Yes' : 'No',
            (t.status && t.status.status) || '',
            t.date_updated ? new Date(parseInt(t.date_updated)).toISOString().split('T')[0] : '',
            t.date_created ? new Date(parseInt(t.date_created)).toISOString().split('T')[0] : '',
            t.url || '',
        ]);
    });
    const csv = rows.map(r => r.map(c => `"${String(c)}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${ROLE.toLowerCase()}-signoff-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
}

// --- Init ---

document.addEventListener('DOMContentLoaded', () => {
    loadConfig();
    const now = new Date();
    document.getElementById('dateFrom').value = formatDate(new Date(now.getFullYear(), now.getMonth(), 1));
    document.getElementById('dateTo').value = formatDate(now);
    fetchData();
});
