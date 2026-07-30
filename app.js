// ============================================================
// ClickUp Dashboard - Client-Side App
// Pulls data directly from ClickUp API via browser
// ============================================================

let allTasks = [];
let chartInstances = {};

// --- Config Management ---

function loadConfig() {
    const config = {
        apiKey: localStorage.getItem('clickup_api_key') || '',
        listId: localStorage.getItem('clickup_list_id') || '',
        teamId: localStorage.getItem('clickup_team_id') || ''
    };
    document.getElementById('apiKey').value = config.apiKey;
    document.getElementById('listId').value = config.listId;
    document.getElementById('teamId').value = config.teamId;
    return config;
}

function saveConfig() {
    const apiKey = document.getElementById('apiKey').value.trim();
    const listId = document.getElementById('listId').value.trim();
    const teamId = document.getElementById('teamId').value.trim();

    if (!apiKey || !listId) {
        showError('API Key and List ID are required.');
        return;
    }

    localStorage.setItem('clickup_api_key', apiKey);
    localStorage.setItem('clickup_list_id', listId);
    localStorage.setItem('clickup_team_id', teamId);

    fetchTasks();
}

function toggleConfig() {
    const panel = document.getElementById('configPanel');
    const showBtn = document.getElementById('showConfigBtn');
    if (panel.style.display === 'none') {
        panel.style.display = 'block';
        showBtn.style.display = 'none';
    } else {
        panel.style.display = 'none';
        showBtn.style.display = 'block';
    }
}

// --- API Calls ---

async function fetchTasks() {
    const apiKey = localStorage.getItem('clickup_api_key');
    const listId = localStorage.getItem('clickup_list_id');

    if (!apiKey || !listId) {
        document.getElementById('configPanel').style.display = 'block';
        document.getElementById('showConfigBtn').style.display = 'none';
        return;
    }

    showLoading(true);
    hideError();

    try {
        let tasks = [];
        let page = 0;
        let hasMore = true;

        // Paginate through all tasks (ClickUp returns 100 per page)
        while (hasMore) {
            const response = await fetch(
                `https://api.clickup.com/api/v2/list/${listId}/task?page=${page}&subtasks=true&include_closed=true`,
                {
                    headers: {
                        'Authorization': apiKey,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (!response.ok) {
                if (response.status === 401) {
                    throw new Error('Invalid API key. Check your ClickUp API token.');
                }
                if (response.status === 404) {
                    throw new Error('List not found. Check your List ID.');
                }
                throw new Error(`ClickUp API error: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            tasks = tasks.concat(data.tasks || []);
            hasMore = !data.last_page;
            page++;
        }

        allTasks = tasks;
        renderDashboard();
        document.getElementById('lastUpdated').textContent =
            `Last updated: ${new Date().toLocaleTimeString()}`;

        // Hide config after successful load
        document.getElementById('configPanel').style.display = 'none';
        document.getElementById('showConfigBtn').style.display = 'block';

    } catch (err) {
        showError(err.message);
    } finally {
        showLoading(false);
    }
}

// --- Rendering ---

function renderDashboard() {
    document.getElementById('dashboard').style.display = 'block';

    renderKPIs();
    renderStatusChart();
    renderPriorityChart();
    renderAssigneeChart();
    renderTimelineChart();
    populateFilters();
    renderTable();
}

function renderKPIs() {
    const now = Date.now();
    const open = allTasks.filter(t => isOpen(t));
    const inProgress = allTasks.filter(t => isInProgress(t));
    const done = allTasks.filter(t => isDone(t));
    const overdue = allTasks.filter(t => {
        return t.due_date && parseInt(t.due_date) < now && !isDone(t);
    });

    document.getElementById('totalTasks').textContent = allTasks.length;
    document.getElementById('openTasks').textContent = open.length;
    document.getElementById('inProgressTasks').textContent = inProgress.length;
    document.getElementById('doneTasks').textContent = done.length;
    document.getElementById('overdueTasks').textContent = overdue.length;
}

function renderStatusChart() {
    const statusCounts = {};
    const statusColors = {};

    allTasks.forEach(task => {
        const status = task.status?.status || 'Unknown';
        statusCounts[status] = (statusCounts[status] || 0) + 1;
        if (task.status?.color) {
            statusColors[status] = task.status.color;
        }
    });

    const labels = Object.keys(statusCounts);
    const data = Object.values(statusCounts);
    const colors = labels.map(l => statusColors[l] || '#6c5ce7');

    destroyChart('statusChart');
    chartInstances['statusChart'] = new Chart(
        document.getElementById('statusChart'),
        {
            type: 'doughnut',
            data: {
                labels,
                datasets: [{
                    data,
                    backgroundColor: colors,
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { color: '#8b99a8', padding: 16 }
                    }
                }
            }
        }
    );
}

function renderPriorityChart() {
    const priorityMap = {
        1: { name: 'Urgent', color: '#e17055' },
        2: { name: 'High', color: '#fdcb6e' },
        3: { name: 'Normal', color: '#74b9ff' },
        4: { name: 'Low', color: '#8b99a8' }
    };

    const priorityCounts = { 'Urgent': 0, 'High': 0, 'Normal': 0, 'Low': 0, 'None': 0 };

    allTasks.forEach(task => {
        const p = task.priority;
        if (p && priorityMap[p.id]) {
            priorityCounts[priorityMap[p.id].name]++;
        } else {
            priorityCounts['None']++;
        }
    });

    const labels = Object.keys(priorityCounts).filter(k => priorityCounts[k] > 0);
    const data = labels.map(l => priorityCounts[l]);
    const colorMap = { 'Urgent': '#e17055', 'High': '#fdcb6e', 'Normal': '#74b9ff', 'Low': '#8b99a8', 'None': '#4a5568' };
    const colors = labels.map(l => colorMap[l]);

    destroyChart('priorityChart');
    chartInstances['priorityChart'] = new Chart(
        document.getElementById('priorityChart'),
        {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    data,
                    backgroundColor: colors,
                    borderRadius: 6
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    x: {
                        ticks: { color: '#8b99a8' },
                        grid: { display: false }
                    },
                    y: {
                        ticks: { color: '#8b99a8', stepSize: 1 },
                        grid: { color: 'rgba(139,153,168,0.1)' }
                    }
                }
            }
        }
    );
}

function renderAssigneeChart() {
    const assigneeCounts = {};

    allTasks.forEach(task => {
        if (task.assignees && task.assignees.length > 0) {
            task.assignees.forEach(a => {
                const name = a.username || a.email || 'Unknown';
                assigneeCounts[name] = (assigneeCounts[name] || 0) + 1;
            });
        } else {
            assigneeCounts['Unassigned'] = (assigneeCounts['Unassigned'] || 0) + 1;
        }
    });

    // Sort by count descending
    const sorted = Object.entries(assigneeCounts).sort((a, b) => b[1] - a[1]);
    const labels = sorted.map(s => s[0]);
    const data = sorted.map(s => s[1]);

    destroyChart('assigneeChart');
    chartInstances['assigneeChart'] = new Chart(
        document.getElementById('assigneeChart'),
        {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    data,
                    backgroundColor: '#6c5ce7',
                    borderRadius: 6
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    x: {
                        ticks: { color: '#8b99a8', stepSize: 1 },
                        grid: { color: 'rgba(139,153,168,0.1)' }
                    },
                    y: {
                        ticks: { color: '#8b99a8' },
                        grid: { display: false }
                    }
                }
            }
        }
    );
}

function renderTimelineChart() {
    // Group tasks by creation week
    const weekCounts = {};

    allTasks.forEach(task => {
        if (task.date_created) {
            const date = new Date(parseInt(task.date_created));
            // Get start of week (Monday)
            const startOfWeek = new Date(date);
            startOfWeek.setDate(date.getDate() - date.getDay() + 1);
            const key = startOfWeek.toISOString().split('T')[0];
            weekCounts[key] = (weekCounts[key] || 0) + 1;
        }
    });

    const sorted = Object.entries(weekCounts).sort((a, b) => a[0].localeCompare(b[0]));
    const labels = sorted.map(s => {
        const d = new Date(s[0]);
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    });
    const data = sorted.map(s => s[1]);

    destroyChart('timelineChart');
    chartInstances['timelineChart'] = new Chart(
        document.getElementById('timelineChart'),
        {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    data,
                    borderColor: '#6c5ce7',
                    backgroundColor: 'rgba(108, 92, 231, 0.1)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 4,
                    pointBackgroundColor: '#6c5ce7'
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    x: {
                        ticks: { color: '#8b99a8', maxRotation: 45 },
                        grid: { display: false }
                    },
                    y: {
                        ticks: { color: '#8b99a8', stepSize: 1 },
                        grid: { color: 'rgba(139,153,168,0.1)' }
                    }
                }
            }
        }
    );
}

function populateFilters() {
    const statusSelect = document.getElementById('filterStatus');
    const prioritySelect = document.getElementById('filterPriority');

    const statuses = [...new Set(allTasks.map(t => t.status?.status || 'Unknown'))];
    const priorities = [...new Set(allTasks.map(t => t.priority?.priority || 'None'))];

    statusSelect.innerHTML = '<option value="">All Statuses</option>' +
        statuses.map(s => `<option value="${s}">${s}</option>`).join('');

    prioritySelect.innerHTML = '<option value="">All Priorities</option>' +
        priorities.map(p => `<option value="${p}">${p}</option>`).join('');
}

function renderTable() {
    const statusFilter = document.getElementById('filterStatus').value;
    const priorityFilter = document.getElementById('filterPriority').value;

    let filtered = allTasks;

    if (statusFilter) {
        filtered = filtered.filter(t => (t.status?.status || 'Unknown') === statusFilter);
    }
    if (priorityFilter) {
        filtered = filtered.filter(t => (t.priority?.priority || 'None') === priorityFilter);
    }

    const tbody = document.getElementById('taskTableBody');
    tbody.innerHTML = filtered.map(task => {
        const status = task.status?.status || 'Unknown';
        const statusColor = task.status?.color || '#6c5ce7';
        const priority = task.priority?.priority || 'None';
        const priorityColor = task.priority?.color || '#8b99a8';
        const assignees = task.assignees?.map(a => a.username || a.email || '?').join(', ') || '—';
        const dueDate = task.due_date
            ? new Date(parseInt(task.due_date)).toLocaleDateString()
            : '—';
        const isOverdue = task.due_date && parseInt(task.due_date) < Date.now() && !isDone(task);
        const url = task.url || '#';

        return `<tr>
            <td><a href="${url}" target="_blank" class="task-link">${escapeHtml(task.name)}</a></td>
            <td><span class="status-badge" style="background:${statusColor}22;color:${statusColor}">${escapeHtml(status)}</span></td>
            <td><span class="priority-badge"><span class="priority-dot" style="background:${priorityColor}"></span>${escapeHtml(priority)}</span></td>
            <td>${escapeHtml(assignees)}</td>
            <td style="${isOverdue ? 'color:var(--danger);font-weight:600' : ''}">${dueDate}${isOverdue ? ' ⚠️' : ''}</td>
        </tr>`;
    }).join('');
}

// --- Helpers ---

function isOpen(task) {
    const s = (task.status?.type || '').toLowerCase();
    return s === 'open';
}

function isInProgress(task) {
    const s = (task.status?.type || '').toLowerCase();
    return s === 'custom' && !isDone(task) && !isOpen(task);
}

function isDone(task) {
    const s = (task.status?.type || '').toLowerCase();
    return s === 'closed' || s === 'done';
}

function destroyChart(id) {
    if (chartInstances[id]) {
        chartInstances[id].destroy();
        delete chartInstances[id];
    }
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
    div.textContent = text;
    return div.innerHTML;
}

// --- Init ---

document.addEventListener('DOMContentLoaded', () => {
    const config = loadConfig();
    if (config.apiKey && config.listId) {
        fetchTasks();
    }
});
