const { test } = require('node:test');
const assert = require('node:assert');
const { buildTree } = require('../src/interpreter');

const b = (op, depth, args = {}) => ({ op, args, depth });

test('a flat stack becomes flat nodes', () => {
  const tree = buildTree([b('join', 0), b('play', 0), b('leave', 0)]);
  assert.deepStrictEqual(tree.map((n) => n.op), ['join', 'play', 'leave']);
  assert.deepStrictEqual(tree[0].children, []);
});

test('deeper blocks become children of the block above', () => {
  const tree = buildTree([b('foreach', 0), b('move-user', 1), b('wait', 1)]);
  assert.strictEqual(tree.length, 1);
  assert.deepStrictEqual(tree[0].children.map((n) => n.op), ['move-user', 'wait']);
});

test('a sibling after a nested body returns to the parent level', () => {
  const tree = buildTree([b('foreach', 0), b('move-user', 1), b('leave', 0)]);
  assert.deepStrictEqual(tree.map((n) => n.op), ['foreach', 'leave']);
  assert.deepStrictEqual(tree[0].children.map((n) => n.op), ['move-user']);
});

test('else binds to the preceding if as alt, not as a sibling node', () => {
  const tree = buildTree([
    b('if', 0), b('move-all', 1), b('else', 0), b('create-vc', 1),
  ]);
  assert.deepStrictEqual(tree.map((n) => n.op), ['if']);
  assert.deepStrictEqual(tree[0].children.map((n) => n.op), ['move-all']);
  assert.deepStrictEqual(tree[0].alt.map((n) => n.op), ['create-vc']);
});

test('three levels of nesting', () => {
  const tree = buildTree([b('if', 0), b('foreach', 1), b('move-user', 2)]);
  assert.strictEqual(tree[0].children[0].children[0].op, 'move-user');
});

test('an if with no else has no alt', () => {
  const tree = buildTree([b('if', 0), b('leave', 1)]);
  assert.strictEqual(tree[0].alt, undefined);
});

test('each node carries its 1-based position in the flat list', () => {
  const tree = buildTree([b('join', 0), b('foreach', 0), b('move-user', 1), b('leave', 0)]);
  assert.strictEqual(tree[0].index, 1);
  assert.strictEqual(tree[1].index, 2);
  assert.strictEqual(tree[1].children[0].index, 3);
  assert.strictEqual(tree[2].index, 4);
});

test('index survives an else branch without renumbering', () => {
  const tree = buildTree([b('if', 0), b('leave', 1), b('else', 0), b('join', 1)]);
  assert.strictEqual(tree[0].index, 1);
  assert.strictEqual(tree[0].children[0].index, 2);
  assert.strictEqual(tree[0].alt[0].index, 4);
});
