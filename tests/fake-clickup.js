/**
 * In-memory fake of the ClickUp checklist endpoints used by the checklist helpers.
 *
 * makeFakeClickup(initialTask, { failAt }) returns { clickupRequest, calls, store }.
 *  - calls: ordered [{ method, path, body }]
 *  - store: { task } mutated by POST/PUT/DELETE so repeated syncs see prior effects
 *  - failAt(call) => boolean: reject the matching call with an error
 */
function makeFakeClickup(initialTask = {}, { failAt } = {}) {
  const task = JSON.parse(JSON.stringify({ id: 't1', checklists: [], ...initialTask }));
  const calls = [];
  let seq = 0;
  const nextId = (p) => `${p}-${++seq}`;

  const findChecklist = (id) => task.checklists.find((c) => c.id === id);

  async function clickupRequest(method, path, body) {
    const call = { method, path, body };
    calls.push(call);
    if (failAt && failAt(call)) throw new Error(`injected failure: ${method} ${path}`);

    let m;
    if (method === 'GET' && /^\/task\/[^/]+$/.test(path)) {
      return JSON.parse(JSON.stringify(task));
    }
    if (method === 'POST' && (m = path.match(/^\/task\/[^/]+\/checklist$/))) {
      const cl = { id: nextId('cl'), name: body.name, items: [] };
      task.checklists.push(cl);
      return { checklist: JSON.parse(JSON.stringify(cl)) };
    }
    if (method === 'POST' && (m = path.match(/^\/checklist\/([^/]+)\/checklist_item$/))) {
      const cl = findChecklist(m[1]);
      if (!cl) throw new Error('checklist not found');
      cl.items.push({ id: nextId('it'), name: body.name, resolved: false });
      return { checklist: cl };
    }
    if (method === 'PUT' && (m = path.match(/^\/checklist\/([^/]+)\/checklist_item\/([^/]+)$/))) {
      const cl = findChecklist(m[1]);
      const it = cl && cl.items.find((i) => i.id === m[2]);
      if (!it) throw new Error('item not found');
      Object.assign(it, body);
      return { checklist: cl };
    }
    if (method === 'DELETE' && (m = path.match(/^\/checklist\/([^/]+)\/checklist_item\/([^/]+)$/))) {
      const cl = findChecklist(m[1]);
      if (cl) cl.items = cl.items.filter((i) => i.id !== m[2]);
      return { ok: true };
    }
    throw new Error(`unhandled fake call: ${method} ${path}`);
  }

  return { clickupRequest, calls, store: { task } };
}

module.exports = { makeFakeClickup };
