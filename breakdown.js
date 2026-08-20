// ============================================================
// Tasks Breakdown — Executive View
// Provides a high-level breakdown of tasks with phase mapping,
// aging analysis, and risk assessment for executive reporting.
// ============================================================

const DEFAULT_LIST_ID = '901609965646';

function getApiBase() {
    if (window.location.hostname !== '' && window.location.protocol !== 'file:') {
        return '/.netlify/functions/clickup-proxy?path=';
    }
    return null;
}

async function clickupFetch(apiPath) {
    const proxyBase = getApiBase();
    if (proxyBase) {
        const res = await fetch(proxyBase + encodeURIComponent(apiPath));
        return res;
    }
    throw new Error('This dashboard must be hosted on Netlify to access ClickUp data.');
}

// Phase mapping for executive view
const PHASE_MAP = {
    'pending review (qa)': 'Review',
    'ongoing review': 'Review',
    'open': 'Backlog',
    'defrerred': 'Backlog',
    'assigned to dev': 'Development',
    'ongoing dev': 'Development',
    'done development': 'Development',
    'ongoing fix': 'Development',
    'for verification': 'Testing',
    'merged': 'Release',
    'for deployment to hotfix': 'Release',
    'for testing in staging': 'Testing',
    'for testing in hotfix': 'Testing',
    'ongoing testing': 'Testing',
    'testing: passed': 'Testing',
    'testing: failed': 'Blocked',
    'for release': 'Done',
    'resolved - no code changes': 'Done',
    'released to prod': 'Done',
    'closed': 'Done'
};

const PHASE_COLORS = {
    'Backlog': '#f8ae00',
    'Review': '#f76808',
    'Development': '#b660e0',
    'Testing': '#4466ff',
    'Release': '#3db88b',
    'Blocked': '#ff4d6a',
    'Done': '#00d68f'
};

const PHASE_ORDER = ['Backlog', 'Review', 'Development', 'Testing', 'Release', 'Blocked', 'Done'];

let allTasks = [];
let filteredTasks = [];
let excludedAssignees = new Set();
let chartInstances = {};
let currentSort = { field: 'updated', direction: 'desc' };
let currentPage = 1;
const PAGE_SIZE = 30;

// --- Config ---

function getConfig() {
    return {
        listId: localStorage.getItem('clickup_list_id') || DEFAULT_LIST_ID
    };
}

function loadConfig() {
    document.getElementById('listId').value = getConfig().listId;
}

function saveConfig() {
    const listId = document.getElementById('listId').value.trim();
    if (!listId) return;
    localStorage.setItem('clickup_list_id', listId);
    toggleConfig();
}

function toggleConfig() {
    const panel = document.getElementById('configPanel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

// --- Date Range ---

function setPreset(preset, btn) {
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

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
        case 'last-90':
            from = new Date(now);
            from.setDate(now.getDate() - 90);
            to = now;
            break;
        case 'custom':
            return;
    }

    document.getElementById('dateFrom').value = formatDate(from);
    document.getElementById('dateTo').value = formatDate(to);
    fetchBreakdownData();
}

function onDateChange() {
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
}

function formatDate(d) {
    return d.toISOString().split('T')[0];
}

// --- Utility Functions ---

function getTaskPhase(task) {
    const status = (task.status?.status || '').toLowerCase();
    return PHASE_MAP[status] || 'Backlog';
}

function getTaskAgeDays(task) {
    if (!task.date_created) return 0;
    const created = parseInt(task.date_created);
    const now = Date.now();
    return Math.floor((now - created) / (1000 * 60 * 60 * 24));
}

function getAgingCategory(days) {
    if (days < 3) return 'fresh';
    if (days < 7) return 'normal';
    if (days < 14) return 'aging';
    if (days < 30) return 'stale';
    return 'critical';
}

function getAgingLabel(category) {
    const labels = {
        'fresh': '< 3d',
        'normal': '3–7d',
        'aging': '7–14d',
        'stale': '14–30d',
        'critical': '> 30d'
    };
    return labels[category] || category;
}

function getRiskLevel(task) {
    const age = getTaskAgeDays(task);
    const priority = task.priority?.id || '4';
    const phase = getTaskPhase(task);
    const status = (task.status?.status || '').toLowerCase();

    // Critical risk: high priority + stale + blocked
    if (priority <= '2' && age > 14 && phase === 'Blocked') return 'critical';
    if (priority === '1' && age > 7) return 'critical';

    // High risk: urgent/high priority aging, or blocked tasks
    if (phase === 'Blocked') return 'high';
    if (priority <= '2' && age > 14) return 'high';
    if (status === 'ongoing fix' && age > 7) return 'high';

    // Medium risk: aging tasks or high priority in dev
    if (age > 14) return 'medium';
    if (priority <= '2' && age > 7) return 'medium';

    // Low risk: everything else
    return 'low';
}

function getRiskLabel(level) {
    const labels = { 'low': 'Low', 'medium': 'Medium', 'high': 'High', 'critical': 'Critical' };
    return labels[level] || level;
}

function getRiskIcon(level) {
    const icons = { 'low': '🟢', 'medium': '🟡', 'high': '🟠', 'critical': '🔴' };
    return icons[level] || '⚪';
}

// --- API ---

async function fetchBreakdownData() {
    const { listId } = getConfig();
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

        while (hasMore) {
            document.getElementById('loadingProgress').textContent =
                `Loading page ${page + 1}... (${tasks.length} tasks)`;

            const res = await clickupFetch(
                `/api/v2/list/${listId}/task?page=${page}&subtasks=true&include_closed=true&date_updated_gt=${fromTs}&date_updated_lt=${toTs}`
            );

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

        allTasks = tasks;
        populateExcludeCheckboxes();
        populateFilterDropdowns();
        applyFiltersAndRender();

        document.getElementById('dateRangeInfo').textContent =
            `${allTasks.length} tasks loaded · ${dateFrom} to ${dateTo}`;

    } catch (err) {
        showError(err.message);
    } finally {
        showLoading(false);
    }
}

// --- Exclude Assignees ---

function populateExcludeCheckboxes() {
    const assignees = new Set();
    allTasks.forEach(t => {
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
    applyFiltersAndRender();
}

// --- Filter Dropdowns ---

function populateFilterDropdowns() {
    const statuses = [...new Set(allTasks.map(t => t.status?.status || 'Unknown'))].sort();
    const priorities = ['urgent', 'high', 'normal', 'low'];
    const assignees = [...new Set(allTasks.flatMap(t => (t.assignees || []).map(a => a.username)))].filter(Boolean).sort();
    const tags = [...new Set(allTasks.flatMap(t => (t.tags || []).map(tag => tag.name)))].filter(Boolean).sort();

    document.getElementById('filterStatus').innerHTML =
        '<option value="">All Statuses</option>' + statuses.map(s => `<option value="${s}">${s}</option>`).join('');
    document.getElementById('filterPriority').innerHTML =
        '<option value="">All Priorities</option>' + priorities.map(p => `<option value="${p}">${capitalize(p)}</option>`).join('');
    document.getElementById('filterAssignee').innerHTML =
        '<option value="">All Assignees</option>' + assignees.map(a => `<option value="${a}">${a}</option>`).join('');
    document.getElementById('filterTag').innerHTML =
        '<option value="">All Tags</option>' + tags.map(t => `<option value="${t}">${t}</option>`).join('');
}

// --- Apply Filters ---

function applyFiltersAndRender() {
    const statusFilter = document.getElementById('filterStatus').value;
    const priorityFilter = document.getElementById('filterPriority').value;
    const assigneeFilter = document.getElementById('filterAssignee').value;
    const tagFilter = document.getElementById('filterTag').value;
    const phaseFilter = document.getElementById('filterPhase').value;
    const agingFilter = document.getElementById('filterAging').value;
    const riskFilter = document.getElementById('filterRisk').value;
    const search = document.getElementById('filterSearch').value.toLowerCase();

    let tasks = [...allTasks];

    // Exclude assignees
    if (excludedAssignees.size > 0) {
        tasks = tasks.filter(t => {
            const assignees = (t.assignees || []).map(a => a.username).filter(Boolean);
            if (assignees.length === 0) return true;
            return assignees.some(name => !excludedAssignees.has(name));
        });
    }

    // Standard filters
    if (statusFilter) tasks = tasks.filter(t => (t.status?.status || 'Unknown') === statusFilter);
    if (priorityFilter) {
        if (priorityFilter === 'none') {
            tasks = tasks.filter(t => !t.priority);
        } else {
            tasks = tasks.filter(t => t.priority?.priority === priorityFilter);
        }
    }
    if (assigneeFilter) tasks = tasks.filter(t => t.assignees?.some(a => a.username === assigneeFilter));
    if (tagFilter) tasks = tasks.filter(t => t.tags?.some(tag => tag.name === tagFilter));

    // Executive filters
    if (phaseFilter) tasks = tasks.filter(t => getTaskPhase(t) === phaseFilter);
    if (agingFilter) tasks = tasks.filter(t => getAgingCategory(getTaskAgeDays(t)) === agingFilter);
    if (riskFilter) tasks = tasks.filter(t => getRiskLevel(t) === riskFilter);

    // Search
    if (search) tasks = tasks.filter(t => t.name.toLowerCase().includes(search));

    filteredTasks = tasks;
    currentPage = 1;
    renderDashboard();
}

// --- Render ---

function renderDashboard() {
    document.getElementById('dashboard').style.display = 'block';
    renderKPIs();
    renderPhaseFlow();
    renderPhaseChart();
    renderPriorityChart();
    renderAssigneeChart();
    renderAgingChart();
    renderTagChart();
    renderRiskChart();
    renderTable();
}

function renderKPIs() {
    const total = filteredTasks.length;
    const completed = filteredTasks.filter(t => {
        const type = t.status?.type;
        return type === 'done' || type === 'closed';
    }).length;
    const inProgress = filteredTasks.filter(t => t.status?.type === 'custom').length;
    const blocked = filteredTasks.filter(t => {
        const risk = getRiskLevel(t);
        return risk === 'high' || risk === 'critical';
    }).length;

    // Average age (exclude done)
    const activeTasks = filteredTasks.filter(t => t.status?.type !== 'done' && t.status?.type !== 'closed');
    const avgAge = activeTasks.length > 0
        ? Math.round(activeTasks.reduce((sum, t) => sum + getTaskAgeDays(t), 0) / activeTasks.length)
        : 0;

    const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;

    document.getElementById('kpiTotal').textContent = total;
    document.getElementById('kpiCompleted').textContent = completed;
    document.getElementById('kpiInProgress').textContent = inProgress;
    document.getElementById('kpiBlocked').textContent = blocked;
    document.getElementById('kpiAvgAge').textContent = avgAge + 'd';
    document.getElementById('kpiThroughput').textContent = completionRate + '%';

    // Trend labels
    const completedPct = total > 0 ? Math.round((completed / total) * 100) : 0;
    const inProgressPct = total > 0 ? Math.round((inProgress / total) * 100) : 0;
    const blockedPct = total > 0 ? Math.round((blocked / total) * 100) : 0;

    setTrend('kpiCompletedPct', `${completedPct}% of total`, completedPct >= 50 ? 'positive' : 'neutral');
    setTrend('kpiInProgressPct', `${inProgressPct}% of total`, 'neutral');
    setTrend('kpiBlockedPct', `${blockedPct}% of total`, blockedPct > 20 ? 'negative' : 'neutral');
    setTrend('kpiAvgAgeTrend', avgAge > 14 ? 'Above target' : 'Within target', avgAge > 14 ? 'negative' : 'positive');
    setTrend('kpiThroughputTrend', completionRate >= 70 ? 'On track' : 'Needs attention', completionRate >= 70 ? 'positive' : 'negative');
}

function setTrend(id, text, type) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = 'exec-kpi-trend ' + type;
}

function renderPhaseFlow() {
    const phaseCounts = {};
    PHASE_ORDER.forEach(p => phaseCounts[p] = 0);

    filteredTasks.forEach(t => {
        const phase = getTaskPhase(t);
        phaseCounts[phase] = (phaseCounts[phase] || 0) + 1;
    });

    const total = filteredTasks.length || 1;

    document.getElementById('phaseFlow').innerHTML = PHASE_ORDER
        .filter(phase => phaseCounts[phase] > 0)
        .map(phase => {
            const count = phaseCounts[phase];
            const pct = Math.round((count / total) * 100);
            const color = PHASE_COLORS[phase];
            return `<div class="phase-flow-item" style="border-top:4px solid ${color};">
                <div class="phase-flow-count" style="color:${color}">${count}</div>
                <div class="phase-flow-label">${phase}</div>
                <div class="phase-flow-pct">${pct}%</div>
            </div>`;
        }).join('');
}

function renderPhaseChart() {
    const phaseCounts = {};
    PHASE_ORDER.forEach(p => phaseCounts[p] = 0);

    filteredTasks.forEach(t => {
        const phase = getTaskPhase(t);
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

    filteredTasks.forEach(t => {
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

function renderAssigneeChart() {
    const assigneeCounts = {};
    filteredTasks.forEach(t => {
        if (t.assignees?.length) {
            t.assignees.forEach(a => {
                const name = a.username || 'Unknown';
                assigneeCounts[name] = (assigneeCounts[name] || 0) + 1;
            });
        } else {
            assigneeCounts['Unassigned'] = (assigneeCounts['Unassigned'] || 0) + 1;
        }
    });

    const sorted = Object.entries(assigneeCounts).sort((a, b) => b[1] - a[1]).slice(0, 12);
    const labels = sorted.map(s => s[0]);
    const data = sorted.map(s => s[1]);

    destroyChart('assigneeChart');
    chartInstances['assigneeChart'] = new Chart(document.getElementById('assigneeChart'), {
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

function renderAgingChart() {
    // Only show aging for active (non-done) tasks
    const activeTasks = filteredTasks.filter(t => t.status?.type !== 'done' && t.status?.type !== 'closed');

    const agingCounts = { 'fresh': 0, 'normal': 0, 'aging': 0, 'stale': 0, 'critical': 0 };
    const agingLabels = { 'fresh': '< 3 days', 'normal': '3–7 days', 'aging': '7–14 days', 'stale': '14–30 days', 'critical': '> 30 days' };
    const agingColors = { 'fresh': '#00d68f', 'normal': '#4da6ff', 'aging': '#ffb547', 'stale': '#ff7747', 'critical': '#ff4d6a' };

    activeTasks.forEach(t => {
        const category = getAgingCategory(getTaskAgeDays(t));
        agingCounts[category]++;
    });

    const keys = Object.keys(agingCounts).filter(k => agingCounts[k] > 0);
    const labels = keys.map(k => agingLabels[k]);
    const data = keys.map(k => agingCounts[k]);
    const colors = keys.map(k => agingColors[k]);

    destroyChart('agingChart');
    chartInstances['agingChart'] = new Chart(document.getElementById('agingChart'), {
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

function renderTagChart() {
    const tagCounts = {};
    filteredTasks.forEach(t => {
        (t.tags || []).forEach(tag => {
            tagCounts[tag.name] = (tagCounts[tag.name] || 0) + 1;
        });
    });

    const sorted = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (sorted.length === 0) { destroyChart('tagChart'); return; }

    const labels = sorted.map(s => s[0]);
    const data = sorted.map(s => s[1]);
    const colors = ['#7c6cf0', '#4da6ff', '#00d68f', '#ffb547', '#ff4d6a', '#f76808', '#b660e0', '#3db88b', '#0df1f1', '#f961f7'];

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

function renderRiskChart() {
    // Only assess risk for active tasks
    const activeTasks = filteredTasks.filter(t => t.status?.type !== 'done' && t.status?.type !== 'closed');

    const riskCounts = { 'low': 0, 'medium': 0, 'high': 0, 'critical': 0 };
    const riskLabels = { 'low': 'Low Risk', 'medium': 'Medium Risk', 'high': 'High Risk', 'critical': 'Critical Risk' };
    const riskColors = { 'low': '#00d68f', 'medium': '#ffb547', 'high': '#ff7747', 'critical': '#ff4d6a' };

    activeTasks.forEach(t => {
        const risk = getRiskLevel(t);
        riskCounts[risk]++;
    });

    const keys = Object.keys(riskCounts).filter(k => riskCounts[k] > 0);
    const labels = keys.map(k => riskLabels[k]);
    const data = keys.map(k => riskCounts[k]);
    const colors = keys.map(k => riskColors[k]);

    destroyChart('riskChart');
    chartInstances['riskChart'] = new Chart(document.getElementById('riskChart'), {
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

function sortBy(field) {
    if (currentSort.field === field) {
        currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
        currentSort.field = field;
        currentSort.direction = field === 'updated' || field === 'age' ? 'desc' : 'asc';
    }
    currentPage = 1;
    renderTable();
}

function renderTable() {
    let tasks = [...filteredTasks];

    // Sort
    tasks.sort((a, b) => {
        let va, vb;
        switch (currentSort.field) {
            case 'name': va = a.name; vb = b.name; break;
            case 'status':
                // Sort by workflow phase order, then by status name within the same phase
                va = PHASE_ORDER.indexOf(getTaskPhase(a));
                vb = PHASE_ORDER.indexOf(getTaskPhase(b));
                if (va === vb) {
                    // Within same phase, sort by status name
                    const sa = (a.status?.status || '').toLowerCase();
                    const sb = (b.status?.status || '').toLowerCase();
                    const cmp = sa.localeCompare(sb);
                    return currentSort.direction === 'asc' ? cmp : -cmp;
                }
                break;
            case 'assignee': va = a.assignees?.[0]?.username || 'zzz'; vb = b.assignees?.[0]?.username || 'zzz'; break;
            case 'priority': va = a.priority?.orderindex || '99'; vb = b.priority?.orderindex || '99'; break;
            case 'age': va = getTaskAgeDays(a); vb = getTaskAgeDays(b); break;
            case 'updated': va = a.date_updated || '0'; vb = b.date_updated || '0'; break;
            default: va = a.date_updated || '0'; vb = b.date_updated || '0';
        }
        if (typeof va === 'string') {
            const cmp = va.localeCompare(vb);
            return currentSort.direction === 'asc' ? cmp : -cmp;
        }
        return currentSort.direction === 'asc' ? va - vb : vb - va;
    });

    document.getElementById('tableStats').textContent = `${tasks.length} tasks`;

    // Paginate
    const totalPages = Math.ceil(tasks.length / PAGE_SIZE);
    if (currentPage > totalPages) currentPage = totalPages || 1;
    const start = (currentPage - 1) * PAGE_SIZE;
    const pageItems = tasks.slice(start, start + PAGE_SIZE);

    const tbody = document.getElementById('breakdownTableBody');
    tbody.innerHTML = pageItems.map(task => {
        const status = task.status?.status || 'Unknown';
        const statusColor = task.status?.color || '#8b99a8';
        const priority = task.priority?.priority || '—';
        const priorityColor = task.priority?.color || '#5a6e82';
        const assignees = task.assignees?.map(a => a.username).join(', ') || '—';
        const updated = task.date_updated ? new Date(parseInt(task.date_updated)).toLocaleDateString() : '—';
        const url = task.url || '#';
        const tags = (task.tags || []).map(tag =>
            `<span class="tag-badge" style="background:${tag.tag_bg}33;color:${tag.tag_fg}">${escapeHtml(tag.name)}</span>`
        ).join('');

        const phase = getTaskPhase(task);
        const phaseColor = PHASE_COLORS[phase] || '#7d8fa3';

        const ageDays = getTaskAgeDays(task);
        const agingCategory = getAgingCategory(ageDays);

        const risk = getRiskLevel(task);

        return `<tr>
            <td><a href="${url}" target="_blank" rel="noopener" class="task-link">${escapeHtml(task.name)}</a></td>
            <td><span class="status-badge" style="background:${statusColor}22;color:${statusColor}">${escapeHtml(status)}</span></td>
            <td><span class="phase-badge" style="background:${phaseColor}18;color:${phaseColor}">${phase}</span></td>
            <td>${escapeHtml(assignees)}</td>
            <td><span class="priority-badge"><span class="priority-dot" style="background:${priorityColor}"></span>${escapeHtml(priority)}</span></td>
            <td>${tags || '—'}</td>
            <td><span class="age-badge age-${agingCategory}">${ageDays}d</span></td>
            <td><span class="risk-badge risk-${risk}">${getRiskIcon(risk)} ${getRiskLabel(risk)}</span></td>
            <td>${updated}</td>
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
    renderTable();
}

// --- Export CSV ---

function exportToCSV() {
    if (filteredTasks.length === 0) {
        alert('No data to export.');
        return;
    }

    const headers = ['Task', 'URL', 'Status', 'Phase', 'Assignee', 'Priority', 'Tags', 'Age (days)', 'Risk', 'Last Updated', 'Created'];

    const rows = filteredTasks.map(task => {
        const status = task.status?.status || '';
        const phase = getTaskPhase(task);
        const assignees = (task.assignees || []).map(a => a.username).join('; ') || '';
        const priority = task.priority?.priority || '';
        const tags = (task.tags || []).map(t => t.name).join('; ') || '';
        const age = getTaskAgeDays(task);
        const risk = getRiskLabel(getRiskLevel(task));
        const updated = task.date_updated ? new Date(parseInt(task.date_updated)).toLocaleDateString() : '';
        const created = task.date_created ? new Date(parseInt(task.date_created)).toLocaleDateString() : '';
        const url = task.url || '';

        return [task.name, url, status, phase, assignees, priority, tags, age, risk, updated, created];
    });

    const csvContent = [headers, ...rows]
        .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
        .join('\n');

    const dateFrom = document.getElementById('dateFrom').value;
    const dateTo = document.getElementById('dateTo').value;
    const filename = `tasks-breakdown_${dateFrom}_to_${dateTo}.csv`;

    const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
}

// --- Helpers ---

function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
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
    const now = new Date();
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    document.getElementById('dateFrom').value = formatDate(firstOfMonth);
    document.getElementById('dateTo').value = formatDate(now);
    fetchBreakdownData();
});
