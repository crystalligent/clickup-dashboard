// ============================================================
// Throughput core: pure helpers for the Throughput dashboard.
//
// Reads the "ticket dates" checklist written by the GitLab sync
// (netlify/functions/utils/ticket-dates.js):
//   created_at: YYYY-MM-DD HH:mm:ss UTC      -> "created"
//   for_release_at: YYYY-MM-DD HH:mm:ss UTC  -> "completed"
//
// Periods are bucketed in the viewer's local time. Weeks start on Monday.
// Works in the browser (window.ThroughputCore) and in Node (module.exports).
// ============================================================

(function (root) {
    const CHECKLIST_NAME = 'ticket dates';
    const CREATED_FIELD = 'created_at';
    const COMPLETED_FIELD = 'for_release_at';

    const pad = (n) => String(n).padStart(2, '0');
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    /** Parse "YYYY-MM-DD HH:mm:ss UTC" (or any ISO string) into a Date, or null. */
    function parseChecklistDate(value) {
        if (typeof value !== 'string') return null;
        const s = value.trim();
        if (!s) return null;
        const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*UTC$/i);
        const d = m
            ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]))
            : new Date(s);
        return Number.isNaN(d.getTime()) ? null : d;
    }

    /** Read created/completed dates from a ClickUp task's "ticket dates" checklist. */
    function extractTicketDates(task) {
        const checklist = ((task && task.checklists) || [])
            .find((c) => c && typeof c.name === 'string' && c.name.trim() === CHECKLIST_NAME);
        const result = { hasChecklist: !!checklist, created: null, completed: null };
        if (!checklist) return result;

        for (const item of checklist.items || []) {
            const name = (item && item.name) || '';
            const idx = name.indexOf(':');
            if (idx === -1) continue;
            const field = name.slice(0, idx).trim();
            const date = parseChecklistDate(name.slice(idx + 1));
            if (field === CREATED_FIELD && !result.created) result.created = date;
            if (field === COMPLETED_FIELD && !result.completed) result.completed = date;
        }
        return result;
    }

    // ─── Local-time date helpers ───────────────────────────────────────────

    /** "YYYY-MM-DD" -> local midnight Date. */
    function parseLocalDay(ymd) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
        return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
    }

    function toLocalDay(d) {
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    function startOfDay(d) {
        return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }

    function startOfWeek(d) {
        const s = startOfDay(d);
        const offset = (s.getDay() + 6) % 7; // Monday = 0
        s.setDate(s.getDate() - offset);
        return s;
    }

    function startOfMonth(d) {
        return new Date(d.getFullYear(), d.getMonth(), 1);
    }

    function periodStart(d, granularity) {
        if (granularity === 'weekly') return startOfWeek(d);
        if (granularity === 'monthly') return startOfMonth(d);
        return startOfDay(d);
    }

    function nextPeriod(start, granularity) {
        const n = new Date(start);
        if (granularity === 'weekly') n.setDate(n.getDate() + 7);
        else if (granularity === 'monthly') n.setMonth(n.getMonth() + 1);
        else n.setDate(n.getDate() + 1);
        return n;
    }

    function shortDay(d) {
        return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
    }

    function periodLabel(start, granularity) {
        if (granularity === 'monthly') return `${MONTHS[start.getMonth()]} ${start.getFullYear()}`;
        if (granularity === 'weekly') {
            const end = new Date(start);
            end.setDate(end.getDate() + 6);
            return `${shortDay(start)} – ${shortDay(end)}`;
        }
        return shortDay(start);
    }

    /**
     * Build the ordered list of periods covering [fromYmd, toYmd] (inclusive, local).
     * Edge periods are clipped to the range so counts never include out-of-range events.
     */
    function buildPeriods(fromYmd, toYmd, granularity) {
        const from = parseLocalDay(fromYmd);
        const toDay = parseLocalDay(toYmd);
        if (!from || !toDay || toDay < from) return [];
        const rangeEnd = new Date(toDay);
        rangeEnd.setDate(rangeEnd.getDate() + 1); // exclusive

        const periods = [];
        let start = periodStart(from, granularity);
        while (start < rangeEnd && periods.length < 2000) {
            const end = nextPeriod(start, granularity);
            const clippedStart = start < from ? from : start;
            const clippedEnd = end > rangeEnd ? rangeEnd : end;
            periods.push({
                key: toLocalDay(start),
                label: periodLabel(start, granularity),
                start: clippedStart,
                end: clippedEnd, // exclusive
                partial: clippedStart > start || clippedEnd < end,
                created: 0,
                completed: 0,
                net: 0,
                createdTasks: [],
                completedTasks: [],
            });
            start = end;
        }
        return periods;
    }

    function findPeriodIndex(periods, date) {
        if (!date || periods.length === 0) return -1;
        const t = date.getTime();
        if (t < periods[0].start.getTime() || t >= periods[periods.length - 1].end.getTime()) return -1;
        let lo = 0;
        let hi = periods.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const p = periods[mid];
            if (t < p.start.getTime()) hi = mid - 1;
            else if (t >= p.end.getTime()) lo = mid + 1;
            else return mid;
        }
        return -1;
    }

    /**
     * Aggregate created vs completed per period.
     * @param {Array} tasks - ClickUp tasks (with checklists)
     * @returns {{ periods, totals, coverage }}
     */
    function computeThroughput(tasks, fromYmd, toYmd, granularity) {
        const periods = buildPeriods(fromYmd, toYmd, granularity);
        const coverage = { total: 0, withChecklist: 0, withCreated: 0, withCompleted: 0 };

        for (const task of tasks || []) {
            coverage.total++;
            const dates = extractTicketDates(task);
            if (dates.hasChecklist) coverage.withChecklist++;
            if (dates.created) coverage.withCreated++;
            if (dates.completed) coverage.withCompleted++;

            const ci = findPeriodIndex(periods, dates.created);
            if (ci !== -1) {
                periods[ci].created++;
                periods[ci].createdTasks.push({ task, dates });
            }
            const di = findPeriodIndex(periods, dates.completed);
            if (di !== -1) {
                periods[di].completed++;
                periods[di].completedTasks.push({ task, dates });
            }
        }

        let cumCreated = 0;
        let cumCompleted = 0;
        for (const p of periods) {
            p.net = p.created - p.completed;
            cumCreated += p.created;
            cumCompleted += p.completed;
            p.cumCreated = cumCreated;
            p.cumCompleted = cumCompleted;
        }

        const totals = {
            created: cumCreated,
            completed: cumCompleted,
            net: cumCreated - cumCompleted,
            periods: periods.length,
            avgCreated: periods.length ? cumCreated / periods.length : 0,
            avgCompleted: periods.length ? cumCompleted / periods.length : 0,
            ratio: cumCreated ? cumCompleted / cumCreated : null,
        };

        return { periods, totals, coverage };
    }

    const api = {
        CHECKLIST_NAME,
        parseChecklistDate,
        extractTicketDates,
        parseLocalDay,
        toLocalDay,
        buildPeriods,
        computeThroughput,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.ThroughputCore = api;
})(typeof window !== 'undefined' ? window : this);
