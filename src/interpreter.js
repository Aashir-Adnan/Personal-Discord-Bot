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

module.exports = { buildTree };
