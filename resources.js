// ── Resources — QA vs Dev wait-time bottleneck (monthly) ────────────────────
// Self-contained page. Fetches from the Sign-off list and proves whether QA is
// the bottleneck by comparing how long tickets sit in QA statuses vs dev statuses.
//
// Wait-time proxy: ClickUp's free plan exposes no per-status history
// (/time_in_status is paywalled; there's no activity endpoint). So for a ticket
// CURRENTLY in a QA/dev status we approximate "time waiting in status" as
// (now - date_updated) — days since the last activity while in that status.
// Labeled clearly on the card. Filters tickets by date_updated within the
// selected calendar month.

(function () {
    const SIGNOFF_LIST_ID = localStorage.getItem('signoff_list_id') || '901616211048';
    const STALLED_DAYS = 7;

    // Statuses that represent work waiting on / owned by each role.
    const QA_STATUSES = ['pending review (qa)', 'for testing in hotfix', 'ongoing testing', 'testing: failed'];
    const DEV_STATUSES = ['ongoing dev', 'done development', 'for deployment to hotfix'];

    let monthOffset = 0; // 0 = current month, -1 = last month, ...

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // Proxy fetch with retry on rate limiting (429). ClickUp free plan caps at
    // ~100 req/min; the per-task fan-out can hit it, so back off and retry.
    async function proxyFetch(apiPath) {
        if (window.location.protocol === 'file:') throw new Error('Must be hosted on Netlify.');
        const url = '/.netlify/functions/clickup-proxy?path=' + encodeURIComponent(apiPath);
        const MAX_RETRIES = 5;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            const res = await fetch(url);
            if (res.status !== 429) return res;
            const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
            const wait = retryAfter > 0 ? retryAfter * 1000 : Math.min(20000, 1500 * Math.pow(2, attempt));
            await sleep(wait);
        }
        return fetch(url);
    }

    function show(id, on) { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; }
    function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
    function avg(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
    function median(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

    function monthBounds(offset) {
        const now = new Date();
        const from = new Date(now.getFullYear(), now.getMonth() + offset, 1);
        const to = new Date(now.getFullYear(), now.getMonth() + offset + 1, 1); // exclusive
        return { from, to };
    }
    function monthLabel(offset) {
        return monthBounds(offset).from.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    }

    async function loadBalance() {
        show('balanceError', false);
        show('balanceBody', false);
        show('balanceLoading', true);
        setText('balMonthLabel', monthLabel(monthOffset));
        document.getElementById('balNextMonth').disabled = monthOffset >= 0;

        try {
            const { from, to } = monthBounds(monthOffset);
            const fromTs = from.getTime();
            const toTs = to.getTime();

            // Page through the sign-off list, filtered to the month by date_updated.
            let list = [], page = 0, more = true;
            while (more) {
                const res = await proxyFetch(`/api/v2/list/${SIGNOFF_LIST_ID}/task?page=${page}&subtasks=true&include_closed=true&date_updated_gt=${fromTs}&date_updated_lt=${toTs}`);
                if (!res.ok) throw new Error('API error ' + res.status);
                const data = await res.json();
                list = list.concat(data.tasks || []);
                more = !data.last_page;
                page++;
                if (page > 30) break;
            }

            const now = Date.now();
            const daysSince = (t) => (now - parseInt(t.date_updated || now)) / 86400000;

            const qaWaits = [], devWaits = [];
            let qaStalled = 0;
            list.forEach(t => {
                const status = (t.status && t.status.status || '').toLowerCase();
                const d = daysSince(t);
                if (QA_STATUSES.includes(status)) { qaWaits.push(d); if (d > STALLED_DAYS) qaStalled++; }
                else if (DEV_STATUSES.includes(status)) { devWaits.push(d); }
            });

            const qaAvg = avg(qaWaits), devAvg = avg(devWaits), qaMed = median(qaWaits);

            setText('balDevWait', devWaits.length ? devAvg.toFixed(1) : '—');
            setText('balQaWait', qaWaits.length ? qaAvg.toFixed(1) : '—');
            setText('balDevMeta', `${devWaits.length} ticket${devWaits.length === 1 ? '' : 's'} in dev`);
            setText('balQaMeta', `${qaWaits.length} ticket${qaWaits.length === 1 ? '' : 's'} in QA`);
            setText('balQaStalled', qaStalled);
            setText('balQaQueue', qaWaits.length);
            setText('balDevQueue', devWaits.length);
            setText('balQaMedian', qaWaits.length ? qaMed.toFixed(1) : '—');

            // Bar split by relative avg wait.
            const total = qaAvg + devAvg;
            const devPct = total ? (devAvg / total) * 100 : 50;
            document.getElementById('balBarDev').style.width = devPct + '%';
            document.getElementById('balBarQa').style.width = (100 - devPct) + '%';

            // Verdict.
            const verdictEl = document.getElementById('balanceVerdict');
            let cls, verdictHtml, note, ratioText = '';
            if (!qaWaits.length || !devWaits.length) {
                cls = 'verdict-balanced';
                verdictHtml = 'Not enough data <span class="verdict-pill">n/a</span>';
                note = `No tickets updated in ${monthLabel(monthOffset)} are currently sitting in both QA and dev statuses, so wait time can't be compared for this month.`;
            } else {
                const ratio = qaAvg / devAvg;
                ratioText = qaAvg >= devAvg ? `QA waits ${ratio.toFixed(1)}× longer` : `Dev waits ${(1 / ratio).toFixed(1)}× longer`;
                const diff = Math.abs(qaAvg - devAvg) / Math.max(qaAvg, devAvg);
                if (diff <= 0.20) {
                    cls = 'verdict-balanced';
                    verdictHtml = 'Balanced <span class="verdict-pill">healthy</span>';
                    note = `Tickets wait about the same in QA (${qaAvg.toFixed(1)}d) and dev (${devAvg.toFixed(1)}d) statuses. No wait-time bottleneck this month.`;
                } else if (qaAvg > devAvg) {
                    cls = 'verdict-qa';
                    verdictHtml = 'QA is the bottleneck <span class="verdict-pill">add QA</span>';
                    note = `Tickets sit in QA statuses ${ratio.toFixed(1)}× longer than in dev (${qaAvg.toFixed(1)}d vs ${devAvg.toFixed(1)}d), and ${qaStalled} QA ticket${qaStalled === 1 ? ' has' : 's have'} been stalled over ${STALLED_DAYS} days. Work is backing up before QA — with only a few QAs, losing one sharply raises release wait time. Consider adding QA capacity.`;
                } else {
                    cls = 'verdict-dev';
                    verdictHtml = 'Development is the bottleneck <span class="verdict-pill">add devs</span>';
                    note = `Tickets sit in dev statuses ${(1 / ratio).toFixed(1)}× longer than in QA (${devAvg.toFixed(1)}d vs ${qaAvg.toFixed(1)}d). Work is backing up before development. Consider adding developer capacity.`;
                }
            }
            verdictEl.className = 'balance-verdict ' + cls;
            verdictEl.innerHTML = verdictHtml;
            document.getElementById('balRatio').textContent = ratioText;
            document.getElementById('balanceNote').textContent = note;
            document.getElementById('balanceDisclaimer').textContent =
                'Wait time = days since a ticket\u2019s last update while sitting in a QA/dev status (approximation; ClickUp\u2019s free plan does not expose full status history). Scoped to tickets updated in the selected month.';

            show('balanceLoading', false);
            show('balanceBody', true);
        } catch (err) {
            show('balanceLoading', false);
            const e = document.getElementById('balanceError');
            e.textContent = 'Could not load resource balance: ' + err.message;
            e.style.display = 'block';
        }
    }

    function initBalance() {
        document.getElementById('balPrevMonth').addEventListener('click', () => { monthOffset--; loadBalance(); });
        document.getElementById('balNextMonth').addEventListener('click', () => { if (monthOffset < 0) { monthOffset++; loadBalance(); } });
        loadBalance();
    }

    document.addEventListener('DOMContentLoaded', initBalance);
})();
