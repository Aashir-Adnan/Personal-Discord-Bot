// test/validate.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { validate, MAX_BLOCKS } = require('../src/validate');

const b = (op, depth, args = {}) => ({ op, args, depth });
const sounds = { airhorn: { file: 'airhorn.mp3' } };
const ok = (blocks) => validate(blocks, { sounds });

test('a valid stack has no errors and is transactional', () => {
  const result = ok([b('join', 0, { channel: '{caller}' }), b('play', 0, { sound: 'airhorn' })]);
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.transactional, true);
});

test('an unknown op is rejected', () => {
  const result = ok([b('explode', 0)]);
  assert.match(result.errors[0], /#1.*explode/i);
});

test('a missing parameter is rejected by name and block number', () => {
  const result = ok([b('move-user', 0, { user: 'u1' })]);
  assert.match(result.errors[0], /#1.*channel/i);
});

test('a sound not in the library is rejected', () => {
  const result = ok([b('play', 0, { sound: 'nope' })]);
  assert.match(result.errors[0], /#1.*nope/i);
});

test('indenting more than one level past the block above is rejected', () => {
  const result = ok([b('join', 0, { channel: 'c1' }), b('leave', 2)]);
  assert.match(result.errors[0], /#2.*indent/i);
});

test('the first block must be at depth 0', () => {
  const result = ok([b('leave', 1)]);
  assert.match(result.errors[0], /#1.*indent/i);
});

test('nesting deeper than MAX_DEPTH is rejected', () => {
  const result = ok([
    b('if', 0, { cond: 'channel-exists' }), b('if', 1, { cond: 'channel-exists' }),
    b('if', 2, { cond: 'channel-exists' }), b('if', 3, { cond: 'channel-exists' }),
    b('leave', 4),
  ]);
  assert.ok(result.errors.some((e) => /too deep|nesting/i.test(e)));
});

test('an else with no preceding if is rejected', () => {
  const result = ok([b('join', 0, { channel: 'c1' }), b('else', 0)]);
  assert.match(result.errors.join(' '), /#2.*else/i);
});

test('an else whose if has an empty body is rejected', () => {
  const result = ok([b('if', 0, { cond: 'channel-exists' }), b('else', 0)]);
  assert.match(result.errors.join(' '), /else|empty/i);
});

test('a valid if/else passes', () => {
  const result = ok([
    b('if', 0, { cond: 'channel-exists' }),
    b('leave', 1),
    b('else', 0),
    b('join', 1, { channel: 'c1' }),
  ]);
  assert.deepStrictEqual(result.errors, []);
});

test('more than MAX_BLOCKS blocks is rejected', () => {
  const blocks = Array.from({ length: MAX_BLOCKS + 1 }, () => b('leave', 0));
  assert.ok(ok(blocks).errors.some((e) => new RegExp(String(MAX_BLOCKS)).test(e)));
});

test('an irreversible block makes the stack non-transactional but still valid', () => {
  const result = ok([b('kick-voice', 0, { user: 'u1' })]);
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.transactional, false);
});
