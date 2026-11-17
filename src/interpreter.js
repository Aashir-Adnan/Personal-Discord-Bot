// Blocks are stored flat with a depth integer; nesting is derived the way
// Python derives it from indentation. A control block's body is the
// contiguous run of blocks below it at greater depth.
// Assumes validated input — src/validate.js guarantees else has a preceding if.
function buildTree(blocks) {
  const root = [];
  const stack = [{ depth: -1, children: root }];

  blocks.forEach((block, i) => {
    while (stack[stack.length - 1].depth >= block.depth) stack.pop();
    const parent = stack[stack.length - 1];

    if (block.op === 'else') {
      const owner = parent.children[parent.children.length - 1];
      owner.alt = [];
      stack.push({ depth: block.depth, children: owner.alt });
      return;
    }

    const node = { op: block.op, args: block.args, children: [], index: i + 1 };
    parent.children.push(node);
    stack.push({ depth: block.depth, children: node.children });
  });

  return root;
}

class BudgetError extends Error {}

// Runaway loops against the Discord API mean rate-limit bans, so these caps
// are enforced rather than advisory.
function createBudget({ maxIterations = 200, maxMs = 60_000, now = Date.now } = {}) {
  const started = now();
  let iterations = 0;

  const clock = () => {
    if (now() - started > maxMs) {
      throw new BudgetError(`time budget exceeded (${maxMs / 1000}s)`);
    }
  };

  return {
    clock,
    iteration() {
      if (++iterations > maxIterations) {
        throw new BudgetError(`loop budget exceeded (${maxIterations} iterations)`);
      }
      clock();
    },
  };
}

// Executing a node tree. Control flow lives here rather than in the registry,
// because only the interpreter has the tree.
async function run(blocks, ctx, options = {}) {
  const registry = options.registry || require('./blocks');
  const transactional = options.transactional !== false;

  const tree = buildTree(blocks);
  const journal = transactional ? [] : null;
  // Block numbers in errors must match what the builder showed the author,
  // so count executed blocks against the original flat list.
  const counter = { n: 0 };

  try {
    await execList(tree, ctx, registry, journal, counter);
    return {
      ok: true, failedAt: null, error: null,
      rolledBack: 0, undoFailures: [], tally: ctx.tally,
    };
  } catch (err) {
    const undoFailures = [];
    let rolledBack = 0;
    if (journal) {
      for (const undo of journal.reverse()) {
        try {
          await undo();
          rolledBack++;
        } catch (undoErr) {
          undoFailures.push(undoErr.message);
        }
      }
    }
    return {
      ok: false,
      failedAt: counter.n,
      error: err.message,
      rolledBack,
      undoFailures,
      tally: ctx.tally,
    };
  }
}

async function execList(nodes, ctx, registry, journal, counter) {
  for (const node of nodes) {
    // Use the node's own 1-based position in the original flat list, not a
    // per-execution count — a loop body runs multiple times and would push
    // a naive counter past the block number the author actually saw.
    counter.n = node.index;
    ctx.budget.clock();

    if (node.op === 'if') {
      const condition = registry.CONDITIONS[node.args.cond];
      if (!condition) throw new Error(`unknown condition "${node.args.cond}"`);
      const branch = (await condition.test(ctx, node.args)) ? node.children : node.alt || [];
      await execList(branch, ctx, registry, journal, counter);
      continue;
    }

    if (node.op === 'foreach') {
      const iterator = registry.ITERATORS[node.args.iter];
      if (!iterator) throw new Error(`unknown iterator "${node.args.iter}"`);
      const saved = ctx.vars.it;
      for (const item of await iterator.items(ctx, node.args)) {
        ctx.budget.iteration();
        ctx.vars.it = item;
        await tolerate(() => execList(node.children, ctx, registry, journal, counter), ctx);
      }
      ctx.vars.it = saved;
      continue;
    }

    if (node.op === 'repeat') {
      const count = Math.min(50, Number(node.args.count) || 0);
      for (let i = 0; i < count; i++) {
        ctx.budget.iteration();
        await tolerate(() => execList(node.children, ctx, registry, journal, counter), ctx);
      }
      continue;
    }

    const def = registry.BLOCKS[node.op];
    if (!def || !def.run) throw new Error(`unknown block "${node.op}"`);
    const undo = await def.run(ctx, node.args);
    if (undo && journal) journal.push(undo);
  }
}

// One iteration failing is a partial outcome, not a run failure — the spec's
// own recipe for "move everyone in my channel" is a foreach around move-user,
// and one member the bot cannot move must not undo everyone else.
// A BudgetError is never tolerated: that is the runaway guard, not an outcome.
async function tolerate(body, ctx) {
  try {
    await body();
  } catch (err) {
    if (err instanceof BudgetError) throw err;
    ctx.tally.failed++;
  }
}

module.exports = { buildTree, createBudget, BudgetError, run };
