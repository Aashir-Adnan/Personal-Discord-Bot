const { test } = require('node:test');
const assert = require('node:assert');
const { BLOCKS } = require('../src/blocks');
const { createBudget } = require('../src/interpreter');
const { stubGuild } = require('./helpers/stub-guild');

function makeCtx(spec) {
  const { guild, members } = stubGuild(spec);
  const ctx = {
    guild,
    botId: 'bot',
    caller: members.get('u1'),
    vars: {},
    budget: createBudget(),
    tally: { moved: 0, failed: 0 },
    sounds: {},
    voice: { joined: null, join(ch) { this.joined = ch; }, leave() { this.joined = null; } },
    async channel(ref) {
      if (ref === '{caller}') return guild.channels.cache.get(ctx.caller.voice.channelId);
      if (ref === '{it}') return ctx.vars.it;
      return guild.channels.cache.get(ref)
        || [...guild.channels.cache.values()].find((c) => c.name === ref);
    },
    async member(ref) {
      if (ref === '{caller}') return ctx.caller;
      if (ref === '{it}') return ctx.vars.it;
      return members.get(ref);
    },
  };
  return { ctx, guild, members };
}

const base = {
  channels: [
    { id: 'c1', name: 'General', type: 2 },
    { id: 'c2', name: 'Infinite Mighty', type: 2 },
  ],
  members: [
    { id: 'u1', name: 'adnan', channelId: 'c1' },
    { id: 'u2', name: 'someone', channelId: 'c1' },
  ],
};

test('move-user moves the member and its undo returns them', async () => {
  const { ctx, members } = makeCtx(base);
  const undo = await BLOCKS['move-user'].run(ctx, { user: 'u2', channel: 'c2' });
  assert.strictEqual(members.get('u2').voice.channelId, 'c2');
  await undo();
  assert.strictEqual(members.get('u2').voice.channelId, 'c1');
});

test('move-all sweeps every voice channel and undo restores everyone', async () => {
  const { ctx, members } = makeCtx(base);
  const undo = await BLOCKS['move-all'].run(ctx, { channel: 'c2' });
  assert.strictEqual(members.get('u1').voice.channelId, 'c2');
  assert.strictEqual(members.get('u2').voice.channelId, 'c2');
  await undo();
  assert.strictEqual(members.get('u1').voice.channelId, 'c1');
  assert.strictEqual(members.get('u2').voice.channelId, 'c1');
});

test('move-all tolerates a per-member failure and counts it', async () => {
  const { ctx, guild, members } = makeCtx(base);
  members.get('u2').failMove = true;
  await BLOCKS['move-all'].run(ctx, { channel: 'c2' });
  assert.strictEqual(ctx.tally.moved, 1);
  assert.strictEqual(ctx.tally.failed, 1);
  assert.strictEqual(members.get('u1').voice.channelId, 'c2');
  assert.strictEqual(members.get('u2').voice.channelId, 'c1');
});

test('create-vc creates a private channel and undo deletes it', async () => {
  const { ctx, guild } = makeCtx(base);
  const undo = await BLOCKS['create-vc'].run(ctx, { name: 'Domain', private: true });
  const made = [...guild.channels.cache.values()].find((c) => c.name === 'Domain');
  assert.ok(made, 'channel was created');
  await undo();
  assert.ok(![...guild.channels.cache.values()].some((c) => c.name === 'Domain'));
});

test('create-vc is get-or-create and does NOT undo a channel it only found', async () => {
  const { ctx, guild } = makeCtx(base);
  const before = guild.channels.cache.size;
  const undo = await BLOCKS['create-vc'].run(ctx, { name: 'Infinite Mighty', private: true });
  assert.strictEqual(guild.channels.cache.size, before, 'nothing new created');
  assert.strictEqual(undo, undefined, 'no undo for a channel we did not create');
  assert.ok(guild.channels.cache.has('c2'), 'existing channel survives');
});

test('wait and play report no undo', async () => {
  const { ctx } = makeCtx(base);
  assert.strictEqual(await BLOCKS['wait'].run(ctx, { seconds: 0 }), undefined);
});

test('kick-voice and delete-vc are marked irreversible', () => {
  assert.strictEqual(BLOCKS['kick-voice'].reversible, false);
  assert.strictEqual(BLOCKS['delete-vc'].reversible, false);
  assert.notStrictEqual(BLOCKS['move-user'].reversible, false);
});
