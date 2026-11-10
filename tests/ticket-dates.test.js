const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const {
  CHECKLIST_NAME,
  formatDateUtc,
  hasLabelCI,
  fieldOf,
  isFrozenField,
  itemValue,
  syncTicketDatesChecklist,
} = require('../netlify/functions/utils/ticket-dates');
const { makeFakeClickup } = require('./fake-clickup');

const RUNS = { numRuns: 100 };
const FORMAT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/;
const NOW = new Date('2026-11-05T08:30:00.000Z');
const NOW_FMT = '2026-11-05 08:30:00 UTC';

// ─── Generators ────────────────────────────────────────────────────────────────

const dateArb = fc.date({ min: new Date('2000-01-01T00:00:00Z'), max: new Date('2099-12-31T23:59:59Z'), noInvalidDate: true });

const mixCase = (s) =>
  fc.array(fc.boolean(), { minLength: s.length, maxLength: s.length })
    .map((flags) => s.split('').map((ch, i) => (flags[i] ? ch.toUpperCase() : ch.toLowerCase())).join(''));

const labelPool = ['For Release', 'Released', 'Enhancement', 'Data Correction', 'On-Going Development'];
const labelsArb = fc
  .tuple(fc.subarray(labelPool), fc.boolean())
  .chain(([titles, asObjects]) =>
    (titles.length ? fc.tuple(...titles.map(mixCase)) : fc.constant([]))
      .map((cased) => cased.map((t) => (asObjects ? { title: t } : t))));

const statusArb = fc.constantFrom(
  'Open', 'ongoing dev', 'done development', 'for testing in hotfix', 'for release', 'released to prod', 'Closed', undefined
);

const itemArb = fc.record({
  field: fc.constantFrom('created_at', 'for_release_at', 'released_at', 'note'),
  value: fc.oneof(dateArb.map(formatDateUtc), fc.constant('')),
});

const checklistStateArb = fc.record({
  hasChecklist: fc.boolean(),
  extraChecklists: fc.nat({ max: 2 }),
  items: fc.array(itemArb, { maxLength: 6 }),
});

function buildTask({ hasChecklist, extraChecklists, items }) {
  const checklists = [{ id: 'other', name: 'Sign-off', items: [{ id: 'so1', name: 'Developer' }] }];
  if (hasChecklist) {
    checklists.push({
      id: 'td1',
      name: CHECKLIST_NAME,
      items: items.map((it, i) => ({ id: `seed-${i}`, name: it.field === 'note' ? 'some note' : `${it.field}: ${it.value}` })),
    });
    for (let i = 0; i < extraChecklists; i++) checklists.push({ id: `td-extra-${i}`, name: ` ${CHECKLIST_NAME} `, items: [] });
  }
  return { id: 't1', checklists };
}

const ticketDates = (store) => store.task.checklists.find((c) => c.name.trim() === CHECKLIST_NAME);
const itemsFor = (store, field) => (ticketDates(store)?.items || []).filter((i) => fieldOf(i.name) === field);
const mutations = (calls) => calls.filter((c) => c.method !== 'GET');

const run = (fake, issue, status) => syncTicketDatesChecklist(fake.clickupRequest, 't1', issue, status, { now: NOW });

// ─── Formatter / helpers ───────────────────────────────────────────────────────

// Feature: ticket-dates-sync, Property 12: All rendered dates share one fixed-width format
test('P12: every formatted date matches the shared fixed-width pattern', () => {
  fc.assert(fc.property(dateArb, fc.constantFrom('iso', 'ms', 'date'), (d, shape) => {
    const input = shape === 'iso' ? d.toISOString() : shape === 'ms' ? d.getTime() : d;
    assert.match(formatDateUtc(input), FORMAT_RE);
  }), RUNS);
});

// Feature: ticket-dates-sync, Property 13: Source dates are normalized to UTC before formatting
test('P13: the same instant in different offsets formats identically', () => {
  fc.assert(fc.property(dateArb, fc.integer({ min: -12 * 60, max: 14 * 60 }), (d, offsetMin) => {
    const shifted = new Date(d.getTime() + offsetMin * 60000);
    const sign = offsetMin >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMin);
    const off = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
    const local = shifted.toISOString().replace('Z', off).replace(/\.\d{3}/, '');
    const utc = d.toISOString().replace(/\.\d{3}/, '');
    assert.equal(formatDateUtc(local), formatDateUtc(utc));
  }), RUNS);
});

test('formatDateUtc: exact output and invalid inputs', () => {
  assert.equal(formatDateUtc('2024-03-07T14:05:09.000Z'), '2024-03-07 14:05:09 UTC');
  assert.equal(formatDateUtc('2024-03-07 14:05:09 UTC'), '2024-03-07 14:05:09 UTC'); // GitLab webhook style
  assert.equal(formatDateUtc('2024-03-07T22:05:09+08:00'), '2024-03-07 14:05:09 UTC');
  for (const bad of ['', null, undefined, 'not-a-date']) assert.equal(formatDateUtc(bad), null);
});

// Feature: ticket-dates-sync, Property 7: Label matching is case-insensitive across both shapes
test('P7: label detection is case-insensitive for string[] and {title}[]', () => {
  fc.assert(fc.property(labelsArb, (labels) => {
    const lower = labels.map((l) => (typeof l === 'string' ? l : l.title).toLowerCase());
    assert.equal(hasLabelCI(labels, 'For Release'), lower.includes('for release'));
    assert.equal(hasLabelCI(labels, 'Released'), lower.includes('released'));
  }), RUNS);
});

test('fieldOf / isFrozenField / itemValue', () => {
  assert.equal(fieldOf('created_at: 2024-03-07 14:05:09 UTC'), 'created_at');
  assert.equal(fieldOf('for_release_at: x'), 'for_release_at');
  assert.equal(fieldOf('released_at:'), 'released_at');
  assert.equal(fieldOf('Developer'), null);
  assert.equal(isFrozenField('for_release_at'), true);
  assert.equal(isFrozenField('released_at'), true);
  assert.equal(isFrozenField('created_at'), false);
  assert.equal(itemValue('released_at: 2024-03-07 14:05:09 UTC'), '2024-03-07 14:05:09 UTC');
  assert.equal(itemValue('released_at:'), '');
});

// ─── Reconciliation ────────────────────────────────────────────────────────────

// Feature: ticket-dates-sync, Property 1: Read happens before any mutation
test('P1: GET /task precedes every mutation', async () => {
  await fc.assert(fc.asyncProperty(checklistStateArb, labelsArb, dateArb, statusArb, async (state, labels, created, status) => {
    const fake = makeFakeClickup(buildTask(state));
    await run(fake, { created_at: created.toISOString(), labels }, status);
    assert.equal(fake.calls[0].method, 'GET');
    assert.equal(fake.calls[0].path, '/task/t1');
  }), RUNS);
});

// Feature: ticket-dates-sync, Property 2: Checklist is created exactly once only when absent
test('P2: checklist created only when absent, first match reused otherwise', async () => {
  await fc.assert(fc.asyncProperty(checklistStateArb, labelsArb, async (state, labels) => {
    const fake = makeFakeClickup(buildTask(state));
    const res = await run(fake, { created_at: NOW.toISOString(), labels }, 'Open');
    const creates = fake.calls.filter((c) => c.method === 'POST' && c.path === '/task/t1/checklist');
    if (state.hasChecklist) {
      assert.equal(creates.length, 0);
      assert.equal(res.checklistId, 'td1');
    } else {
      assert.equal(creates.length, 1);
      assert.equal(creates[0].body.name, 'ticket dates');
    }
  }), RUNS);
});

// Feature: ticket-dates-sync, Property 3: Exactly one created_at item, added or updated in place
test('P3: exactly one created_at item, no write when unchanged', async () => {
  await fc.assert(fc.asyncProperty(checklistStateArb, dateArb, async (state, created) => {
    const fake = makeFakeClickup(buildTask(state));
    await run(fake, { created_at: created.toISOString(), labels: [] }, 'Open');
    const items = itemsFor(fake.store, 'created_at');
    assert.equal(items.length, 1);
    assert.equal(items[0].name, `created_at: ${formatDateUtc(created)}`);

    const before = fake.calls.length;
    await run(fake, { created_at: created.toISOString(), labels: [] }, 'Open');
    assert.deepEqual(mutations(fake.calls.slice(before)), []);
  }), RUNS);
});

test('unparseable created_at: no created_at write, release dates still reconcile', async () => {
  for (const bad of ['', null, 'not-a-date', undefined]) {
    const fake = makeFakeClickup(buildTask({ hasChecklist: false, extraChecklists: 0, items: [] }));
    const res = await run(fake, { created_at: bad, labels: ['For Release', 'Released'] }, 'released to prod');
    assert.equal(res.ok, true);
    assert.equal(itemsFor(fake.store, 'created_at').length, 0);
    assert.equal(itemsFor(fake.store, 'for_release_at')[0].name, `for_release_at: ${NOW_FMT}`);
    assert.equal(itemsFor(fake.store, 'released_at')[0].name, `released_at: ${NOW_FMT}`);
    assert.equal(res.warnings.length, 1);
  }
});

// Feature: ticket-dates-sync, Property 4: First observation records a frozen field
test('P4: first observation records the observation time', async () => {
  await fc.assert(fc.asyncProperty(labelsArb, statusArb, async (labels, status) => {
    const fake = makeFakeClickup(buildTask({ hasChecklist: false, extraChecklists: 0, items: [] }));
    await run(fake, { created_at: NOW.toISOString(), labels }, status);
    const forRelease = hasLabelCI(labels, 'For Release') || ['for release', 'released to prod'].includes(status);
    const released = hasLabelCI(labels, 'Released');
    if (forRelease) assert.deepEqual(itemsFor(fake.store, 'for_release_at').map((i) => i.name), [`for_release_at: ${NOW_FMT}`]);
    if (released) assert.deepEqual(itemsFor(fake.store, 'released_at').map((i) => i.name), [`released_at: ${NOW_FMT}`]);
  }), RUNS);
});

// Feature: ticket-dates-sync, Property 5: No frozen-field item is created when its label is absent
test('P5: no release item when its label (or status) is absent', async () => {
  await fc.assert(fc.asyncProperty(labelsArb, fc.constantFrom('Open', 'ongoing dev', 'done development', 'Closed'), async (labels, status) => {
    const filtered = labels.filter((l) => !['for release', 'released'].includes((typeof l === 'string' ? l : l.title).toLowerCase()));
    const fake = makeFakeClickup(buildTask({ hasChecklist: false, extraChecklists: 0, items: [] }));
    await run(fake, { created_at: NOW.toISOString(), labels: filtered }, status);
    assert.equal(itemsFor(fake.store, 'for_release_at').length, 0);
    assert.equal(itemsFor(fake.store, 'released_at').length, 0);
  }), RUNS);
});

// Feature: ticket-dates-sync, Property 6: Freeze invariant — existing frozen values are never changed
test('P6: recorded release dates never change across later syncs', async () => {
  await fc.assert(fc.asyncProperty(
    dateArb, dateArb, fc.array(fc.tuple(labelsArb, statusArb), { minLength: 1, maxLength: 4 }),
    async (frDate, relDate, syncs) => {
      const fr = `for_release_at: ${formatDateUtc(frDate)}`;
      const rel = `released_at: ${formatDateUtc(relDate)}`;
      const fake = makeFakeClickup({
        id: 't1',
        checklists: [{ id: 'td1', name: CHECKLIST_NAME, items: [{ id: 'fr', name: fr }, { id: 'rel', name: rel }] }],
      });
      for (const [labels, status] of syncs) {
        await syncTicketDatesChecklist(fake.clickupRequest, 't1', { created_at: NOW.toISOString(), labels }, status);
      }
      assert.deepEqual(itemsFor(fake.store, 'for_release_at').map((i) => i.name), [fr]);
      assert.deepEqual(itemsFor(fake.store, 'released_at').map((i) => i.name), [rel]);
      const touched = mutations(fake.calls).filter((c) => /\/(fr|rel)$/.test(c.path));
      assert.deepEqual(touched, []);
    }), RUNS);
});

// Feature: ticket-dates-sync, Property 8: Duplicates collapse to exactly one item per field
test('P8: duplicate items collapse to one per field, recorded value kept', async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom('created_at', 'for_release_at', 'released_at'), dateArb, fc.integer({ min: 2, max: 4 }),
    async (field, d, count) => {
      const value = formatDateUtc(d);
      const items = Array.from({ length: count }, (_, i) => ({ id: `dup-${i}`, name: i === 0 ? `${field}:` : `${field}: ${value}` }));
      const fake = makeFakeClickup({ id: 't1', checklists: [{ id: 'td1', name: CHECKLIST_NAME, items }] });
      await run(fake, { created_at: d.toISOString(), labels: [] }, 'Open');
      const left = itemsFor(fake.store, field);
      assert.equal(left.length, 1);
      assert.equal(left[0].name, `${field}: ${value}`);
      const deletes = fake.calls.filter((c) => c.method === 'DELETE').length;
      assert.equal(deletes, count - 1);
    }), RUNS);
});

// Feature: ticket-dates-sync, Property 9: Idempotent convergence over repeated syncs
test('P9: repeated syncs converge to at most one item per field', async () => {
  await fc.assert(fc.asyncProperty(
    checklistStateArb, dateArb, fc.array(fc.tuple(labelsArb, statusArb), { minLength: 1, maxLength: 5 }),
    async (state, created, syncs) => {
      const fake = makeFakeClickup(buildTask(state));
      for (const [labels, status] of syncs) await run(fake, { created_at: created.toISOString(), labels }, status);
      assert.equal(itemsFor(fake.store, 'created_at').length, 1);
      assert.ok(itemsFor(fake.store, 'for_release_at').length <= 1);
      assert.ok(itemsFor(fake.store, 'released_at').length <= 1);
      const named = fake.store.task.checklists.filter((c) => c.name.trim() === CHECKLIST_NAME);
      assert.equal(named.length, state.hasChecklist ? 1 + state.extraChecklists : 1);
    }), RUNS);
});

// Feature: ticket-dates-sync, Property 10: Failures resolve to a non-throwing failure result
test('P10: any injected failure resolves to { ok:false }', async () => {
  const errSpy = console.error;
  console.error = () => {};
  try {
    await fc.assert(fc.asyncProperty(checklistStateArb, labelsArb, fc.nat({ max: 8 }), async (state, labels, failIndex) => {
      let i = 0;
      const fake = makeFakeClickup(buildTask(state), { failAt: () => i++ === failIndex });
      const res = await run(fake, { created_at: NOW.toISOString(), labels: [...labels, 'For Release', 'Released'] }, 'for release');
      if (fake.calls.length > failIndex) {
        assert.equal(res.ok, false);
        assert.match(res.error, /injected failure/);
      } else {
        assert.equal(res.ok, true);
      }
    }), RUNS);
  } finally {
    console.error = errSpy;
  }
});

// Feature: ticket-dates-sync, Property 11: A failed read performs zero mutations and surfaces an error
test('P11: failed read issues no mutations', async () => {
  const errSpy = console.error;
  console.error = () => {};
  try {
    await fc.assert(fc.asyncProperty(checklistStateArb, labelsArb, async (state, labels) => {
      const fake = makeFakeClickup(buildTask(state), { failAt: (c) => c.method === 'GET' });
      const res = await run(fake, { created_at: NOW.toISOString(), labels }, 'released to prod');
      assert.equal(res.ok, false);
      assert.deepEqual(mutations(fake.calls), []);
    }), RUNS);
  } finally {
    console.error = errSpy;
  }
});

test('failure logs exactly one diagnostic naming the task', async () => {
  const logged = [];
  const errSpy = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const fake = makeFakeClickup({ id: 't1' }, { failAt: (c) => c.method === 'GET' });
    await run(fake, { created_at: NOW.toISOString(), labels: [] }, 'Open');
  } finally {
    console.error = errSpy;
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0], /\[ticket-dates\].*task t1/);
});

test('end-to-end lifecycle: created -> for release -> released -> label removed', async () => {
  const fake = makeFakeClickup({ id: 't1' });
  const created = '2026-10-01T02:00:00.000Z';
  const at = (iso) => ({ now: new Date(iso) });

  await syncTicketDatesChecklist(fake.clickupRequest, 't1', { created_at: created, labels: ['On-Going Development'] }, 'ongoing dev', at('2026-10-02T00:00:00Z'));
  await syncTicketDatesChecklist(fake.clickupRequest, 't1', { created_at: created, labels: [{ title: 'For Release' }] }, 'for release', at('2026-10-10T09:00:00Z'));
  await syncTicketDatesChecklist(fake.clickupRequest, 't1', { created_at: created, labels: ['Released'] }, 'released to prod', at('2026-10-12T15:30:00Z'));
  await syncTicketDatesChecklist(fake.clickupRequest, 't1', { created_at: created, labels: [] }, 'Closed', at('2026-10-20T00:00:00Z'));

  assert.deepEqual(ticketDates(fake.store).items.map((i) => i.name), [
    'created_at: 2026-10-01 02:00:00 UTC',
    'for_release_at: 2026-10-10 09:00:00 UTC',
    'released_at: 2026-10-12 15:30:00 UTC',
  ]);
});
