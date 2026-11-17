const { BLOCKS } = require('./blocks');

const MAX_BLOCKS = 25; // bounded by Discord's 25-option cursor select
const MAX_DEPTH = 3;   // four levels, 0..3

// Returns every problem at once rather than the first, so the builder can show
// a complete list instead of making the author fix one error per save attempt.
function validate(blocks, { sounds = {} } = {}) {
  const errors = [];

  if (blocks.length === 0) errors.push('The command has no blocks.');
  if (blocks.length > MAX_BLOCKS) {
    errors.push(`Too many blocks: ${blocks.length}, the limit is ${MAX_BLOCKS}.`);
  }

  let prevDepth = -1;
  blocks.forEach((block, i) => {
    const n = i + 1;
    const def = BLOCKS[block.op];

    if (!def) {
      errors.push(`Block #${n}: unknown block "${block.op}".`);
      prevDepth = block.depth;
      return;
    }

    if (block.depth > MAX_DEPTH) {
      errors.push(`Block #${n}: nesting too deep (max ${MAX_DEPTH}).`);
    }
    if (block.depth > prevDepth + 1) {
      errors.push(`Block #${n}: indented more than one level past the block above it.`);
    }

    for (const param of def.params) {
      const value = block.args?.[param.name];
      if (value === undefined || value === null || value === '') {
        errors.push(`Block #${n}: missing "${param.name}".`);
        continue;
      }
      if (param.type === 'sound' && !sounds[value]) {
        errors.push(`Block #${n}: no uploaded sound named "${value}".`);
      }
    }

    if (block.op === 'else') {
      const owner = findOwningIf(blocks, i);
      if (owner === null) {
        errors.push(`Block #${n}: "else" has no matching "if" at the same level.`);
      } else if (!hasBody(blocks, owner, block.depth)) {
        errors.push(`Block #${n}: the "if" above this "else" has an empty body.`);
      }
    }

    prevDepth = block.depth;
  });

  const transactional = blocks.every((b) => BLOCKS[b.op]?.reversible !== false);
  return { errors, transactional };
}

// The nearest preceding block at the same depth must be an `if`.
function findOwningIf(blocks, index) {
  for (let i = index - 1; i >= 0; i--) {
    if (blocks[i].depth < blocks[index].depth) return null;
    if (blocks[i].depth === blocks[index].depth) {
      return blocks[i].op === 'if' ? i : null;
    }
  }
  return null;
}

function hasBody(blocks, ifIndex, depth) {
  const next = blocks[ifIndex + 1];
  return Boolean(next && next.depth > depth);
}

module.exports = { validate, MAX_BLOCKS, MAX_DEPTH };
