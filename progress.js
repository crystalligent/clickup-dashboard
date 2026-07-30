// ============================================================
// Team Progress Tracker
// Filters tickets that moved from Open to another status
// within a specified date range
// ============================================================

const DEFAULT_API_KEY = 'pk_270739823_X5BBT5TZCSFD3OQJQX0GT5XVHJSS13DY';
const DEFAULT_LIST_ID = '901609965646';

// Statuses that indicate NO progress (still in backlog/queue)
const NO_PROGRESS_STATUSES = ['open', 'pending review (qa)', 'defrerred'];

let progressTasks = [];
let allFetchedProgressTasks = [];
let excludedAssignees = new Set();
let chartInstances = {};
let currentSort = { field: 'updated', direction: 'desc' };
let currentPage = 1;
const PAGE_SIZE = 25;

// Phase groupings for analytics
const STATUS_PHASES = {
    'assigned to dev': 'Development',
    'ongoing dev': 'Development',
    'done development': 'Development',
    'ongoing fix': 'Development',
    'for verification': 'Testing',
    'for testing in staging': 'Testing',
    'for testing in hotfix': 'Testing',
    'ongoing testing': 'Testing',
    'testing: passed': 'Testing',
    'testing: failed': 'Testing',
    'merged': 'Release',
    'for deployment to hotfix': 'Release',
    'for release': 'Done',
    'resolved - no code changes': 'Done',
    'released to prod': 'Done',
    'ongoing review': 'Review'
};

// --- Config ---

function getConfig() {
    return {
        apiKey: localStorage.getItem('clickup_api_key') || DEFAULT_API_KEY,
        listId: localStorage.getItem('clickup_list_id') || DEFAULT_LIST_ID
    };
}

function loadConfig() {
    const config = getConfig();
    document.getElementById('apiKey').value = config.apiKey;
    document.getElementById('listId').value = config.listId;
}

function saveConfig() {
    const apiKey = document.getElementById('apiKey').value.trim();
    const listId = document.getElementById('listId').value.trim();
    if (!apiKey || !listId) return;
    localStorage.setItem('clickup_api_key', apiKey);
    localStorage.setItem('clickup_list_id', listId);
    toggleConfig();
}

function toggleConfig() {
    const panel = document.getElementById('configPanel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

// --- Date Range ---

function setPreset(preset) {
    // Update active button
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    event.target.classList.add('active');

    const now = new Date();
    let from, to;

    switch (preset) {
        case 'this-month':
            from = new Date(now.getFullYear(), now.getMonth(), 1);
            to = now;
            break;
        case 'last-month':
            from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            to = new Date(now.getFullYear(), now.getMonth(), 0);
            break;
        case 'this-week':
            const dayOfWeek = now.getDay();
            from = new Date(now);
            from.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
            to = now;
            break;
        case 'last-week':
            const dow = now.getDay();
            const lastMonday = new Date(now);
            lastMonday.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1) - 7);
            from = lastMonday;
            to = new Date(lastMonday);
            to.setDate(lastMonday.getDate() + 6);
            break;
        case 'last-7':
            from = new Date(now);
            from.setDate(now.getDate() - 7);
            to = now;
            break;
        case 'last-14':
            from = new Date(now);
            from.setDate(now.getDate() - 14);
            to = now;
            break;
        case 'last-30':
            from = new Date(now);
            from.setDate(now.getDate() - 30);
            to = now;
            break;
        case 'custom':
            // Just let user pick manually
            return;
    }

    document.getElementById('dateFrom').value = formatDate(from);
    document.getElementById('dateTo').value = formatDate(to);
    fetchProgressData();
}

function onDateChange() {
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.preset-btn:last-child').classList.add('active');
}

function formatDate(d) {
    return d.toISOString().split('T')[0];
}

// --- API ---

async function fetchProgressData() {
    const { apiKey, listId } = getConfig();
    const dateFrom = document.getElementById('dateFrom').value;
    const dateTo = document.getElementById('dateTo').value;

    if (!dateFrom || !dateTo) {
        showError('Please select a date range.');
        return;
    }

    const fromTs = new Date(dateFrom).getTime();
    const toTs = new Date(dateTo + 'T23:59:59').getTime();

    showLoading(true);
    hideError();

    try {
        let tasks = [];
        let page = 0;
        let hasMore = true;

        // Fetch tasks updated within the date range
        while (hasMore) {
            document.getElementById('loadingProgress').textContent =
                `Loading page ${page + 1}... (${tasks.length} tasks so far)`;

            const url = `https://api.clickup.com/api/v2/list/${listId}/task?page=${page}&subtasks=true&include_closed=true&date_updated_gt=${fromTs}&date_updated_lt=${toTs}`;

            const res = await fetch(url, { headers: { 'Authorization': apiKey } });

            if (!res.ok) {
                if (res.status === 401) throw new Error('Invalid API token.');
                if (res.status === 404) throw new Error('List not found.');
                throw new Error(`API error: ${res.status}`);
            }

            const data = await res.json();
            tasks = tasks.concat(data.tasks || []);
            hasMore = !data.last_page;
            page++;
        }

        // Filter: only tasks that show progress (not still in Open/backlog, not Closed)
        progressTasks = tasks.filter(t => {
            const status = (t.status?.status || '').toLowerCase();
            // Exclude tasks still sitting in no-progress statuses
            if (NO_PROGRESS_STATUSES.includes(status)) return false;
            // Exclude Closed (we want active progress, not just closed tickets)
            if (status === 'closed') return false;
            return true;
        });

        allFetchedProgressTasks = [...progressTasks];
        populateExcludeCheckboxes();
        applyExclusions();

        const rangeLabel = `${new Date(dateFrom).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} — ${new Date(dateTo).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
        updateInfoText();

        renderProgressDashboard();

    } catch (err) {
        showError(err.message);
    } finally {
        showLoading(false);
    }
}

// --- Exclude Assignees ---

function populateExcludeCheckboxes() {
    const assignees = new Set();
    allFetchedProgressTasks.forEach(t => {
        (t.assignees || []).forEach(a => {
            if (a.username) assignees.add(a.username);
        });
    });

    const sorted = [...assignees].sort();
    const container = document.getElementById('excludeCheckboxes');

    container.innerHTML = sorted.map(name => {
        const isExcluded = excludedAssignees.has(name);
        return `<label class="exclude-chip ${isExcluded ? 'excluded' : ''}" onclick="toggleExclude('${escapeHtml(name)}', this)">
            <span>${escapeHtml(name)}</span>
            <span class="chip-x">✕</span>
        </label>`;
    }).join('');
}

function toggleExclude(name, el) {
    if (excludedAssignees.has(name)) {
        excludedAssignees.delete(name);
        el.classList.remove('excluded');
    } else {
        excludedAssignees.add(name);
        el.classList.add('excluded');
    }
    applyExclusions();
    updateInfoText();
    renderProgressDashboard();
}

function applyExclusions() {
    if (excludedAssignees.size === 0) {
        progressTasks = [...allFetchedProgressTasks];
    } else {
        progressTasks = allFetchedProgressTasks.filter(t => {
            const assignees = (t.assignees || []).map(a => a.username).filter(Boolean);
            if (assignees.length === 0) return true;
            return assignees.some(name => !excludedAssignees.has(name));
        });
    }
}

function updateInfoText() {
    const base = `${allFetchedProgressTasks.length} tickets with meaningful progress`;
    const extra = excludedAssignees.size > 0
        ? ` → ${progressTasks.length} after excluding ${excludedAssignees.size} assignee(s)`
        : '';
    document.getElementById('dateRangeInfo').textContent = base + extra;
}

// --- Render ---

function renderProgressDashboard() {
    document.getElementById('dashboard').style.display = 'block';
    renderProgressKPIs();
    renderMemberProgressChart();
    renderStatusDistChart();
    renderTagProgressChart();
    renderPriorityProgressChart();
    populateFilters();
    renderProgressTable();
    renderTeamBreakdown();
}

function renderProgressKPIs() {
    const completed = progressTasks.filter(t => {
        const type = t.status?.type;
        return type === 'done';
    });

    const inDev = progressTasks.filter(t => {
        const s = (t.status?.status || '').toLowerCase();
        return ['assigned to dev', 'ongoing dev', 'done development', 'ongoing fix'].includes(s);
    });

    const inTest = progressTasks.filter(t => {
        const s = (t.status?.status || '').toLowerCase();
        return ['for verification', 'for testing in staging', 'for testing in hotfix', 'ongoing testing', 'testing: passed', 'testing: failed'].includes(s);
    });

    const members = new Set();
    progressTasks.forEach(t => {
        (t.assignees || []).forEach(a => members.add(a.username));
    });

    document.getElementById('progressCount').textContent = progressTasks.length;
    document.getElementById('completedCount').textContent = completed.length;
    document.getElementById('inDevCount').textContent = inDev.length;
    document.getElementById('inTestCount').textContent = inTest.length;
    document.getElementById('activeMembers').textContent = members.size;
}

function renderMemberProgressChart() {
    const memberCounts = {};
    progressTasks.forEach(t => {
        (t.assignees || []).forEach(a => {
            const name = a.username || 'Unknown';
            memberCounts[name] = (memberCounts[name] || 0) + 1;
        });
        if (!t.assignees?.length) {
            memberCounts['Unassigned'] = (memberCounts['Unassigned'] || 0) + 1;
        }
    });

    const sorted = Object.entries(memberCounts).sort((a, b) => b[1] - a[1]);
    const labels = sorted.map(s => s[0]);
    const data = sorted.map(s => s[1]);

    destroyChart('memberProgressChart');
    chartInstances['memberProgressChart'] = new Chart(document.getElementById('memberProgressChart'), {
        type: 'bar',
        data: {
            labels,
            datasets: [{ data, backgroundColor: '#7c6cf0', borderRadius: 6, maxBarThickness: 40 }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { color: '#7d8fa3', stepSize: 5 }, grid: { color: 'rgba(125,143,163,0.08)' } },
                y: { ticks: { color: '#7d8fa3', font: { size: 11 } }, grid: { display: false } }
            }
        }
    });
}

function renderStatusDistChart() {
    const statusCounts = {};
    const statusColors = {};

    progressTasks.forEach(t => {
        const s = t.status?.status || 'Unknown';
        statusCounts[s] = (statusCounts[s] || 0) + 1;
        if (t.status?.color) statusColors[s] = t.status.color;
    });

    const sorted = Object.entries(statusCounts).sort((a, b) => b[1] - a[1]);
    const labels = sorted.map(s => s[0]);
    const data = sorted.map(s => s[1]);
    const colors = labels.map(l => statusColors[l] || '#7c6cf0');

    destroyChart('statusDistChart');
    chartInstances['statusDistChart'] = new Chart(document.getElementById('statusDistChart'), {
        type: 'doughnut',
        data: {
            labels,
            datasets: [{ data, backgroundColor: colors, borderWidth: 0, hoverOffset: 8 }]
        },
        options: {
            responsive: true,
            cutout: '50%',
            plugins: {
                legend: { position: 'right', labels: { color: '#7d8fa3', padding: 10, font: { size: 10 } } }
            }
        }
    });
}

function renderTagProgressChart() {
    const tagCounts = {};
    progressTasks.forEach(t => {
        (t.tags || []).forEach(tag => {
            tagCounts[tag.name] = (tagCounts[tag.name] || 0) + 1;
        });
    });

    const sorted = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (sorted.length === 0) {
        destroyChart('tagProgressChart');
        return;
    }

    const labels = sorted.map(s => s[0]);
    const data = sorted.map(s => s[1]);
    const colors = ['#7c6cf0', '#4da6ff', '#00d68f', '#ffb547', '#ff4d6a', '#f76808', '#b660e0', '#3db88b', '#0df1f1', '#f961f7'];

    destroyChart('tagProgressChart');
    chartInstances['tagProgressChart'] = new Chart(document.getElementById('tagProgressChart'), {
        type: 'bar',
        data: {
            labels,
            datasets: [{ data, backgroundColor: colors.slice(0, data.length), borderRadius: 6, maxBarThickness: 40 }]
        },
        options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { color: '#7d8fa3', maxRotation: 45, font: { size: 10 } }, grid: { display: false } },
                y: { ticks: { color: '#7d8fa3', stepSize: 2 }, grid: { color: 'rgba(125,143,163,0.08)' } }
            }
        }
    });
}

function renderPriorityProgressChart() {
    const counts = { 'Urgent': 0, 'High': 0, 'Normal': 0, 'Low': 0, 'None': 0 };
    const colorMap = { 'Urgent': '#ff4d6a', 'High': '#ffb547', 'Normal': '#4da6ff', 'Low': '#7d8fa3', 'None': '#3a4a5a' };

    progressTasks.forEach(t => {
        const p = t.priority;
        if (!p) { counts['None']++; return; }
        const map = { '1': 'Urgent', '2': 'High', '3': 'Normal', '4': 'Low' };
        counts[map[p.id] || 'None']++;
    });

    const labels = Object.keys(counts).filter(k => counts[k] > 0);
    const data = labels.map(l => counts[l]);
    const colors = labels.map(l => colorMap[l]);

    destroyChart('priorityProgressChart');
    chartInstances['priorityProgressChart'] = new Chart(document.getElementById('priorityProgressChart'), {
        type: 'doughnut',
        data: {
            labels,
            datasets: [{ data, backgroundColor: colors, borderWidth: 0, hoverOffset: 8 }]
        },
        options: {
            responsive: true,
            cutout: '50%',
            plugins: {
                legend: { position: 'right', labels: { color: '#7d8fa3', padding: 10, font: { size: 11 } } }
            }
        }
    });
}

// --- Table ---

function populateFilters() {
    const assignees = [...new Set(progressTasks.flatMap(t => (t.assignees || []).map(a => a.username)))].filter(Boolean).sort();
    const statuses = [...new Set(progressTasks.map(t => t.status?.status || 'Unknown'))].sort();
    const tags = [...new Set(progressTasks.flatMap(t => (t.tags || []).map(tag => tag.name)))].filter(Boolean).sort();

    document.getElementById('filterAssignee').innerHTML =
        '<option value="">All Assignees</option>' + assignees.map(a => `<option value="${a}">${a}</option>`).join('');
    document.getElementById('filterStatus').innerHTML =
        '<option value="">All Statuses</option>' + statuses.map(s => `<option value="${s}">${s}</option>`).join('');
    document.getElementById('filterTag').innerHTML =
        '<option value="">All Tags</option>' + tags.map(t => `<option value="${t}">${t}</option>`).join('');
}

function getFilteredTasks() {
    const assigneeFilter = document.getElementById('filterAssignee').value;
    const statusFilter = document.getElementById('filterStatus').value;
    const tagFilter = document.getElementById('filterTag').value;
    const search = document.getElementById('filterSearch').value.toLowerCase();

    let filtered = progressTasks;

    if (assigneeFilter) filtered = filtered.filter(t => t.assignees?.some(a => a.username === assigneeFilter));
    if (statusFilter) filtered = filtered.filter(t => (t.status?.status || 'Unknown') === statusFilter);
    if (tagFilter) filtered = filtered.filter(t => t.tags?.some(tag => tag.name === tagFilter));
    if (search) filtered = filtered.filter(t => t.name.toLowerCase().includes(search));

    return filtered;
}

function sortBy(field) {
    if (currentSort.field === field) {
        currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
        currentSort.field = field;
        currentSort.direction = field === 'updated' ? 'desc' : 'asc';
    }
    currentPage = 1;
    renderProgressTable();
}

function renderProgressTable() {
    let filtered = getFilteredTasks();

    // Sort
    filtered.sort((a, b) => {
        let va, vb;
        switch (currentSort.field) {
            case 'name': va = a.name; vb = b.name; break;
            case 'status': va = a.status?.orderindex || 0; vb = b.status?.orderindex || 0; break;
            case 'assignee': va = a.assignees?.[0]?.username || 'zzz'; vb = b.assignees?.[0]?.username || 'zzz'; break;
            case 'priority': va = a.priority?.orderindex || '99'; vb = b.priority?.orderindex || '99'; break;
            case 'updated': va = a.date_updated || '0'; vb = b.date_updated || '0'; break;
            case 'created': va = a.date_created || '0'; vb = b.date_created || '0'; break;
            default: va = a.date_updated || '0'; vb = b.date_updated || '0';
        }
        if (typeof va === 'string') {
            const cmp = va.localeCompare(vb);
            return currentSort.direction === 'asc' ? cmp : -cmp;
        }
        return currentSort.direction === 'asc' ? va - vb : vb - va;
    });

    document.getElementById('tableStats').textContent = `${filtered.length} tickets with progress`;

    // Paginate
    const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
    if (currentPage > totalPages) currentPage = totalPages || 1;
    const start = (currentPage - 1) * PAGE_SIZE;
    const pageItems = filtered.slice(start, start + PAGE_SIZE);

    const tbody = document.getElementById('progressTableBody');
    tbody.innerHTML = pageItems.map(task => {
        const status = task.status?.status || 'Unknown';
        const statusColor = task.status?.color || '#8b99a8';
        const priority = task.priority?.priority || '—';
        const priorityColor = task.priority?.color || '#5a6e82';
        const assignees = task.assignees?.map(a => a.username).join(', ') || '—';
        const updated = task.date_updated ? new Date(parseInt(task.date_updated)).toLocaleDateString() : '—';
        const created = task.date_created ? new Date(parseInt(task.date_created)).toLocaleDateString() : '—';
        const url = task.url || '#';
        const tags = (task.tags || []).map(tag =>
            `<span class="tag-badge" style="background:${tag.tag_bg}33;color:${tag.tag_fg}">${escapeHtml(tag.name)}</span>`
        ).join('');

        return `<tr>
            <td><a href="${url}" target="_blank" rel="noopener" class="task-link">${escapeHtml(task.name)}</a></td>
            <td><span class="status-badge" style="background:${statusColor}22;color:${statusColor}">${escapeHtml(status)}</span></td>
            <td>${escapeHtml(assignees)}</td>
            <td><span class="priority-badge"><span class="priority-dot" style="background:${priorityColor}"></span>${escapeHtml(priority)}</span></td>
            <td>${tags || '—'}</td>
            <td>${updated}</td>
            <td>${created}</td>
        </tr>`;
    }).join('');

    renderPagination(totalPages);
}

function renderPagination(totalPages) {
    if (totalPages <= 1) {
        document.getElementById('tablePagination').innerHTML = '';
        return;
    }

    let html = '';
    html += `<button class="page-btn" onclick="goToPage(${currentPage - 1})" ${currentPage === 1 ? 'disabled' : ''}>‹</button>`;

    for (let i = 1; i <= totalPages; i++) {
        if (i === 1 || i === totalPages || Math.abs(i - currentPage) <= 2) {
            html += `<button class="page-btn ${i === currentPage ? 'active' : ''}" onclick="goToPage(${i})">${i}</button>`;
        } else if (Math.abs(i - currentPage) === 3) {
            html += `<span style="color:var(--text-dim)">…</span>`;
        }
    }

    html += `<button class="page-btn" onclick="goToPage(${currentPage + 1})" ${currentPage === totalPages ? 'disabled' : ''}>›</button>`;
    document.getElementById('tablePagination').innerHTML = html;
}

function goToPage(page) {
    currentPage = page;
    renderProgressTable();
}

// --- Team Breakdown ---

function renderTeamBreakdown() {
    const teamData = {};

    progressTasks.forEach(t => {
        (t.assignees || []).forEach(a => {
            const name = a.username || 'Unknown';
            if (!teamData[name]) {
                teamData[name] = {
                    name,
                    color: a.color || '#7c6cf0',
                    initials: a.initials || '?',
                    tasks: [],
                    phases: { Development: 0, Testing: 0, Release: 0, Done: 0, Review: 0, Other: 0 }
                };
            }
            teamData[name].tasks.push(t);
            const phase = STATUS_PHASES[(t.status?.status || '').toLowerCase()] || 'Other';
            teamData[name].phases[phase]++;
        });
    });

    const sorted = Object.values(teamData).sort((a, b) => b.tasks.length - a.tasks.length);

    document.getElementById('teamBreakdown').innerHTML = sorted.map(member => {
        const tasksList = member.tasks.slice(0, 10).map(t => {
            const statusColor = t.status?.color || '#8b99a8';
            const statusName = t.status?.status || '?';
            return `<div class="member-task-item">
                <span class="status-dot" style="background:${statusColor}"></span>
                <a href="${t.url || '#'}" target="_blank" rel="noopener" class="task-name">${escapeHtml(t.name)}</a>
                <span class="task-status">${escapeHtml(statusName)}</span>
            </div>`;
        }).join('');

        const moreCount = member.tasks.length > 10 ? `<div class="member-task-item" style="color:var(--text-dim);font-style:italic;">+${member.tasks.length - 10} more</div>` : '';

        return `<div class="member-card">
            <div class="member-card-header">
                <div class="member-card-avatar" style="background:${member.color}">${member.initials}</div>
                <div>
                    <div class="member-card-name">${escapeHtml(member.name)}</div>
                    <div class="member-card-count">${member.tasks.length} tickets progressed</div>
                </div>
            </div>
            <div class="member-card-stats">
                ${member.phases.Development ? `<div class="member-stat"><div class="member-stat-value" style="color:#b660e0">${member.phases.Development}</div><div class="member-stat-label">Dev</div></div>` : ''}
                ${member.phases.Testing ? `<div class="member-stat"><div class="member-stat-value" style="color:#4466ff">${member.phases.Testing}</div><div class="member-stat-label">Test</div></div>` : ''}
                ${member.phases.Release ? `<div class="member-stat"><div class="member-stat-value" style="color:#3db88b">${member.phases.Release}</div><div class="member-stat-label">Release</div></div>` : ''}
                ${member.phases.Done ? `<div class="member-stat"><div class="member-stat-value" style="color:#00d68f">${member.phases.Done}</div><div class="member-stat-label">Done</div></div>` : ''}
                ${member.phases.Review ? `<div class="member-stat"><div class="member-stat-value" style="color:#f76808">${member.phases.Review}</div><div class="member-stat-label">Review</div></div>` : ''}
            </div>
            <div class="member-tasks-list">
                ${tasksList}
                ${moreCount}
            </div>
        </div>`;
    }).join('');
}

// --- Helpers ---

function destroyChart(id) {
    if (chartInstances[id]) { chartInstances[id].destroy(); delete chartInstances[id]; }
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

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
}

// --- Init ---

document.addEventListener('DOMContentLoaded', () => {
    loadConfig();
    // Default to this month
    const now = new Date();
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    document.getElementById('dateFrom').value = formatDate(firstOfMonth);
    document.getElementById('dateTo').value = formatDate(now);
    fetchProgressData();
});
