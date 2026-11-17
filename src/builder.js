const { BLOCKS, CONDITIONS, ITERATORS } = require('./blocks');

// One block as a single line: label plus the argument values that identify it.
function describeBlock(block) {
  const def = BLOCKS[block.op];
  const label = def ? def.label : block.op;
  const args = block.args || {};

  if (block.op === 'if') {
    const cond = CONDITIONS[args.cond];
    return `if ${cond ? cond.label : args.cond}${detail(args, ['cond'])}`;
  }
  if (block.op === 'foreach') {
    const iter = ITERATORS[args.iter];
    return `for ${iter ? iter.label : args.iter}${detail(args, ['iter'])}`;
  }
  if (block.op === 'else') return 'else';

  return `${label}${detail(args, [])}`;
}

function detail(args, skip) {
  const values = Object.entries(args)
    .filter(([key]) => !skip.includes(key))
    .map(([, value]) => String(value));
  return values.length ? `: ${values.join(' → ')}` : '';
}

function renderStack(blocks, { cursor = null } = {}) {
  if (!blocks.length) return '```\n(empty — add a block to begin)\n```';
  const lines = blocks.map((block, i) => {
    const mark = i === cursor ? '›' : ' ';
    const number = String(i + 1).padStart(2, ' ');
    return `${mark}${number}. ${'  '.repeat(block.depth)}${describeBlock(block)}`;
  });
  return '```\n' + lines.join('\n') + '\n```';
}

module.exports = { renderStack, describeBlock };
