// test/store.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botstore-'));
  process.env.BOT_DATA_DIR = dir;
  delete require.cache[require.resolve('../src/store')];
  return { dir, store: require('../src/store') };
}

test('load returns an empty store when the guild file does not exist', () => {
  const { store } = freshRoot();
  assert.deepStrictEqual(store.load('123'), { commands: {}, sounds: {} });
});

test('save then load round-trips', () => {
  const { store } = freshRoot();
  const data = { commands: { chaos: { blocks: [], runRole: 'everyone' } }, sounds: {} };
  store.save('123', data);
  assert.deepStrictEqual(store.load('123'), data);
});

test('save leaves no temp file behind', () => {
  const { dir, store } = freshRoot();
  store.save('123', { commands: {}, sounds: {} });
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepStrictEqual(leftovers, []);
});

test('two guilds do not share state', () => {
  const { store } = freshRoot();
  store.save('111', { commands: { a: {} }, sounds: {} });
  store.save('222', { commands: { b: {} }, sounds: {} });
  assert.deepStrictEqual(Object.keys(store.load('111').commands), ['a']);
  assert.deepStrictEqual(Object.keys(store.load('222').commands), ['b']);
});

test('mediaDir is per guild and under the data root', () => {
  const { dir, store } = freshRoot();
  assert.strictEqual(store.mediaDir('123'), path.join(dir, 'media', '123'));
});
