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

module.exports = { buildTree, createBudget, BudgetError };
