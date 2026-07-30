// ============================================================
// Developer Progress Page
// Tracks tickets that progressed through development stages
// (assigned to dev → done development → for testing in hotfix)
//
// Developer Attribution Logic:
// - If a task is CURRENTLY in a dev stage → current assignee = developer
// - If a task has MOVED PAST dev (testing/release/done) → the developer
//   is identified from watchers: specifically, watchers who are NOT the
//   current assignee are treated as the original developer(s).
//   The creator is also considered the developer if they are a watcher
//   but not the current assignee.
// ============================================================

const DEFAULT_LIST_ID = '901609965646';

// Use Netlify function proxy if available, otherwise fall back to direct API
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

// Development stages: statuses where developers are working on the task
const DEV_STAGES = [
    'assigned to dev',
    'ongoing dev',
    'done development',
    'ongoing fix',
    'for verification',
    'merged',
    'for deployment to hotfix'
];

// Statuses that mean the dev has finished and task moved beyond dev
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

// All statuses that indicate the task entered the dev pipeline at some point
const DEV_PIPELINE_STATUSES = [...DEV_STAGES, ...PAST_DEV_STATUSES];

let devTasks = [];
let allFetchedDevTasks = []; // Before exclusion filter
let excludedAssignees = new Set();
let chartInstances = {};
let currentSort = { field: 'updated', direction: 'desc' };
let currentPage = 1;
const PAGE_SIZE = 25;

// --- Developer Attribution ---
// For each task, determine who the developer(s) are.
// Returns array of { username, color, initials } objects.
//
// Logic:
// 1. Task in dev stages → current assignee = developer
// 2. Task in TESTING stages → assignee is the TESTER, developer is identified
//    from watchers (non-assignee, non-PM watchers)
// 3. Task in done/release stages:
//    a. If current assignee is a configured TESTER → developer is from watchers
//    b. If current assignee is NOT a configured tester → assignee IS the developer
//
// Roles are configurable from the UI (stored in localStorage).

// Testing stages where the assignee switches to a tester
const TESTING_STAGES = [
    'for testing in staging',
    'for testing in hotfix',
    'ongoing testing',
    'testing: passed',
    'testing: failed'
];

// Role config - stored in localStorage, configurable from UI
function getProjectManagers() {
    const stored = localStorage.getItem('clickup_project_managers');
    return stored ? JSON.parse(stored) : [];
}

function getKnownTesters() {
    const stored = localStorage.getItem('clickup_known_testers');
    return stored ? JSON.parse(stored) : [];
}

function saveRoles() {
    const pms = [...document.querySelectorAll('#pmCheckboxes input:checked')].map(cb => cb.value);
    const testers = [...document.querySelectorAll('#testerCheckboxes input:checked')].map(cb => cb.value);
    localStorage.setItem('clickup_project_managers', JSON.stringify(pms));
    localStorage.setItem('clickup_known_testers', JSON.stringify(testers));
    renderDevDashboard();
}

function populateRoleConfig() {
    // Collect all unique people from tasks
    const people = new Set();
    allFetchedDevTasks.forEach(t => {
        (t.assignees || []).forEach(a => { if (a.username) people.add(a.username); });
        (t.watchers || []).forEach(w => { if (w.username) people.add(w.username); });
        if (t.creator?.username) people.add(t.creator.username);
    });

    const sorted = [...people].sort();
    const pms = getProjectManagers();
    const testers = getKnownTesters();

    document.getElementById('pmCheckboxes').innerHTML = sorted.map(name =>
        `<label class="role-chip ${pms.includes(name) ? 'selected' : ''}">
            <input type="checkbox" value="${escapeHtml(name)}" ${pms.includes(name) ? 'checked' : ''}>
            <span>${escapeHtml(name)}</span>
        </label>`
    ).join('');

    document.getElementById('testerCheckboxes').innerHTML = sorted.map(name =>
        `<label class="role-chip ${testers.includes(name) ? 'selected' : ''}">
            <input type="checkbox" value="${escapeHtml(name)}" ${testers.includes(name) ? 'checked' : ''}>
            <span>${escapeHtml(name)}</span>
        </label>`
    ).join('');

    // Attach event listeners
    document.querySelectorAll('#pmCheckboxes .role-chip, #testerCheckboxes .role-chip').forEach(chip => {
        chip.addEventListener('click', function(e) {
            e.preventDefault();
            const cb = this.querySelector('input[type="checkbox"]');
            cb.checked = !cb.checked;
            this.classList.toggle('selected', cb.checked);
            saveRoles();
        });
    });
}

function getDevelopers(task) {
    const status = (task.status?.status || '').toLowerCase();
    const currentAssignees = (task.assignees || []);
    const currentAssigneeNames = currentAssignees.map(a => a.username);
    const projectManagers = getProjectManagers();
    const knownTesters = getKnownTesters();

    // 1. Task is in dev stages → current assignee is the developer
    if (DEV_STAGES.includes(status)) {
        return currentAssignees.length > 0 ? currentAssignees : (task.creator ? [task.creator] : []);
    }

    // 2. Task is in TESTING stages → assignee might be the tester OR self-testing
    if (TESTING_STAGES.includes(status)) {
        return getDevFromWatchers(task, currentAssigneeNames, projectManagers, true);
    }

    // 3. Task is in done/release stages
    //    Check if current assignee is a known tester
    const assigneeIsTester = currentAssigneeNames.some(name => knownTesters.includes(name));

    if (assigneeIsTester) {
        // Assignee is definitely a tester → do NOT fall back to assignee
        return getDevFromWatchers(task, currentAssigneeNames, projectManagers, false);
    }

    // Current assignee is the developer (they stayed assigned through completion)
    if (currentAssignees.length > 0) {
        return currentAssignees;
    }

    // Fallback: creator
    return task.creator ? [task.creator] : [];
}

// Helper: find developers from watchers list (excluding current assignees and PMs)
// allowAssigneeFallback: if true, when no dev found in watchers, assume assignee is self-testing
//                        if false, the assignee is definitely a tester, fall back to creator instead
function getDevFromWatchers(task, currentAssigneeNames, projectManagers, allowAssigneeFallback) {
    const watchers = task.watchers || [];

    // Get watchers who are not the current assignee and not a PM
    let developers = watchers.filter(w =>
        !currentAssigneeNames.includes(w.username) &&
        !projectManagers.includes(w.username)
    );

    if (developers.length > 0) {
        return developers;
    }

    // No non-PM, non-assignee watchers found
    if (allowAssigneeFallback) {
        // Testing stage: assignee is likely self-testing (both dev and tester)
        const assigneeObjects = (task.assignees || []);
        if (assigneeObjects.length > 0) {
            return assigneeObjects;
        }
    }

    // Assignee is a known tester or no assignees available
    // Try including PMs as last resort (PM might also be the dev)
    let devsWithPM = watchers.filter(w => !currentAssigneeNames.includes(w.username));
    if (devsWithPM.length > 0) {
        return devsWithPM;
    }

    // Absolute fallback: creator
    return task.creator ? [task.creator] : [];
}

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
        case 'custom':
            return;
    }

    document.getElementById('dateFrom').value = formatDate(from);
    document.getElementById('dateTo').value = formatDate(to);
    fetchDevData();
}

function onDateChange() {
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
}

function formatDate(d) {
    return d.toISOString().split('T')[0];
}

// --- API ---

async function fetchDevData() {
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

        // Filter: only tasks that are in dev pipeline statuses (not Open, not deferred, not pending review)
        devTasks = tasks.filter(t => {
            const status = (t.status?.status || '').toLowerCase();
            return DEV_PIPELINE_STATUSES.includes(status);
        });

        allFetchedDevTasks = [...devTasks];
        populateRoleConfig();
        populateExcludeCheckboxes();
        applyExclusions();

        document.getElementById('dateRangeInfo').textContent =
            `${tasks.length} tasks updated in range → ${devTasks.length} in development pipeline`;

        renderDevDashboard();

    } catch (err) {
        showError(err.message);
    } finally {
        showLoading(false);
    }
}

// --- Exclude Assignees ---

function populateExcludeCheckboxes() {
    const assignees = new Set();
    allFetchedDevTasks.forEach(t => {
        getDevelopers(t).forEach(a => {
            if (a.username) assignees.add(a.username);
        });
    });

    const sorted = [...assignees].sort();
    const container = document.getElementById('excludeCheckboxes');

    // Preserve previously excluded state
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
    renderDevDashboard();
}

function applyExclusions() {
    if (excludedAssignees.size === 0) {
        devTasks = [...allFetchedDevTasks];
    } else {
        devTasks = allFetchedDevTasks.filter(t => {
            // Exclude tasks where ALL developers are excluded
            const devs = getDevelopers(t).map(a => a.username).filter(Boolean);
            if (devs.length === 0) return true; // keep unassigned
            return devs.some(name => !excludedAssignees.has(name));
        });
    }

    document.getElementById('dateRangeInfo').textContent =
        `${allFetchedDevTasks.length} in dev pipeline` +
        (excludedAssignees.size > 0 ? ` → ${devTasks.length} after excluding ${excludedAssignees.size} developer(s)` : '');
}

// --- Render ---

function renderDevDashboard() {
    document.getElementById('dashboard').style.display = 'block';
    renderDevKPIs();
    renderDevBarChart();
    renderDevOutputChart();
    renderDevStageChart();
    renderDevSpeedChart();
    renderDevGrid();
    populateFilters();
    renderDevTable();
}

function renderDevKPIs() {
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

    document.getElementById('totalDevTasks').textContent = devTasks.length;
    document.getElementById('devCompletedTasks').textContent = movedToTesting.length;
    document.getElementById('stillInDev').textContent = stillInDev.length;
    document.getElementById('fixingTasks').textContent = fixing.length;
    document.getElementById('devThroughputRate').textContent = throughput + '%';
}

function renderDevBarChart() {
    const devCounts = {};

    devTasks.forEach(t => {
        const devs = getDevelopers(t);
        devs.forEach(a => {
            const name = a.username || 'Unknown';
            devCounts[name] = (devCounts[name] || 0) + 1;
        });
        if (devs.length === 0) {
            devCounts['Unassigned'] = (devCounts['Unassigned'] || 0) + 1;
        }
    });

    const sorted = Object.entries(devCounts).sort((a, b) => b[1] - a[1]);
    const labels = sorted.map(s => s[0]);
    const data = sorted.map(s => s[1]);

    destroyChart('devBarChart');
    chartInstances['devBarChart'] = new Chart(document.getElementById('devBarChart'), {
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

function renderDevOutputChart() {
    // Stacked bar: per developer, show "moved to testing" vs "still in dev"
    const devData = {};

    devTasks.forEach(t => {
        const status = (t.status?.status || '').toLowerCase();
        const isPastDev = PAST_DEV_STATUSES.includes(status);

        const devs = getDevelopers(t);
        devs.forEach(a => {
            const name = a.username || 'Unknown';
            if (!devData[name]) devData[name] = { done: 0, inProgress: 0 };
            if (isPastDev) {
                devData[name].done++;
            } else {
                devData[name].inProgress++;
            }
        });
    });

    const sorted = Object.entries(devData).sort((a, b) => (b[1].done + b[1].inProgress) - (a[1].done + a[1].inProgress));
    const labels = sorted.map(s => s[0]);
    const doneData = sorted.map(s => s[1].done);
    const inProgressData = sorted.map(s => s[1].inProgress);

    destroyChart('devOutputChart');
    chartInstances['devOutputChart'] = new Chart(document.getElementById('devOutputChart'), {
        type: 'bar',
        data: {
            labels,
            datasets: [
                {
                    label: 'Moved to Testing+',
                    data: doneData,
                    backgroundColor: '#00d68f',
                    borderRadius: 4,
                    maxBarThickness: 35
                },
                {
                    label: 'Still in Dev',
                    data: inProgressData,
                    backgroundColor: '#ffb547',
                    borderRadius: 4,
                    maxBarThickness: 35
                }
            ]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            plugins: {
                legend: { labels: { color: '#7d8fa3', padding: 16 } }
            },
            scales: {
                x: { stacked: true, ticks: { color: '#7d8fa3', stepSize: 5 }, grid: { color: 'rgba(125,143,163,0.08)' } },
                y: { stacked: true, ticks: { color: '#7d8fa3', font: { size: 11 } }, grid: { display: false } }
            }
        }
    });
}

function renderDevStageChart() {
    const stageCounts = {};
    const stageColors = {};

    devTasks.forEach(t => {
        const s = t.status?.status || 'Unknown';
        stageCounts[s] = (stageCounts[s] || 0) + 1;
        if (t.status?.color) stageColors[s] = t.status.color;
    });

    const sorted = Object.entries(stageCounts).sort((a, b) => b[1] - a[1]);
    const labels = sorted.map(s => s[0]);
    const data = sorted.map(s => s[1]);
    const colors = labels.map(l => stageColors[l] || '#7c6cf0');

    destroyChart('devStageChart');
    chartInstances['devStageChart'] = new Chart(document.getElementById('devStageChart'), {
        type: 'doughnut',
        data: {
            labels,
            datasets: [{ data, backgroundColor: colors, borderWidth: 0, hoverOffset: 8 }]
        },
        options: {
            responsive: true,
            cutout: '50%',
            plugins: {
                legend: { position: 'right', labels: { color: '#7d8fa3', padding: 8, font: { size: 10 } } }
            }
        }
    });
}

function renderDevSpeedChart() {
    // Average days from creation to reaching testing (for tasks that moved past dev)
    const devTimes = {};

    devTasks.forEach(t => {
        const status = (t.status?.status || '').toLowerCase();
        if (!PAST_DEV_STATUSES.includes(status)) return; // Only tasks that reached testing
        if (!t.date_created || !t.date_updated) return;

        const days = (parseInt(t.date_updated) - parseInt(t.date_created)) / (1000 * 60 * 60 * 24);
        if (days < 0 || days > 180) return;

        const devs = getDevelopers(t);
        devs.forEach(a => {
            const name = a.username || 'Unknown';
            if (!devTimes[name]) devTimes[name] = [];
            devTimes[name].push(days);
        });
    });

    const averages = Object.entries(devTimes)
        .map(([name, times]) => ({
            name,
            avg: times.reduce((a, b) => a + b, 0) / times.length,
            count: times.length
        }))
        .filter(a => a.count >= 2)
        .sort((a, b) => a.avg - b.avg);

    if (averages.length === 0) {
        destroyChart('devSpeedChart');
        return;
    }

    const labels = averages.map(a => `${a.name} (${a.count})`);
    const data = averages.map(a => Math.round(a.avg * 10) / 10);

    destroyChart('devSpeedChart');
    chartInstances['devSpeedChart'] = new Chart(document.getElementById('devSpeedChart'), {
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

    const sorted = Object.values(devData).sort((a, b) => b.total - a.total);

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
            const priorityColor = t.priority?.color || '';
            return `<div class="dev-task-item">
                <span class="dev-task-dot" style="background:${statusColor}"></span>
                <a href="${t.url || '#'}" target="_blank" rel="noopener" class="dev-task-name">${escapeHtml(t.name)}</a>
                ${priorityColor ? `<span class="dev-task-priority" style="background:${priorityColor}"></span>` : ''}
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

// --- Table ---

function populateFilters() {
    const devs = [...new Set(devTasks.flatMap(t => getDevelopers(t).map(a => a.username)))].filter(Boolean).sort();
    const stages = [...new Set(devTasks.map(t => t.status?.status || 'Unknown'))].sort();

    document.getElementById('filterDev').innerHTML =
        '<option value="">All Developers</option>' + devs.map(d => `<option value="${d}">${d}</option>`).join('');
    document.getElementById('filterStage').innerHTML =
        '<option value="">All Stages</option>' + stages.map(s => `<option value="${s}">${s}</option>`).join('');
}

function getFilteredTasks() {
    const devFilter = document.getElementById('filterDev').value;
    const stageFilter = document.getElementById('filterStage').value;
    const search = document.getElementById('filterSearch').value.toLowerCase();

    let filtered = devTasks;

    if (devFilter) filtered = filtered.filter(t => getDevelopers(t).some(a => a.username === devFilter));
    if (stageFilter) filtered = filtered.filter(t => (t.status?.status || 'Unknown') === stageFilter);
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
    renderDevTable();
}

function renderDevTable() {
    let filtered = getFilteredTasks();

    filtered.sort((a, b) => {
        let va, vb;
        switch (currentSort.field) {
            case 'name': va = a.name; vb = b.name; break;
            case 'status': va = a.status?.orderindex || 0; vb = b.status?.orderindex || 0; break;
            case 'assignee': va = getDevelopers(a)?.[0]?.username || 'zzz'; vb = getDevelopers(b)?.[0]?.username || 'zzz'; break;
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

    document.getElementById('tableStats').textContent = `${filtered.length} developer tasks`;

    const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
    if (currentPage > totalPages) currentPage = totalPages || 1;
    const start = (currentPage - 1) * PAGE_SIZE;
    const pageItems = filtered.slice(start, start + PAGE_SIZE);

    const tbody = document.getElementById('devTableBody');
    tbody.innerHTML = pageItems.map(task => {
        const status = task.status?.status || 'Unknown';
        const statusColor = task.status?.color || '#8b99a8';
        const priority = task.priority?.priority || '—';
        const priorityColor = task.priority?.color || '#5a6e82';
        const devs = getDevelopers(task);
        const devNames = devs.map(a => a.username).join(', ') || '—';
        const updated = task.date_updated ? new Date(parseInt(task.date_updated)).toLocaleDateString() : '—';
        const created = task.date_created ? new Date(parseInt(task.date_created)).toLocaleDateString() : '—';
        const url = task.url || '#';
        const tags = (task.tags || []).map(tag =>
            `<span class="tag-badge" style="background:${tag.tag_bg}33;color:${tag.tag_fg}">${escapeHtml(tag.name)}</span>`
        ).join('');

        return `<tr>
            <td><a href="${url}" target="_blank" rel="noopener" class="task-link">${escapeHtml(task.name)}</a></td>
            <td><span class="status-badge" style="background:${statusColor}22;color:${statusColor}">${escapeHtml(status)}</span></td>
            <td>${escapeHtml(devNames)}</td>
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
    renderDevTable();
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
    const now = new Date();
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    document.getElementById('dateFrom').value = formatDate(firstOfMonth);
    document.getElementById('dateTo').value = formatDate(now);
    fetchDevData();
});
