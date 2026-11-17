// test/builder-render.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { renderStack, describeBlock } = require('../src/builder');

const b = (op, depth, args = {}) => ({ op, args, depth });

test('each block is numbered from 1', () => {
  const out = renderStack([b('leave', 0), b('leave', 0)]);
  assert.match(out, /1\./);
  assert.match(out, /2\./);
});

test('depth is rendered as indentation', () => {
  const out = renderStack([b('foreach', 0, { iter: 'voice-channels' }), b('leave', 1)]);
  const lines = out.split('\n').filter((l) => /^\s*\d+\./.test(l));
  const indent = (l) => l.match(/^\s*\d+\.(\s*)/)[1].length;
  assert.ok(indent(lines[1]) > indent(lines[0]), 'nested block is indented further');
});

test('the cursor marks the selected block', () => {
  const out = renderStack([b('leave', 0), b('leave', 0)], { cursor: 1 });
  const line = out.split('\n').find((l) => /2\./.test(l));
  assert.match(line, /[>›▸]/);
});

test('an empty stack says so instead of rendering nothing', () => {
  assert.match(renderStack([]), /empty|no blocks/i);
});

test('describeBlock shows the label and its argument values', () => {
  const line = describeBlock(b('move-user', 0, { user: '{it}', channel: 'Infinite Mighty' }));
  assert.match(line, /Move user/);
  assert.match(line, /\{it\}/);
  assert.match(line, /Infinite Mighty/);
});

test('describeBlock names the condition for an if', () => {
  assert.match(describeBlock(b('if', 0, { cond: 'channel-exists', name: 'Domain' })), /channel exists/);
});

test('describeBlock names the iterator for a foreach', () => {
  assert.match(describeBlock(b('foreach', 0, { iter: 'members-in', channel: 'c1' })), /each member in/);
});

test('rendering stays under Discord\'s 4096-character embed limit at max blocks', () => {
  const blocks = Array.from({ length: 25 }, () =>
    b('move-user', 3, { user: '{it}', channel: 'A channel with a fairly long name' }));
  assert.ok(renderStack(blocks).length < 4096);
});
