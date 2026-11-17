// test/interpreter-run.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { run, createBudget } = require('../src/interpreter');

// A tiny block table injected into run(), so interpreter tests exercise
// control flow and rollback without depending on the real Discord blocks.
function harness() {
  const log = [];
  const registry = {
    BLOCKS: {
      'ok': {
        kind: 'action', params: [],
        run: async (ctx, a) => { log.push(`do:${a.tag}`); return () => log.push(`undo:${a.tag}`); },
      },
      'nostate': { kind: 'action', params: [], run: async () => { log.push('nostate'); } },
      'boom': { kind: 'action', params: [], run: async () => { throw new Error('kaboom'); } },
      'badundo': {
        kind: 'action', params: [],
        run: async () => { log.push('do:bad'); return () => { throw new Error('undo failed'); }; },
      },
      'if': { kind: 'block', params: [] },
      'else': { kind: 'clause', params: [] },
      'foreach': { kind: 'block', params: [] },
      'repeat': { kind: 'block', params: [] },
    },
    CONDITIONS: {
      'yes': { test: async () => true },
      'no': { test: async () => false },
    },
    ITERATORS: {
      'three': { items: async () => ['a', 'b', 'c'] },
    },
  };
  const ctx = { vars: {}, budget: createBudget(), tally: { moved: 0, failed: 0 }, log };
  return { log, registry, ctx };
}

const b = (op, depth, args = {}) => ({ op, args, depth });

test('a successful run reports ok and journals nothing back', async () => {
  const { log, registry, ctx } = harness();
  const result = await run([b('ok', 0, { tag: '1' }), b('ok', 0, { tag: '2' })], ctx, { registry });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(log, ['do:1', 'do:2']);
});

test('a failure rolls undos back in REVERSE order', async () => {
  const { log, registry, ctx } = harness();
  const result = await run(
    [b('ok', 0, { tag: '1' }), b('ok', 0, { tag: '2' }), b('boom', 0)],
    ctx, { registry },
  );
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.failedAt, 3);
  assert.strictEqual(result.rolledBack, 2);
  assert.deepStrictEqual(log, ['do:1', 'do:2', 'undo:2', 'undo:1']);
});

test('blocks that changed no state contribute no undo', async () => {
  const { log, registry, ctx } = harness();
  await run([b('nostate', 0), b('boom', 0)], ctx, { registry });
  assert.deepStrictEqual(log, ['nostate']);
});

test('a failing undo does not stop the remaining undos and is reported', async () => {
  const { log, registry, ctx } = harness();
  const result = await run(
    [b('ok', 0, { tag: '1' }), b('badundo', 0), b('boom', 0)],
    ctx, { registry },
  );
  assert.strictEqual(result.undoFailures.length, 1);
  assert.match(result.undoFailures[0], /undo failed/);
  assert.ok(log.includes('undo:1'), 'the earlier undo still ran');
});

test('a non-transactional run keeps no journal and rolls nothing back', async () => {
  const { log, registry, ctx } = harness();
  const result = await run(
    [b('ok', 0, { tag: '1' }), b('boom', 0)],
    ctx, { registry, transactional: false },
  );
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.rolledBack, 0);
  assert.deepStrictEqual(log, ['do:1']);
});

test('if runs its body when the condition holds', async () => {
  const { log, registry, ctx } = harness();
  await run([b('if', 0, { cond: 'yes' }), b('ok', 1, { tag: 'in' })], ctx, { registry });
  assert.deepStrictEqual(log, ['do:in']);
});

test('if skips its body and runs else when the condition is false', async () => {
  const { log, registry, ctx } = harness();
  await run([
    b('if', 0, { cond: 'no' }), b('ok', 1, { tag: 'then' }),
    b('else', 0), b('ok', 1, { tag: 'otherwise' }),
  ], ctx, { registry });
  assert.deepStrictEqual(log, ['do:otherwise']);
});

test('foreach binds {it} once per item', async () => {
  const { registry, ctx } = harness();
  const seen = [];
  registry.BLOCKS['peek'] = { kind: 'action', params: [], run: async (c) => { seen.push(c.vars.it); } };
  await run([b('foreach', 0, { iter: 'three' }), b('peek', 1)], ctx, { registry });
  assert.deepStrictEqual(seen, ['a', 'b', 'c']);
});

test('repeat runs its body count times', async () => {
  const { log, registry, ctx } = harness();
  await run([b('repeat', 0, { count: 3 }), b('ok', 1, { tag: 'x' })], ctx, { registry });
  assert.deepStrictEqual(log, ['do:x', 'do:x', 'do:x']);
});

test('a loop that exceeds the iteration budget aborts and rolls back', async () => {
  const { registry, ctx } = harness();
  ctx.budget = createBudget({ maxIterations: 2 });
  const result = await run([b('repeat', 0, { count: 50 }), b('ok', 1, { tag: 'x' })], ctx, { registry });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /budget/i);
  assert.strictEqual(result.rolledBack, 2);
});

test('undos inside a loop body roll back too', async () => {
  const { log, registry, ctx } = harness();
  await run([
    b('repeat', 0, { count: 2 }), b('ok', 1, { tag: 'loop' }),
    b('boom', 0),
  ], ctx, { registry });
  assert.deepStrictEqual(log, ['do:loop', 'do:loop', 'undo:loop', 'undo:loop']);
});

// The spec's rule: a failure inside a loop is a partial outcome, not a run
// failure. Its own recommended recipe is `foreach members-in` + `move-user`,
// so tolerance has to live in the loop, not only inside move-all.
test('a failing block inside foreach is tolerated and counted, not fatal', async () => {
  const { log, registry, ctx } = harness();
  const result = await run([
    b('foreach', 0, { iter: 'three' }), b('boom', 1),
  ], ctx, { registry });
  assert.strictEqual(result.ok, true, 'the run completes');
  assert.strictEqual(ctx.tally.failed, 3);
  assert.strictEqual(result.rolledBack, 0);
});

test('tolerated loop failures do not discard work from successful iterations', async () => {
  const { log, registry, ctx } = harness();
  let calls = 0;
  registry.BLOCKS['flaky'] = {
    kind: 'action', params: [],
    run: async () => {
      calls++;
      if (calls === 2) throw new Error('nope');
      log.push(`do:${calls}`);
      return () => log.push(`undo:${calls}`);
    },
  };
  const result = await run([b('foreach', 0, { iter: 'three' }), b('flaky', 1)], ctx, { registry });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(ctx.tally.failed, 1);
  assert.deepStrictEqual(log, ['do:1', 'do:3']);
});

test('a budget breach inside a loop is NOT tolerated and still rolls back', async () => {
  const { registry, ctx } = harness();
  ctx.budget = createBudget({ maxIterations: 2 });
  const result = await run([b('foreach', 0, { iter: 'three' }), b('ok', 1, { tag: 'x' })], ctx, { registry });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /budget/i);
  assert.strictEqual(result.rolledBack, 2);
});

test('a failure outside any loop is still fatal', async () => {
  const { registry, ctx } = harness();
  const result = await run([b('ok', 0, { tag: '1' }), b('boom', 0)], ctx, { registry });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.rolledBack, 1);
});

test('failedAt reports the flat block number, not the count of executed nodes', async () => {
  const { registry, ctx } = harness();
  // repeat(#1) { ok(#2) } then boom(#3). The body runs 3x, so a naive
  // per-execution counter would report #5. The author only ever saw 3 blocks.
  const result = await run([
    b('repeat', 0, { count: 3 }), b('ok', 1, { tag: 'x' }), b('boom', 0),
  ], ctx, { registry });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.failedAt, 3);
});
