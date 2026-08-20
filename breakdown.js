// ============================================================
// Tasks Breakdown
// Developer card view showing task breakdown per developer
// with throughput stats, progress bars, and task lists.
// Matches the Developer Breakdown style from developers page.
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

// Development stages
const DEV_STAGES = [
    'assigned to dev',
    'ongoing dev',
    'done development',
    'ongoing fix',
    'for verification',
    'merged',
    'for deployment to hotfix'
];

// Statuses past dev
const PAST_DEV_STATUSES = [
    'for testing in staging',
    'for testing in hotfix',
    'ongoing testing',
    'testing: passed',
    'testing: failed',
    'for release',
    'resolved - no code changes',
    'released to prod',
    'closed'
];

const DEV_PIPELINE_STATUSES = [...DEV_STAGES, ...PAST_DEV_STATUSES];

// Testing stages where assignee is the tester
const TESTING_STAGES = [
    'for testing in staging',
    'for testing in hotfix',
    'ongoing testing',
    'testing: passed',
    'testing: failed'
];

let allTasks = [];
let devTasks = [];
let allFetchedTasks = [];
let excludedAssignees = new Set();
let selectedStatuses = new Set(); // multi-select status filter
let currentSort = 'total-desc'; // default sort for cards

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

// --- Roles ---

function getProjectManagers() {
    const stored = localStorage.getItem('clickup_project_managers');
    return stored ? JSON.parse(stored) : [];
}

function getKnownTesters() {
    const stored = localStorage.getItem('clickup_known_testers');
    return stored ? JSON.parse(stored) : [];
}

// --- Developer Attribution ---

function getDevelopers(task) {
    const status = (task.status?.status || '').toLowerCase();
    const currentAssignees = (task.assignees || []);
    const currentAssigneeNames = currentAssignees.map(a => a.username);
    const projectManagers = getProjectManagers();
    const knownTesters = getKnownTesters();

    if (DEV_STAGES.includes(status)) {
        return currentAssignees.length > 0 ? currentAssignees : (task.creator ? [task.creator] : []);
    }

    if (TESTING_STAGES.includes(status)) {
        return getDevFromWatchers(task, currentAssigneeNames, projectManagers, true);
    }

    const assigneeIsTester = currentAssigneeNames.some(name => knownTesters.includes(name));
    if (assigneeIsTester) {
        return getDevFromWatchers(task, currentAssigneeNames, projectManagers, false);
    }

    if (currentAssignees.length > 0) {
        return currentAssignees;
    }

    return task.creator ? [task.creator] : [];
}

function getDevFromWatchers(task, currentAssigneeNames, projectManagers, allowAssigneeFallback) {
    const watchers = task.watchers || [];

    let developers = watchers.filter(w =>
        !currentAssigneeNames.includes(w.username) &&
        !projectManagers.includes(w.username)
    );

    if (developers.length > 0) return developers;

    if (allowAssigneeFallback) {
        const assigneeObjects = (task.assignees || []);
        if (assigneeObjects.length > 0) return assigneeObjects;
    }

    let devsWithPM = watchers.filter(w => !currentAssigneeNames.includes(w.username));
    if (devsWithPM.length > 0) return devsWithPM;

    return task.creator ? [task.creator] : [];
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

        // Include ALL tasks — no status pipeline filtering
        allTasks = tasks;
        devTasks = [...tasks];

        allFetchedTasks = [...devTasks];
        populateExcludeCheckboxes();
        populateFilterDropdowns();
        applyFiltersAndRender();

        document.getElementById('dateRangeInfo').textContent =
            `${tasks.length} tasks loaded in range`;

    } catch (err) {
        showError(err.message);
    } finally {
        showLoading(false);
    }
}

// --- Exclude Assignees ---

function populateExcludeCheckboxes() {
    const assignees = new Set();
    allFetchedTasks.forEach(t => {
        getDevelopers(t).forEach(a => {
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
    const statuses = [...new Set(allFetchedTasks.map(t => t.status?.status || 'Unknown'))].sort();
    const priorities = ['urgent', 'high', 'normal', 'low'];
    const assignees = [...new Set(allFetchedTasks.flatMap(t => getDevelopers(t).map(a => a.username)))].filter(Boolean).sort();
    const tags = [...new Set(allFetchedTasks.flatMap(t => (t.tags || []).map(tag => tag.name)))].filter(Boolean).sort();

    // Multi-select status chips
    const statusContainer = document.getElementById('filterStatusChips');
    statusContainer.innerHTML = statuses.map(s => {
        const isSelected = selectedStatuses.has(s);
        return `<label class="status-chip ${isSelected ? 'active' : ''}" onclick="toggleStatusFilter('${escapeHtml(s)}', this)">
            <span>${escapeHtml(s)}</span>
        </label>`;
    }).join('');

    document.getElementById('filterPriority').innerHTML =
        '<option value="">All Priorities</option>' + priorities.map(p => `<option value="${p}">${capitalize(p)}</option>`).join('');
    document.getElementById('filterAssignee').innerHTML =
        '<option value="">All Assignees</option>' + assignees.map(a => `<option value="${a}">${a}</option>`).join('');
    document.getElementById('filterTag').innerHTML =
        '<option value="">All Tags</option>' + tags.map(t => `<option value="${t}">${t}</option>`).join('');
}

function toggleStatusFilter(status, el) {
    if (selectedStatuses.has(status)) {
        selectedStatuses.delete(status);
        el.classList.remove('active');
    } else {
        selectedStatuses.add(status);
        el.classList.add('active');
    }
    applyFiltersAndRender();
}

function clearStatusFilter() {
    selectedStatuses.clear();
    document.querySelectorAll('.status-chip').forEach(chip => chip.classList.remove('active'));
    applyFiltersAndRender();
}

// --- Apply Filters & Render ---

function applyFiltersAndRender() {
    const priorityFilter = document.getElementById('filterPriority').value;
    const assigneeFilter = document.getElementById('filterAssignee').value;
    const tagFilter = document.getElementById('filterTag').value;
    const phaseFilter = document.getElementById('filterPhase').value;

    let tasks = [...allFetchedTasks];

    // Exclude assignees
    if (excludedAssignees.size > 0) {
        tasks = tasks.filter(t => {
            const devs = getDevelopers(t).map(a => a.username).filter(Boolean);
            if (devs.length === 0) return true;
            return devs.some(name => !excludedAssignees.has(name));
        });
    }

    // Multi-select status filter
    if (selectedStatuses.size > 0) {
        tasks = tasks.filter(t => selectedStatuses.has(t.status?.status || 'Unknown'));
    }

    // Other filters
    if (priorityFilter) {
        tasks = tasks.filter(t => t.priority?.priority === priorityFilter);
    }
    if (assigneeFilter) tasks = tasks.filter(t => getDevelopers(t).some(a => a.username === assigneeFilter));
    if (tagFilter) tasks = tasks.filter(t => t.tags?.some(tag => tag.name === tagFilter));
    if (phaseFilter) {
        tasks = tasks.filter(t => {
            const status = (t.status?.status || '').toLowerCase();
            if (phaseFilter === 'Development') return DEV_STAGES.includes(status);
            if (phaseFilter === 'Testing') return TESTING_STAGES.includes(status);
            if (phaseFilter === 'Release') return ['merged', 'for deployment to hotfix', 'for release'].includes(status);
            if (phaseFilter === 'Done') return ['released to prod', 'resolved - no code changes', 'closed'].includes(status);
            if (phaseFilter === 'Blocked') return status === 'testing: failed';
            if (phaseFilter === 'Backlog') return ['open', 'defrerred', 'pending review (qa)', 'ongoing review'].includes(status);
            return true;
        });
    }

    devTasks = tasks;

    const filterInfo = [];
    if (excludedAssignees.size > 0) filterInfo.push(`excluding ${excludedAssignees.size} developer(s)`);
    if (selectedStatuses.size > 0) filterInfo.push(`${selectedStatuses.size} status(es) selected`);
    if (priorityFilter || assigneeFilter || tagFilter || phaseFilter) filterInfo.push('filters active');

    document.getElementById('dateRangeInfo').textContent =
        `${allFetchedTasks.length} total tasks` +
        (filterInfo.length > 0 ? ` → ${devTasks.length} shown (${filterInfo.join(', ')})` : '');

    renderDashboard();
}

// --- Render ---

function renderDashboard() {
    document.getElementById('dashboard').style.display = 'block';
    renderKPIs();
    renderDevGrid();
}

function renderKPIs() {
    const movedToTesting = devTasks.filter(t => {
        const s = (t.status?.status || '').toLowerCase();
        return PAST_DEV_STATUSES.includes(s);
    });

    const stillInDev = devTasks.filter(t => {
        const s = (t.status?.status || '').toLowerCase();
        return DEV_STAGES.includes(s);
    });

    const fixing = devTasks.filter(t => {
        const s = (t.status?.status || '').toLowerCase();
        return s === 'ongoing fix';
    });

    const throughput = devTasks.length > 0
        ? Math.round((movedToTesting.length / devTasks.length) * 100)
        : 0;

    document.getElementById('kpiTotal').textContent = devTasks.length;
    document.getElementById('kpiToTesting').textContent = movedToTesting.length;
    document.getElementById('kpiStillInDev').textContent = stillInDev.length;
    document.getElementById('kpiFixing').textContent = fixing.length;
    document.getElementById('kpiThroughput').textContent = throughput + '%';
}

// --- Developer Cards ---

function renderDevGrid() {
    const devData = {};

    devTasks.forEach(t => {
        const status = (t.status?.status || '').toLowerCase();
        const isPastDev = PAST_DEV_STATUSES.includes(status);
        const isStillInDev = DEV_STAGES.includes(status);

        const devs = getDevelopers(t);
        devs.forEach(a => {
            const name = a.username || 'Unknown';
            if (!devData[name]) {
                devData[name] = {
                    name,
                    color: a.color || '#7c6cf0',
                    initials: a.initials || '?',
                    total: 0,
                    movedToTesting: 0,
                    stillInDev: 0,
                    fixing: 0,
                    tasks: []
                };
            }
            devData[name].total++;
            devData[name].tasks.push(t);

            if (isPastDev) devData[name].movedToTesting++;
            else if (isStillInDev) devData[name].stillInDev++;
            if (status === 'ongoing fix') devData[name].fixing++;
        });
    });

    // Sort by status phase order within each card's tasks, and sort cards by total
    const sorted = Object.values(devData).sort((a, b) => b.total - a.total);

    // Sort tasks within each developer by status workflow order
    const STATUS_ORDER = [
        ...PAST_DEV_STATUSES.slice().reverse(), // done statuses last
        ...DEV_STAGES.slice().reverse()
    ];

    sorted.forEach(dev => {
        dev.tasks.sort((a, b) => {
            const sa = (a.status?.status || '').toLowerCase();
            const sb = (b.status?.status || '').toLowerCase();
            const ia = STATUS_ORDER.indexOf(sa);
            const ib = STATUS_ORDER.indexOf(sb);
            return ia - ib;
        });
    });

    document.getElementById('devGrid').innerHTML = sorted.map(dev => {
        const throughput = dev.total > 0 ? Math.round((dev.movedToTesting / dev.total) * 100) : 0;

        // Progress bar segments
        const movedPct = dev.total > 0 ? (dev.movedToTesting / dev.total) * 100 : 0;
        const devPct = dev.total > 0 ? (dev.stillInDev / dev.total) * 100 : 0;
        const fixPct = dev.total > 0 ? (dev.fixing / dev.total) * 100 : 0;

        // Task list
        const tasksList = dev.tasks.slice(0, 8).map(t => {
            const statusColor = t.status?.color || '#8b99a8';
            const statusName = t.status?.status || '?';
            return `<div class="dev-task-item">
                <span class="dev-task-dot" style="background:${statusColor}"></span>
                <a href="${t.url || '#'}" target="_blank" rel="noopener" class="dev-task-name">${escapeHtml(t.name)}</a>
                <span class="dev-task-status">${escapeHtml(statusName)}</span>
            </div>`;
        }).join('');

        const moreCount = dev.tasks.length > 8
            ? `<div class="dev-task-item" style="color:var(--text-dim);font-style:italic;">+${dev.tasks.length - 8} more tickets</div>`
            : '';

        return `<div class="dev-card">
            <div class="dev-card-header">
                <div class="dev-avatar" style="background:${dev.color}">${dev.initials}</div>
                <div>
                    <div class="dev-name">${escapeHtml(dev.name)}</div>
                    <div class="dev-summary">${dev.total} tickets · ${throughput}% throughput</div>
                </div>
            </div>
            <div class="dev-stats-row">
                <div class="dev-stat-box">
                    <div class="dev-stat-value">${dev.total}</div>
                    <div class="dev-stat-label">Total</div>
                </div>
                <div class="dev-stat-box">
                    <div class="dev-stat-value" style="color:#00d68f">${dev.movedToTesting}</div>
                    <div class="dev-stat-label">To Testing</div>
                </div>
                <div class="dev-stat-box">
                    <div class="dev-stat-value" style="color:#ffb547">${dev.stillInDev}</div>
                    <div class="dev-stat-label">In Dev</div>
                </div>
                <div class="dev-stat-box">
                    <div class="dev-stat-value" style="color:#ff4d6a">${dev.fixing}</div>
                    <div class="dev-stat-label">Fixing</div>
                </div>
            </div>
            <div class="dev-progress-bar">
                <div class="dev-progress-segment" style="width:${movedPct}%;background:#00d68f"></div>
                <div class="dev-progress-segment" style="width:${devPct}%;background:#ffb547"></div>
                <div class="dev-progress-segment" style="width:${fixPct}%;background:#ff4d6a"></div>
            </div>
            <div class="dev-progress-legend">
                <span class="dev-legend-item"><span class="dev-legend-dot" style="background:#00d68f"></span>To Testing</span>
                <span class="dev-legend-item"><span class="dev-legend-dot" style="background:#ffb547"></span>In Dev</span>
                <span class="dev-legend-item"><span class="dev-legend-dot" style="background:#ff4d6a"></span>Fixing</span>
            </div>
            <div class="dev-tasks-list">
                ${tasksList}
                ${moreCount}
            </div>
        </div>`;
    }).join('');
}

// --- Helpers ---

function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
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
