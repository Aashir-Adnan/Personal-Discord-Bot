// test/blocks-conditions.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { CONDITIONS, ITERATORS } = require('../src/blocks');
const { stubGuild } = require('./helpers/stub-guild');

function makeCtx() {
  const { guild, members } = stubGuild({
    channels: [
      { id: 'c1', name: 'General', type: 2 },
      { id: 'c2', name: 'Empty', type: 2 },
    ],
    members: [
      { id: 'u1', name: 'adnan', channelId: 'c1', roles: ['r1'] },
      { id: 'u2', name: 'someone', channelId: 'c1' },
      { id: 'u3', name: 'offline', channelId: null },
    ],
  });
  const ctx = {
    guild,
    botId: 'bot',
    caller: members.get('u1'),
    vars: {},
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

test('channel-exists is true for a present channel, false otherwise', async () => {
  const { ctx } = makeCtx();
  assert.strictEqual(await CONDITIONS['channel-exists'].test(ctx, { name: 'General' }), true);
  assert.strictEqual(await CONDITIONS['channel-exists'].test(ctx, { name: 'Nope' }), false);
});

test('channel-empty reflects occupancy', async () => {
  const { ctx } = makeCtx();
  assert.strictEqual(await CONDITIONS['channel-empty'].test(ctx, { channel: 'c2' }), true);
  assert.strictEqual(await CONDITIONS['channel-empty'].test(ctx, { channel: 'c1' }), false);
});

test('member-in-voice distinguishes connected from not', async () => {
  const { ctx } = makeCtx();
  assert.strictEqual(await CONDITIONS['member-in-voice'].test(ctx, { user: 'u1' }), true);
  assert.strictEqual(await CONDITIONS['member-in-voice'].test(ctx, { user: 'u3' }), false);
});

test('user-has-role checks the role cache', async () => {
  const { ctx } = makeCtx();
  assert.strictEqual(await CONDITIONS['user-has-role'].test(ctx, { user: 'u1', role: 'r1' }), true);
  assert.strictEqual(await CONDITIONS['user-has-role'].test(ctx, { user: 'u2', role: 'r1' }), false);
});

test('member-count-at-least compares occupancy to n', async () => {
  const { ctx } = makeCtx();
  assert.strictEqual(await CONDITIONS['member-count-at-least'].test(ctx, { channel: 'c1', n: 2 }), true);
  assert.strictEqual(await CONDITIONS['member-count-at-least'].test(ctx, { channel: 'c1', n: 3 }), false);
});

test('a condition on a missing channel is false, not a throw', async () => {
  const { ctx } = makeCtx();
  assert.strictEqual(await CONDITIONS['channel-empty'].test(ctx, { channel: 'ghost' }), false);
});

test('members-in yields the members of a channel', async () => {
  const { ctx } = makeCtx();
  const items = await ITERATORS['members-in'].items(ctx, { channel: 'c1' });
  assert.deepStrictEqual(items.map((m) => m.id).sort(), ['u1', 'u2']);
});

test('voice-channels yields every voice channel', async () => {
  const { ctx } = makeCtx();
  const items = await ITERATORS['voice-channels'].items(ctx, {});
  assert.deepStrictEqual(items.map((c) => c.id).sort(), ['c1', 'c2']);
});
