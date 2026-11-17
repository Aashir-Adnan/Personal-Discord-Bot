const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshRoot() {
  process.env.BOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'botreg-'));
  delete require.cache[require.resolve('../src/store')];
  delete require.cache[require.resolve('../src/register')];
  return { store: require('../src/store'), register: require('../src/register') };
}

test('the list always contains the built-ins', () => {
  const { register } = freshRoot();
  const names = register.buildCommandList('g1').map((c) => c.name);
  for (const builtin of register.BUILTIN_NAMES) assert.ok(names.includes(builtin), builtin);
});

test('stored commands appear with their description', () => {
  const { store, register } = freshRoot();
  store.save('g1', { commands: { chaos: { description: 'Pull everyone in', blocks: [] } }, sounds: {} });
  const chaos = register.buildCommandList('g1').find((c) => c.name === 'chaos');
  assert.strictEqual(chaos.description, 'Pull everyone in');
});

test('a command with no description gets a usable fallback', () => {
  const { store, register } = freshRoot();
  store.save('g1', { commands: { chaos: { blocks: [] } }, sounds: {} });
  const chaos = register.buildCommandList('g1').find((c) => c.name === 'chaos');
  assert.ok(chaos.description.length > 0);
});

test('syncGuild PUTs the list and returns it', async () => {
  const { register } = freshRoot();
  let body = null;
  const rest = { put: async (_route, options) => { body = options.body; return body; } };
  await register.syncGuild(rest, 'app1', 'g1');
  assert.ok(Array.isArray(body));
  assert.ok(body.length >= register.BUILTIN_NAMES.length);
});

test('exceeding the guild ceiling throws before any PUT', async () => {
  const { store, register } = freshRoot();
  const commands = {};
  for (let i = 0; i < register.MAX_GUILD_COMMANDS; i++) commands[`cmd-${i}`] = { blocks: [] };
  store.save('g1', { commands, sounds: {} });
  let called = false;
  const rest = { put: async () => { called = true; } };
  await assert.rejects(() => register.syncGuild(rest, 'app1', 'g1'), /100|limit|ceiling/i);
  assert.strictEqual(called, false, 'no PUT was attempted');
});

test('overrideData is used instead of the stored file', () => {
  const { store, register } = freshRoot();
  store.save('g1', { commands: { ondisk: { blocks: [] } }, sounds: {} });
  const pending = { commands: { pending: { description: 'not yet saved', blocks: [] } }, sounds: {} };
  const names = register.buildCommandList('g1', pending).map((c) => c.name);
  assert.ok(names.includes('pending'), 'pending command is registered');
  assert.ok(!names.includes('ondisk'), 'stored command is ignored when an override is given');
});
