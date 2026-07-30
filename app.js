// ============================================================
// BXI Task Tracker Dashboard
// Pulls data from ClickUp API and renders PM analytics
// ============================================================

const DEFAULT_API_KEY = 'pk_270739823_X5BBT5TZCSFD3OQJQX0GT5XVHJSS13DY';
const DEFAULT_LIST_ID = '901609965646';

let allTasks = [];
let chartInstances = {};
let currentSort = { field: 'created', direction: 'desc' };
let currentPage = 1;
const PAGE_SIZE = 25;

// Status workflow phases for grouping
const PHASE_MAP = {
    'pending review (qa)': 'Review',
    'ongoing review': 'Review',
    'Open': 'Backlog',
    'defrerred': 'Backlog',
    'assigned to dev': 'Development',
    'ongoing dev': 'Development',
    'done development': 'Development',
    'ongoing fix': 'Development',
    'for verification': 'Testing',
    'merged': 'Release Pipeline',
    'for deployment to hotfix': 'Release Pipeline',
    'for testing in staging': 'Testing',
    'for testing in hotfix': 'Testing',
    'ongoing testing': 'Testing',
    'testing: passed': 'Testing',
    'testing: failed': 'Blocked',
    'for release': 'Done',
    'resolved - no code changes': 'Done',
    'released to prod': 'Done',
    'Closed': 'Done'
};

const PHASE_COLORS = {
    'Review': '#f76808',
    'Backlog': '#f8ae00',
    'Development': '#b660e0',
    'Testing': '#4466ff',
    'Release Pipeline': '#3db88b',
    'Blocked': '#ff4d6a',
    'Done': '#00d68f'
};

const PHASE_ORDER = ['Review', 'Backlog', 'Development', 'Testing', 'Release Pipeline', 'Blocked', 'Done'];

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
    if (!apiKey || !listId) { showError('API Key and List ID required.'); return; }
    localStorage.setItem('clickup_api_key', apiKey);
    localStorage.setItem('clickup_list_id', listId);
    toggleConfig();
    fetchAllData();
}

function toggleConfig() {
    const panel = document.getElementById('configPanel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

// --- API ---

async function fetchAllData() {
    const { apiKey, listId } = getConfig();
    showLoading(true);
    hideError();

    try {
        let tasks = [];
        let page = 0;
        let hasMore = true;

        while (hasMore) {
            document.getElementById('loadingProgress').textContent =
                `Loading page ${page + 1}... (${tasks.length} tasks so far)`;

            const res = await fetch(
                `https://api.clickup.com/api/v2/list/${listId}/task?page=${page}&subtasks=true&include_closed=true`,
                { headers: { 'Authorization': apiKey } }
            );

            if (!res.ok) {
                if (res.status === 401) throw new Error('Invalid API token.');
                if (res.status === 404) throw new Error('List not found. Check your List ID.');
                throw new Error(`API error: ${res.status}`);
            }

            const data = await res.json();
            tasks = tasks.concat(data.tasks || []);
            hasMore = !data.last_page;
            page++;
        }

        allTasks = tasks;
        renderDashboard();
        document.getElementById('lastUpdated').textContent =
            `Updated ${new Date().toLocaleTimeString()} · ${allTasks.length} tasks`;

    } catch (err) {
        showError(err.message);
    } finally {
        showLoading(false);
    }
}

// --- Render Dashboard ---

function renderDashboard() {
    document.getElementById('dashboard').style.display = 'block';
    renderPipeline();
    renderKPIs();
    renderPhaseChart();
    renderPriorityChart();
    renderWorkloadChart();
    renderThroughputChart();
    renderTagChart();
    renderCycleTimeChart();
    renderTeamGrid();
    populateFilters();
    renderTable();
}

// --- Pipeline ---

function renderPipeline() {
    const statusCounts = {};
    const statusColors = {};

    allTasks.forEach(t => {
        const s = t.status?.status || 'Unknown';
        statusCounts[s] = (statusCounts[s] || 0) + 1;
        if (t.status?.color) statusColors[s] = t.status.color;
    });

    // Get statuses that actually have tasks, in workflow order
    const statusOrder = [
        'pending review (qa)', 'ongoing review', 'Open', 'defrerred',
        'assigned to dev', 'ongoing dev', 'done development', 'ongoing fix',
        'for verification', 'merged', 'for deployment to hotfix',
        'for testing in staging', 'for testing in hotfix', 'ongoing testing',
        'testing: passed', 'testing: failed', 'for release',
        'resolved - no code changes', 'released to prod', 'Closed'
    ];

    const activeStatuses = statusOrder.filter(s => statusCounts[s]);

    document.getElementById('pipeline').innerHTML = activeStatuses.map(s => {
        const color = statusColors[s] || '#8b99a8';
        return `
            <div class="pipeline-stage">
                <div class="stage-bar" style="background:${color}"></div>
                <div class="stage-count" style="color:${color}">${statusCounts[s]}</div>
                <div class="stage-name">${s}</div>
            </div>
        `;
    }).join('');
}

// --- KPIs ---

function renderKPIs() {
    const active = allTasks.filter(t => {
        const type = t.status?.type;
        return type === 'custom';
    });
    const blocked = allTasks.filter(t => {
        const s = t.status?.status?.toLowerCase();
        return s === 'testing: failed' || s === 'ongoing fix';
    });
    const done = allTasks.filter(t => {
        const type = t.status?.type;
        return type === 'done' || type === 'closed';
    });
    const urgent = allTasks.filter(t => t.priority?.id === '1');
    const rate = allTasks.length ? Math.round((done.length / allTasks.length) * 100) : 0;

    document.getElementById('totalTasks').textContent = allTasks.length;
    document.getElementById('activeTasks').textContent = active.length;
    document.getElementById('blockedTasks').textContent = blocked.length;
    document.getElementById('completedTasks').textContent = done.length;
    document.getElementById('completionRate').textContent = rate + '%';
    document.getElementById('urgentTasks').textContent = urgent.length;
}

// --- Charts ---

function renderPhaseChart() {
    const phaseCounts = {};
    PHASE_ORDER.forEach(p => phaseCounts[p] = 0);

    allTasks.forEach(t => {
        const s = t.status?.status || 'Unknown';
        const phase = PHASE_MAP[s] || 'Backlog';
        phaseCounts[phase] = (phaseCounts[phase] || 0) + 1;
    });

    const labels = PHASE_ORDER.filter(p => phaseCounts[p] > 0);
    const data = labels.map(l => phaseCounts[l]);
    const colors = labels.map(l => PHASE_COLORS[l]);

    destroyChart('phaseChart');
    chartInstances['phaseChart'] = new Chart(document.getElementById('phaseChart'), {
        type: 'doughnut',
        data: {
            labels,
            datasets: [{ data, backgroundColor: colors, borderWidth: 0, hoverOffset: 8 }]
        },
        options: {
            responsive: true,
            cutout: '55%',
            plugins: {
                legend: { position: 'right', labels: { color: '#7d8fa3', padding: 12, font: { size: 11 } } }
            }
        }
    });
}

function renderPriorityChart() {
    const counts = { 'Urgent': 0, 'High': 0, 'Normal': 0, 'Low': 0, 'None': 0 };
    const colorMap = { 'Urgent': '#ff4d6a', 'High': '#ffb547', 'Normal': '#4da6ff', 'Low': '#7d8fa3', 'None': '#3a4a5a' };

    allTasks.forEach(t => {
        const p = t.priority;
        if (!p) { counts['None']++; return; }
        const map = { '1': 'Urgent', '2': 'High', '3': 'Normal', '4': 'Low' };
        counts[map[p.id] || 'None']++;
    });

    const labels = Object.keys(counts).filter(k => counts[k] > 0);
    const data = labels.map(l => counts[l]);
    const colors = labels.map(l => colorMap[l]);

    destroyChart('priorityChart');
    chartInstances['priorityChart'] = new Chart(document.getElementById('priorityChart'), {
        type: 'bar',
        data: {
            labels,
            datasets: [{ data, backgroundColor: colors, borderRadius: 6, maxBarThickness: 50 }]
        },
        options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { color: '#7d8fa3' }, grid: { display: false } },
                y: { ticks: { color: '#7d8fa3', stepSize: 10 }, grid: { color: 'rgba(125,143,163,0.08)' } }
            }
        }
    });
}

function renderWorkloadChart() {
    // Only show active (non-done) tasks per assignee
    const activeTasks = allTasks.filter(t => {
        const type = t.status?.type;
        return type !== 'done' && type !== 'closed';
    });

    const assigneeCounts = {};
    activeTasks.forEach(t => {
        if (t.assignees?.length) {
            t.assignees.forEach(a => {
                const name = a.username || 'Unknown';
                assigneeCounts[name] = (assigneeCounts[name] || 0) + 1;
            });
        } else {
            assigneeCounts['Unassigned'] = (assigneeCounts['Unassigned'] || 0) + 1;
        }
    });

    const sorted = Object.entries(assigneeCounts).sort((a, b) => b[1] - a[1]);
    const labels = sorted.map(s => s[0]);
    const data = sorted.map(s => s[1]);

    destroyChart('workloadChart');
    chartInstances['workloadChart'] = new Chart(document.getElementById('workloadChart'), {
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

function renderThroughputChart() {
    // Group by week: created vs completed
    const weeklyCreated = {};
    const weeklyCompleted = {};

    allTasks.forEach(t => {
        if (t.date_created) {
            const week = getWeekKey(parseInt(t.date_created));
            weeklyCreated[week] = (weeklyCreated[week] || 0) + 1;
        }
        if (t.date_done) {
            const week = getWeekKey(parseInt(t.date_done));
            weeklyCompleted[week] = (weeklyCompleted[week] || 0) + 1;
        }
    });

    const allWeeks = [...new Set([...Object.keys(weeklyCreated), ...Object.keys(weeklyCompleted)])].sort();
    // Show last 12 weeks
    const recentWeeks = allWeeks.slice(-12);
    const labels = recentWeeks.map(w => {
        const d = new Date(w);
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    });

    destroyChart('throughputChart');
    chartInstances['throughputChart'] = new Chart(document.getElementById('throughputChart'), {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Created',
                    data: recentWeeks.map(w => weeklyCreated[w] || 0),
                    borderColor: '#ffb547',
                    backgroundColor: 'rgba(255,181,71,0.1)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 4,
                    pointBackgroundColor: '#ffb547'
                },
                {
                    label: 'Completed',
                    data: recentWeeks.map(w => weeklyCompleted[w] || 0),
                    borderColor: '#00d68f',
                    backgroundColor: 'rgba(0,214,143,0.1)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 4,
                    pointBackgroundColor: '#00d68f'
                }
            ]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { labels: { color: '#7d8fa3', padding: 16 } }
            },
            scales: {
                x: { ticks: { color: '#7d8fa3', maxRotation: 45 }, grid: { display: false } },
                y: { ticks: { color: '#7d8fa3', stepSize: 5 }, grid: { color: 'rgba(125,143,163,0.08)' } }
            }
        }
    });
}

function renderTagChart() {
    const tagCounts = {};
    allTasks.forEach(t => {
        (t.tags || []).forEach(tag => {
            const name = tag.name || 'untagged';
            tagCounts[name] = (tagCounts[name] || 0) + 1;
        });
    });

    const sorted = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 12);
    const labels = sorted.map(s => s[0]);
    const data = sorted.map(s => s[1]);
    const colors = ['#7c6cf0', '#4da6ff', '#00d68f', '#ffb547', '#ff4d6a', '#f76808', '#b660e0', '#3db88b', '#0df1f1', '#f961f7', '#827718', '#d60800'];

    destroyChart('tagChart');
    chartInstances['tagChart'] = new Chart(document.getElementById('tagChart'), {
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
                y: { ticks: { color: '#7d8fa3', stepSize: 5 }, grid: { color: 'rgba(125,143,163,0.08)' } }
            }
        }
    });
}

function renderCycleTimeChart() {
    // Average days from creation to completion by assignee
    const assigneeTimes = {};

    allTasks.forEach(t => {
        if (!t.date_done || !t.date_created) return;
        const days = (parseInt(t.date_done) - parseInt(t.date_created)) / (1000 * 60 * 60 * 24);
        if (days < 0 || days > 365) return; // skip anomalies

        (t.assignees || []).forEach(a => {
            const name = a.username || 'Unknown';
            if (!assigneeTimes[name]) assigneeTimes[name] = [];
            assigneeTimes[name].push(days);
        });
    });

    const averages = Object.entries(assigneeTimes)
        .map(([name, times]) => ({ name, avg: times.reduce((a, b) => a + b, 0) / times.length, count: times.length }))
        .filter(a => a.count >= 3) // only show people with 3+ completed tasks
        .sort((a, b) => a.avg - b.avg);

    const labels = averages.map(a => a.name);
    const data = averages.map(a => Math.round(a.avg * 10) / 10);

    destroyChart('cycleTimeChart');
    chartInstances['cycleTimeChart'] = new Chart(document.getElementById('cycleTimeChart'), {
        type: 'bar',
        data: {
            labels,
            datasets: [{ data, backgroundColor: '#4da6ff', borderRadius: 6, maxBarThickness: 40 }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { color: '#7d8fa3' }, grid: { color: 'rgba(125,143,163,0.08)' }, title: { display: true, text: 'Days', color: '#5a6e82' } },
                y: { ticks: { color: '#7d8fa3', font: { size: 11 } }, grid: { display: false } }
            }
        }
    });
}

// --- Team Grid ---

function renderTeamGrid() {
    const teamData = {};

    allTasks.forEach(t => {
        (t.assignees || []).forEach(a => {
            const name = a.username || 'Unknown';
            if (!teamData[name]) {
                teamData[name] = { name, color: a.color || '#7c6cf0', initials: a.initials || '?', total: 0, active: 0, done: 0 };
            }
            teamData[name].total++;
            const type = t.status?.type;
            if (type === 'done' || type === 'closed') {
                teamData[name].done++;
            } else if (type === 'custom') {
                teamData[name].active++;
            }
        });
    });

    const sorted = Object.values(teamData).sort((a, b) => b.active - a.active);

    document.getElementById('teamGrid').innerHTML = sorted.map(m => `
        <div class="team-card">
            <div class="team-avatar" style="background:${m.color}">${m.initials}</div>
            <div class="team-info">
                <div class="team-name">${escapeHtml(m.name)}</div>
                <div class="team-stats">
                    <span class="team-stat"><span class="team-stat-value">${m.active}</span> active</span>
                    <span class="team-stat"><span class="team-stat-value">${m.done}</span> done</span>
                    <span class="team-stat"><span class="team-stat-value">${m.total}</span> total</span>
                </div>
            </div>
        </div>
    `).join('');
}

// --- Table ---

function populateFilters() {
    const statuses = [...new Set(allTasks.map(t => t.status?.status || 'Unknown'))].sort();
    const priorities = ['urgent', 'high', 'normal', 'low', 'none'];
    const assignees = [...new Set(allTasks.flatMap(t => (t.assignees || []).map(a => a.username)))].filter(Boolean).sort();
    const tags = [...new Set(allTasks.flatMap(t => (t.tags || []).map(tag => tag.name)))].filter(Boolean).sort();

    document.getElementById('filterStatus').innerHTML =
        '<option value="">All Statuses</option>' + statuses.map(s => `<option value="${s}">${s}</option>`).join('');
    document.getElementById('filterPriority').innerHTML =
        '<option value="">All Priorities</option>' + priorities.map(p => `<option value="${p}">${p}</option>`).join('');
    document.getElementById('filterAssignee').innerHTML =
        '<option value="">All Assignees</option>' + assignees.map(a => `<option value="${a}">${a}</option>`).join('');
    document.getElementById('filterTag').innerHTML =
        '<option value="">All Tags</option>' + tags.map(t => `<option value="${t}">${t}</option>`).join('');
}

function getFilteredTasks() {
    const statusFilter = document.getElementById('filterStatus').value;
    const priorityFilter = document.getElementById('filterPriority').value;
    const assigneeFilter = document.getElementById('filterAssignee').value;
    const tagFilter = document.getElementById('filterTag').value;
    const search = document.getElementById('filterSearch').value.toLowerCase();

    let filtered = allTasks;

    if (statusFilter) filtered = filtered.filter(t => (t.status?.status || 'Unknown') === statusFilter);
    if (priorityFilter) {
        if (priorityFilter === 'none') {
            filtered = filtered.filter(t => !t.priority);
        } else {
            filtered = filtered.filter(t => t.priority?.priority === priorityFilter);
        }
    }
    if (assigneeFilter) filtered = filtered.filter(t => t.assignees?.some(a => a.username === assigneeFilter));
    if (tagFilter) filtered = filtered.filter(t => t.tags?.some(tag => tag.name === tagFilter));
    if (search) filtered = filtered.filter(t => t.name.toLowerCase().includes(search));

    return filtered;
}

function sortTable(field) {
    if (currentSort.field === field) {
        currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
        currentSort.field = field;
        currentSort.direction = 'asc';
    }
    currentPage = 1;
    renderTable();
}

function renderTable() {
    let filtered = getFilteredTasks();

    // Sort
    filtered.sort((a, b) => {
        let va, vb;
        switch (currentSort.field) {
            case 'name': va = a.name; vb = b.name; break;
            case 'status': va = a.status?.orderindex || 0; vb = b.status?.orderindex || 0; break;
            case 'priority': va = a.priority?.orderindex || '99'; vb = b.priority?.orderindex || '99'; break;
            case 'assignee': va = a.assignees?.[0]?.username || 'zzz'; vb = b.assignees?.[0]?.username || 'zzz'; break;
            case 'created': va = a.date_created || '0'; vb = b.date_created || '0'; break;
            default: va = a.date_created || '0'; vb = b.date_created || '0';
        }
        if (typeof va === 'string') {
            const cmp = va.localeCompare(vb);
            return currentSort.direction === 'asc' ? cmp : -cmp;
        }
        return currentSort.direction === 'asc' ? va - vb : vb - va;
    });

    document.getElementById('tableStats').textContent = `Showing ${filtered.length} of ${allTasks.length} tasks`;

    // Paginate
    const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
    if (currentPage > totalPages) currentPage = totalPages || 1;
    const start = (currentPage - 1) * PAGE_SIZE;
    const pageItems = filtered.slice(start, start + PAGE_SIZE);

    const tbody = document.getElementById('taskTableBody');
    tbody.innerHTML = pageItems.map(task => {
        const status = task.status?.status || 'Unknown';
        const statusColor = task.status?.color || '#8b99a8';
        const priority = task.priority?.priority || '—';
        const priorityColor = task.priority?.color || '#5a6e82';
        const assignees = task.assignees?.map(a => a.username).join(', ') || '—';
        const created = task.date_created ? new Date(parseInt(task.date_created)).toLocaleDateString() : '—';
        const url = task.url || '#';
        const tags = (task.tags || []).map(tag =>
            `<span class="tag-badge" style="background:${tag.tag_bg}33;color:${tag.tag_fg}">${escapeHtml(tag.name)}</span>`
        ).join('');

        return `<tr>
            <td><a href="${url}" target="_blank" rel="noopener" class="task-link">${escapeHtml(task.name)}</a></td>
            <td><span class="status-badge" style="background:${statusColor}22;color:${statusColor}">${escapeHtml(status)}</span></td>
            <td><span class="priority-badge"><span class="priority-dot" style="background:${priorityColor}"></span>${escapeHtml(priority)}</span></td>
            <td>${escapeHtml(assignees)}</td>
            <td>${tags || '—'}</td>
            <td>${created}</td>
        </tr>`;
    }).join('');

    // Pagination
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
    renderTable();
}

// --- Helpers ---

function getWeekKey(timestamp) {
    const date = new Date(timestamp);
    const start = new Date(date);
    start.setDate(date.getDate() - date.getDay() + 1);
    return start.toISOString().split('T')[0];
}

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
    fetchAllData();
});
