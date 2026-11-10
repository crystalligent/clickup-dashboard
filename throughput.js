// ============================================================
// Throughput Dashboard: created vs. completed per period
//
// created   = "created_at" row of the "ticket dates" checklist
// completed = "for_release_at" row of the "ticket dates" checklist
// ============================================================

const DEFAULT_LIST_ID = '901609965646';
const Core = window.ThroughputCore;

const GRANULARITY_NOUN = { daily: 'Day', weekly: 'Week', monthly: 'Month' };

let allTasks = [];
let state = {
    granularity: 'weekly',
    preset: 'last-12-weeks',
    from: '',
    to: '',
};
let result = null;
let selectedPeriodKey = null;
let charts = {};

// ─── Data loading ──────────────────────────────────────────────────────────────

function getListId() {
    return localStorage.getItem('clickup_list_id') || DEFAULT_LIST_ID;
}

async function clickupFetch(apiPath) {
    if (window.location.hostname === '' || window.location.protocol === 'file:') {
        throw new Error('This dashboard must be hosted on Netlify to access ClickUp data.');
    }
    return fetch('/.netlify/functions/clickup-proxy?path=' + encodeURIComponent(apiPath));
}

async function loadTasks() {
    const listId = getListId();
    showLoading(true);
    hideError();
    document.getElementById('refreshBtn').disabled = true;

    try {
        let tasks = [];
        let page = 0;
        while (true) {
            document.getElementById('loadingProgress').textContent =
                `Loading page ${page + 1}... (${tasks.length} tickets so far)`;
            const res = await clickupFetch(
                `/api/v2/list/${listId}/task?page=${page}&subtasks=true&include_closed=true`
            );
            if (!res.ok) {
                if (res.status === 401) throw new Error('Invalid API token.');
                if (res.status === 404) throw new Error('List not found.');
                throw new Error(`API error: ${res.status}`);
            }
            const data = await res.json();
            const batch = data.tasks || [];
            tasks = tasks.concat(batch);
            if (data.last_page || batch.length === 0 || page >= 100) break;
            page++;
        }

        allTasks = tasks;
        document.getElementById('lastUpdated').textContent =
            'Loaded ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        render();
    } catch (err) {
        showError(err.message);
    } finally {
        showLoading(false);
        document.getElementById('refreshBtn').disabled = false;
    }
}

// ─── Controls ──────────────────────────────────────────────────────────────────

function presetRange(preset) {
    const today = new Date();
    const to = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const from = new Date(to);

    switch (preset) {
        case 'last-30-days':
            from.setDate(from.getDate() - 29);
            break;
        case 'last-12-weeks': {
            const offset = (from.getDay() + 6) % 7; // back to Monday
            from.setDate(from.getDate() - offset - 7 * 11);
            break;
        }
        case 'last-6-months':
            from.setDate(1);
            from.setMonth(from.getMonth() - 5);
            break;
        case 'last-12-months':
            from.setDate(1);
            from.setMonth(from.getMonth() - 11);
            break;
        case 'this-year':
            from.setMonth(0, 1);
            break;
        default:
            return null;
    }
    return { from: Core.toLocalDay(from), to: Core.toLocalDay(to) };
}

function setActive(containerId, attr, value) {
    document.querySelectorAll(`#${containerId} [${attr}]`).forEach((b) => {
        b.classList.toggle('active', b.getAttribute(attr) === value);
    });
}

function applyPreset(preset) {
    state.preset = preset;
    setActive('rangePresets', 'data-preset', preset);
    const range = presetRange(preset);
    if (range) {
        state.from = range.from;
        state.to = range.to;
        document.getElementById('dateFrom').value = range.from;
        document.getElementById('dateTo').value = range.to;
        render();
    } else {
        document.getElementById('dateFrom').focus();
    }
}

function applyCustomRange() {
    const from = document.getElementById('dateFrom').value;
    const to = document.getElementById('dateTo').value;
    if (!from || !to) {
        showError('Pick both a From and a To date.');
        return;
    }
    if (to < from) {
        showError('"To" must be on or after "From".');
        return;
    }
    hideError();
    state.from = from;
    state.to = to;
    state.preset = 'custom';
    setActive('rangePresets', 'data-preset', 'custom');
    render();
}

function setGranularity(granularity) {
    state.granularity = granularity;
    setActive('granularityButtons', 'data-granularity', granularity);
    render();
}

function initControls() {
    document.querySelectorAll('#granularityButtons [data-granularity]').forEach((b) =>
        b.addEventListener('click', () => setGranularity(b.dataset.granularity)));
    document.querySelectorAll('#rangePresets [data-preset]').forEach((b) =>
        b.addEventListener('click', () => applyPreset(b.dataset.preset)));
    document.getElementById('applyRangeBtn').addEventListener('click', applyCustomRange);
    ['dateFrom', 'dateTo'].forEach((id) =>
        document.getElementById(id).addEventListener('change', () => {
            state.preset = 'custom';
            setActive('rangePresets', 'data-preset', 'custom');
        }));

    const range = presetRange(state.preset);
    state.from = range.from;
    state.to = range.to;
    document.getElementById('dateFrom').value = range.from;
    document.getElementById('dateTo').value = range.to;
}

// ─── Rendering ─────────────────────────────────────────────────────────────────

function render() {
    if (!state.from || !state.to) return;

    const days = Math.round((Core.parseLocalDay(state.to) - Core.parseLocalDay(state.from)) / 86400000) + 1;
    if (state.granularity === 'daily' && days > 731) {
        showError('Daily view is limited to 2 years. Pick a shorter range or switch to Weekly/Monthly.');
        return;
    }
    hideError();

    result = Core.computeThroughput(allTasks, state.from, state.to, state.granularity);
    if (!result.periods.some((p) => p.key === selectedPeriodKey)) closeDetail();

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
    const n = result.periods.length;
    const parts = [`${fmtDay(state.from)} – ${fmtDay(state.to)}`, `${days} day${days === 1 ? '' : 's'}`];
    if (state.granularity !== 'daily') parts.push(`${n} ${GRANULARITY_NOUN[state.granularity].toLowerCase()}${n === 1 ? '' : 's'}`);
    parts.push(`grouped in ${tz}`);
    if (state.granularity === 'weekly') parts.push('weeks start Monday');
    document.getElementById('rangeInfo').textContent = parts.join(' · ');

    renderKpis();
    renderCoverage();
    renderBarChart();
    renderCumulativeChart();
    renderPeriodTable();
    if (selectedPeriodKey) renderDetail(selectedPeriodKey);
    document.getElementById('dashboard').style.display = 'block';
}

function renderKpis() {
    const t = result.totals;
    const noun = GRANULARITY_NOUN[state.granularity].toLowerCase();
    document.getElementById('kpiCreated').textContent = t.created;
    document.getElementById('kpiCompleted').textContent = t.completed;

    const netEl = document.getElementById('kpiNet');
    netEl.textContent = (t.net > 0 ? '+' : '') + t.net;
    netEl.className = 'kpi-value ' + (t.net > 0 ? 'tp-net-up' : t.net < 0 ? 'tp-net-down' : '');
    document.getElementById('kpiNetLabel').textContent =
        t.net > 0 ? 'Net: backlog grew' : t.net < 0 ? 'Net: backlog shrank' : 'Net (created − completed)';

    document.getElementById('kpiRatio').textContent = t.ratio === null ? '—' : Math.round(t.ratio * 100) + '%';
    document.getElementById('kpiAvg').textContent = t.avgCompleted.toFixed(1);
    document.getElementById('kpiAvgLabel').textContent = `Avg completed / ${noun}`;
}

function renderCoverage() {
    const c = result.coverage;
    const el = document.getElementById('coverageNote');
    const missing = c.total - c.withCreated;
    el.textContent =
        `Across all ${c.total} tickets in the list, ${c.withCreated} have a created_at date and ${c.withCompleted} have a for_release_at date. ` +
        (missing > 0
            ? `${missing} ticket${missing === 1 ? ' is' : 's are'} not counted because ${missing === 1 ? 'it has' : 'they have'} no created_at in the "ticket dates" checklist yet (it is added the next time the GitLab sync touches the ticket).`
            : 'All tickets are covered.');
    el.classList.toggle('tp-warn', c.total > 0 && missing / c.total > 0.1);
}

function chartTheme() {
    return {
        ticks: { color: '#7d8fa3' },
        grid: { color: 'rgba(125,143,163,0.08)' },
    };
}

function destroyChart(id) {
    if (charts[id]) {
        charts[id].destroy();
        delete charts[id];
    }
}

function renderBarChart() {
    const periods = result.periods;
    document.getElementById('barChartTitle').textContent =
        `Created vs. Completed per ${GRANULARITY_NOUN[state.granularity]}`;

    destroyChart('throughputChart');
    const theme = chartTheme();
    charts.throughputChart = new Chart(document.getElementById('throughputChart'), {
        type: 'bar',
        data: {
            labels: periods.map((p) => p.label),
            datasets: [
                { label: 'Created', data: periods.map((p) => p.created), backgroundColor: '#4da6ff', borderRadius: 4, maxBarThickness: 36 },
                { label: 'Completed', data: periods.map((p) => p.completed), backgroundColor: '#00d68f', borderRadius: 4, maxBarThickness: 36 },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { labels: { color: '#e8edf2' } },
                tooltip: {
                    callbacks: {
                        footer: (items) => {
                            const p = periods[items[0].dataIndex];
                            return `Net: ${p.net > 0 ? '+' : ''}${p.net}` + (p.partial ? ' (partial period)' : '');
                        },
                    },
                },
            },
            scales: {
                x: { ticks: { ...theme.ticks, maxRotation: 60, autoSkip: true }, grid: { display: false } },
                y: { beginAtZero: true, ticks: { ...theme.ticks, precision: 0 }, grid: theme.grid },
            },
            onClick: (_evt, elements) => {
                if (elements.length) selectPeriod(periods[elements[0].index].key);
            },
        },
    });
}

function renderCumulativeChart() {
    const periods = result.periods;
    destroyChart('cumulativeChart');
    const theme = chartTheme();
    charts.cumulativeChart = new Chart(document.getElementById('cumulativeChart'), {
        type: 'line',
        data: {
            labels: periods.map((p) => p.label),
            datasets: [
                { label: 'Cumulative created', data: periods.map((p) => p.cumCreated), borderColor: '#4da6ff', backgroundColor: 'rgba(77,166,255,0.08)', fill: true, tension: 0.2, pointRadius: periods.length > 60 ? 0 : 2 },
                { label: 'Cumulative completed', data: periods.map((p) => p.cumCompleted), borderColor: '#00d68f', backgroundColor: 'rgba(0,214,143,0.08)', fill: true, tension: 0.2, pointRadius: periods.length > 60 ? 0 : 2 },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { labels: { color: '#e8edf2' } } },
            scales: {
                x: { ticks: { ...theme.ticks, maxRotation: 60, autoSkip: true }, grid: { display: false } },
                y: { beginAtZero: true, ticks: { ...theme.ticks, precision: 0 }, grid: theme.grid },
            },
        },
    });
}

function renderPeriodTable() {
    const body = document.getElementById('periodTableBody');
    body.innerHTML = result.periods
        .slice()
        .reverse()
        .map((p) => {
            const netClass = p.net > 0 ? 'tp-net-up' : p.net < 0 ? 'tp-net-down' : '';
            return `<tr data-key="${p.key}" class="${p.key === selectedPeriodKey ? 'tp-selected' : ''}">
                <td>${escapeHtml(p.label)}${p.partial ? '<span class="tp-partial">partial</span>' : ''}</td>
                <td class="tp-num tp-created">${p.created}</td>
                <td class="tp-num tp-completed">${p.completed}</td>
                <td class="tp-num ${netClass}">${p.net > 0 ? '+' : ''}${p.net}</td>
                <td class="tp-num">${p.cumCreated}</td>
                <td class="tp-num">${p.cumCompleted}</td>
            </tr>`;
        })
        .join('');
    body.querySelectorAll('tr').forEach((tr) => tr.addEventListener('click', () => selectPeriod(tr.dataset.key)));
}

// ─── Drill-down ────────────────────────────────────────────────────────────────

function selectPeriod(key) {
    selectedPeriodKey = key;
    renderPeriodTable();
    renderDetail(key);
    document.getElementById('detailSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeDetail() {
    selectedPeriodKey = null;
    document.getElementById('detailSection').style.display = 'none';
    document.querySelectorAll('#periodTableBody tr.tp-selected').forEach((tr) => tr.classList.remove('tp-selected'));
}

function renderDetail(key) {
    const p = result.periods.find((x) => x.key === key);
    if (!p) return closeDetail();

    document.getElementById('detailSection').style.display = 'block';
    document.getElementById('detailTitle').textContent = `Tickets: ${p.label}${p.partial ? ' (partial)' : ''}`;
    document.getElementById('detailCreatedCount').textContent = `(${p.created})`;
    document.getElementById('detailCompletedCount').textContent = `(${p.completed})`;
    document.getElementById('detailCreatedBody').innerHTML = detailRows(p.createdTasks, 'created');
    document.getElementById('detailCompletedBody').innerHTML = detailRows(p.completedTasks, 'completed');
}

function detailRows(entries, field) {
    if (!entries.length) return '<tr><td colspan="4" class="tp-empty">None</td></tr>';
    return entries
        .slice()
        .sort((a, b) => b.dates[field] - a.dates[field])
        .map(({ task, dates }) => {
            const status = task.status?.status || '—';
            const color = task.status?.color || '#7c6cf0';
            const gitlabUrl = getGitlabUrl(task.name);
            const iid = gitlabUrl ? gitlabUrl.split('/').pop() : '';
            const title = task.name.replace(/\s*:\s*https?:\/\/\S+$/, '');
            return `<tr>
                <td><a href="${escapeAttr(task.url || '#')}" target="_blank" rel="noopener" class="task-link">${escapeHtml(title)}</a></td>
                <td>${gitlabUrl ? `<a href="${escapeAttr(gitlabUrl)}" target="_blank" rel="noopener" class="gitlab-btn">#${escapeHtml(iid)}</a>` : '—'}</td>
                <td><span class="status-badge" style="background:${color}22;color:${color}">${escapeHtml(status)}</span></td>
                <td>${fmtDateTime(dates[field])}</td>
            </tr>`;
        })
        .join('');
}

// ─── Export ────────────────────────────────────────────────────────────────────

function exportCSV() {
    if (!result) return;
    const rows = [['Period', 'Period start', 'Partial', 'Created', 'Completed', 'Net', 'Cumulative created', 'Cumulative completed']];
    for (const p of result.periods) {
        rows.push([p.label, p.key, p.partial ? 'yes' : 'no', p.created, p.completed, p.net, p.cumCreated, p.cumCompleted]);
    }
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `throughput_${state.granularity}_${state.from}_to_${state.to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function getGitlabUrl(name) {
    const m = (name || '').match(/https?:\/\/\S+\/-\/issues\/\d+/);
    return m ? m[0] : '';
}

function fmtDay(ymd) {
    return Core.parseLocalDay(ymd).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateTime(d) {
    if (!d) return '—';
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
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
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
}

function escapeAttr(text) {
    return escapeHtml(text).replace(/"/g, '&quot;');
}

// ─── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    initControls();
    loadTasks();
});
