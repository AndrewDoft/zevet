import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, startHub, post, state } from './helpers.mjs';

const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');
// These small source slices have only annotations, no TypeScript runtime syntax.
// Strip just those annotations so the root gate still runs on Node 20 without
// loading the board's compiler or browser bootstrap.
const run = (source, context) => vm.runInNewContext(source
  .replace(/: \{ root: TreeNode; now: number \}/g, '')
  .replace(/: (?:Partial<BoardState>|Promise<string>|HubEvent\[\]|HubEvent|TreeNode|FlowNodeState|boolean|void|string(?: \| "file")?)/g, '')
  .replace(/: "dir" \| "file"/g, '')
  .replace(/e\.target!/g, 'e.target'), context);
const fn = (file, name) => read(file).match(new RegExp(`(?:export )?function ${name}\\([^]*?^}`, 'm'))[0].replace(/^export /, '');
const board = 'board/src/lib/board.ts';
const checkout = (root) => createHash('sha256').update(root.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()).digest('hex');

const activityCases = [
  ['teammate, same repo, other checkout', { actor: 'teammate', machine: 'their-pc', checkout: checkout('/home/them/zevet') }, true],
  ['me, other worktree', { machine: 'my-pc', checkout: checkout('C:/dev/zw/other') }, false],
  ['me, same checkout', { machine: 'my-pc', checkout: checkout('C:/dev/zw/zevet') }, true],
  ['old local client without checkout', { machine: 'my-pc' }, true],
  ['old teammate client without checkout', { actor: 'teammate', machine: 'their-pc' }, true],
  ['same actor on another machine', { machine: 'their-pc', checkout: checkout('/home/me/zevet') }, true],
  ['another actor on this machine in another worktree', { actor: 'other', machine: 'my-pc', checkout: checkout('C:/dev/zw/other') }, false],
  ['another repo with same checkout', { repo: 'other', machine: 'my-pc', checkout: checkout('C:/dev/zw/zevet') }, false],
  ['another repo from teammate', { actor: 'teammate', repo: 'other', machine: 'their-pc' }, false],
  ...['../_findings/muse.json', 'C:/dev/zw/_findings/muse.json', '/tmp/muse.json', 'src/../../outside', './detail.tsx', 'src//detail.tsx', 'src\\detail.tsx'].map((target) =>
    [`unsafe path ${target}`, { actor: 'teammate', machine: 'their-pc', target }, false]),
];

for (const [label, fields, allowed] of activityCases) {
  test(`tree and follow: ${label}`, () => {
    const e = { kind: 'tool', repo: 'zevet', actor: 'me', ts: 1, target: 'detail.tsx', ...fields };
    const g = { localRoot: 'C:/dev/zw/zevet/', localCheckout: checkout('C:/dev/zw/zevet'), localEntries: [], events: [e], selectedRepo: null, followMode: 'all', myActor: 'me', myMachine: 'my-pc' };
    const opened = [];
    const context = { e, useBoard: { getState: () => g, setState: (p) => Object.assign(g, p) }, bridge: { local: {} }, serverNow: () => 2, scoped: () => g.events, revealPath: () => {}, toggleSelection: (p) => opened.push(p), pendingAgentLine: null };
    run(['localActivity', 'fileEvents', 'blankNode', 'buildTree', 'followEvent'].map((name) => fn(board, name)).join('\n') + '\nthis.tree = buildTree(); followEvent(e);', context);
    assert.deepEqual(Object.keys(context.tree.root.children), allowed ? ['detail.tsx'] : []);
    assert.deepEqual(opened, allowed ? ['detail.tsx'] : []);
    assert.equal(g.selectedRepo, allowed ? 'zevet' : null);
  });
}

test('desktop config supplies the event producers machine identity', () => {
  const source = read('desktop/main.js').match(/ipcMain\.handle\("zevet:config", \(\) => \{[^]*?^\}\);/m)[0];
  let config;
  vm.runInNewContext(source, { ipcMain: { handle: (_name, handler) => { config = handler(); } }, readConfig: () => ({ actor: 'me' }), storedMode: () => '', os: { hostname: () => 'my-pc' } });
  assert.equal(config.machine, 'my-pc');
});

test('hook and standalone plugin never collapse an outside path to a basename', () => {
  for (const file of ['client/hook.mjs', 'client/opencode-plugin.mjs']) {
    const context = { path: path.win32 };
    run(`${fn(file, 'repoRelative')}\nthis.relative = repoRelative;`, context);
    assert.equal(context.relative('C:/dev/zw/_findings/muse.json', 'C:/dev/zw/zevet'), null);
    assert.equal(context.relative('../other/detail.tsx', 'C:/dev/zw/zevet'), null);
    assert.equal(context.relative('detail.tsx', null), null);
    assert.equal(context.relative('C:/dev/zw/zevet/board/src/detail.tsx', 'C:/dev/zw/zevet'), 'board/src/detail.tsx');
    assert.equal(context.relative('detail.tsx', 'C:/dev/zw/zevet', 'C:/dev/zw/zevet/board/src'), 'board/src/detail.tsx');
  }
});

test('hub retains opaque checkout identity', async (t) => {
  const hub = await startHub();
  t.after(() => hub.stop());
  const id = checkout('C:/dev/zw/zevet');
  await post(hub.base, { kind: 'tool', target: 'src/a.ts', checkout: id });
  assert.equal((await state(hub.base)).body.events.at(-1).checkout, id);
});

test('ended task calls cannot remain pending or active', () => {
  const src = read('board/src/components/graphviews.tsx');
  const calculation = src.slice(src.indexOf('    const hasResult ='), src.indexOf('    return {', src.indexOf('    const hasResult =')));
  for (const [c, running, expected] of [[{}, false, 'done'], [{ startedAt: 1 }, false, 'done'], [{ isError: true }, false, 'failed'], [{ result: 'ok' }, false, 'done'], [{ isError: true, result: 'error' }, true, 'failed'], [{ endedAt: 2 }, true, 'done'], [{ startedAt: 1 }, true, 'active'], [{}, true, 'pending']]) {
    const context = { c, active: { running } };
    run(`${calculation}\nthis.result = state;`, context);
    assert.equal(context.result, expected);
  }
});

test('session ages subscribe to the shared clock at minute granularity', () => {
  const src = read('board/src/components/sessions.tsx');
  const prefix = src.slice(src.indexOf('\n', src.indexOf('function SessionRow')), src.indexOf('  return ('));
  const selectors = [];
  run(`function row(s) { ${prefix} } row({});`, { useBoard: (select) => { selectors.push(select); return select({ sessions: {}, tick: 0 }); }, sessionProject: () => '' });
  const ticking = selectors.find((select) => select({ sessions: {}, tick: 0 }) !== select({ sessions: {}, tick: 60 }));
  assert.ok(ticking, 'no ticking subscription');
  assert.equal(ticking({ sessions: {}, tick: 0 }), ticking({ sessions: {}, tick: 59 }));
});

test('AskAgain closes when the active console changes', () => {
  const src = read('board/src/components/rewind.tsx');
  const prefix = src.slice(src.indexOf('  const active =', src.indexOf('export function AskAgain')), src.indexOf('  // Nothing to re-ask'));
  let open = true;
  let active = { key: 1, transcript: { messages: [] } };
  let effectDeps;
  const context = { useBoard: () => active, selectActiveConsole: () => {}, useState: () => [open, (v) => { open = v; }], useEffect: (effect, deps) => { if (!effectDeps || deps.some((v, i) => v !== effectDeps[i])) effect(); effectDeps = deps; }, textOf: () => '', lastUserMessage: () => null };
  run(`function render() { ${prefix} } render();`, context);
  open = true;
  active = { key: 2, transcript: { messages: [] } };
  run(`render();`, context);
  assert.equal(open, false);
});


test('checkout fingerprints agree across producers and browser, distinguishing worktrees', async () => {
  const browser = { crypto, TextEncoder };
  const src = read(board).match(/async function checkoutId\([^]*?^}/m)[0];
  run(`${src}\nthis.id = checkoutId;`, browser);
  for (const file of ['client/hook.mjs', 'client/opencode-plugin.mjs']) {
    const producer = { createHash };
    run(`${fn(file, 'checkoutId')}\nthis.id = checkoutId;`, producer);
    for (const root of ['C:\\dev\\zw\\zevet', 'c:/dev/zw/zevet/', '/home/me/zevet', '/home/me/Zevet']) {
      assert.equal(await browser.id(root), producer.id(root));
    }
    assert.equal(producer.id('C:/dev/zw/zevet'), producer.id('c:/dev/zw/ZEVET/'));
    assert.notEqual(producer.id('/home/me/zevet'), producer.id('/home/me/Zevet'));
    assert.notEqual(producer.id('C:/dev/zw/zevet'), producer.id('C:/dev/zw/phantom'));
  }
});

test('verified activity builds nested paths and follow opens them', () => {
  const id = checkout('C:/dev/zw/zevet');
  const e = { kind: 'tool', target: 'board/src/detail.tsx', checkout: id, repo: 'zevet', actor: 'me', ts: 1 };
  const g = { localRoot: 'C:/dev/zw/zevet', localCheckout: id, localEntries: [], events: [e], followMode: 'mine', myActor: 'me' };
  const opened = [];
  const context = { e, useBoard: { getState: () => g, setState: (p) => Object.assign(g, p) }, bridge: { local: {} }, serverNow: () => 2, scoped: () => g.events, revealPath: () => {}, toggleSelection: (p) => opened.push(p), pendingAgentLine: null };
  run(['localActivity', 'fileEvents', 'blankNode', 'buildTree', 'followEvent'].map((name) => fn(board, name)).join('\n') + '\nthis.tree = buildTree(); followEvent(e);', context);
  assert.equal(context.tree.root.children.board.children.src.children['detail.tsx'].who.me, 1);
  assert.deepEqual(opened, ['board/src/detail.tsx']);
});
