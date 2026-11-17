// src/blocks.js
const { ChannelType, PermissionFlagsBits } = require('discord.js');

// Every block declares itself exactly once. The builder UI, the save-time
// validator and the runtime all read this table.
//
// run(ctx, args) performs the effect and RETURNS ITS OWN UNDO CLOSURE, or
// undefined when it changed no state. Capturing the before-state inside run
// keeps the change and its inverse in one place so they cannot drift apart.

const voiceMembers = (ctx) =>
  [...ctx.guild.channels.cache.values()]
    .filter((c) => c.isVoiceBased())
    .flatMap((c) => [...c.members.values()])
    .filter((m) => m.id !== ctx.botId);

const BLOCKS = {
  'join': {
    label: 'Join channel',
    kind: 'action',
    reversible: true,
    params: [{ name: 'channel', type: 'channel' }],
    run: async (ctx, a) => {
      const channel = await ctx.channel(a.channel);
      if (!channel) throw new Error(`channel "${a.channel}" not found`);
      await ctx.voice.join(channel);
      return () => ctx.voice.leave();
    },
  },

  'leave': {
    label: 'Leave voice',
    kind: 'action',
    reversible: true,
    params: [],
    run: async (ctx) => {
      const was = ctx.voice.joined;
      await ctx.voice.leave();
      return was ? () => ctx.voice.join(was) : undefined;
    },
  },

  'play': {
    label: 'Play sound',
    kind: 'action',
    reversible: true, // nothing to undo: a played sound changes no state
    params: [{ name: 'sound', type: 'sound' }],
    run: async (ctx, a) => {
      await ctx.voice.play(a.sound);
      return undefined;
    },
  },

  'wait': {
    label: 'Wait',
    kind: 'action',
    reversible: true,
    params: [{ name: 'seconds', type: 'number' }],
    run: async (ctx, a) => {
      await new Promise((r) => setTimeout(r, Math.min(30, Number(a.seconds)) * 1000));
      return undefined;
    },
  },

  'move-user': {
    label: 'Move user',
    kind: 'action',
    reversible: true,
    params: [{ name: 'user', type: 'user' }, { name: 'channel', type: 'channel' }],
    run: async (ctx, a) => {
      const member = await ctx.member(a.user);
      const dest = await ctx.channel(a.channel);
      if (!member) throw new Error(`member "${a.user}" not found`);
      if (!dest) throw new Error(`channel "${a.channel}" not found`);
      const from = member.voice.channelId;
      await member.voice.setChannel(dest);
      return from ? () => member.voice.setChannel(from) : undefined;
    },
  },

  'move-all': {
    label: 'Move everyone',
    kind: 'action',
    reversible: true,
    params: [{ name: 'channel', type: 'channel' }],
    run: async (ctx, a) => {
      const dest = await ctx.channel(a.channel);
      if (!dest) throw new Error(`channel "${a.channel}" not found`);
      const undos = [];
      for (const member of voiceMembers(ctx)) {
        if (member.voice.channelId === dest.id) continue;
        ctx.budget.iteration();
        const from = member.voice.channelId;
        try {
          await member.voice.setChannel(dest);
          undos.push(() => member.voice.setChannel(from));
          ctx.tally.moved++;
        } catch {
          ctx.tally.failed++; // tolerated: a partial outcome, not a run failure
        }
      }
      return async () => {
        for (const undo of undos.reverse()) await undo();
      };
    },
  },

  'kick-voice': {
    label: 'Disconnect user',
    kind: 'action',
    reversible: false, // a user cannot be forced to reconnect
    params: [{ name: 'user', type: 'user' }],
    run: async (ctx, a) => {
      const member = await ctx.member(a.user);
      if (!member) throw new Error(`member "${a.user}" not found`);
      await member.voice.disconnect();
      return undefined;
    },
  },

  'create-vc': {
    label: 'Create voice channel',
    kind: 'action',
    reversible: true,
    params: [{ name: 'name', type: 'text' }, { name: 'private', type: 'boolean' }],
    // Get-or-create: an existing channel is returned untouched and carries NO
    // undo, so rollback never deletes a channel this run did not create.
    run: async (ctx, a) => {
      const existing = [...ctx.guild.channels.cache.values()]
        .find((c) => c.isVoiceBased() && c.name === a.name);
      if (existing) return undefined;

      const overwrites = a.private
        ? [
            {
              id: ctx.guild.roles.everyone.id,
              allow: [PermissionFlagsBits.ViewChannel],
              deny: [PermissionFlagsBits.Connect],
            },
            {
              id: ctx.botId,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.Connect,
                PermissionFlagsBits.Speak,
                PermissionFlagsBits.MoveMembers,
              ],
            },
          ]
        : [];

      const channel = await ctx.guild.channels.create({
        name: a.name,
        type: ChannelType.GuildVoice,
        permissionOverwrites: overwrites,
        reason: 'block command: create-vc',
      });
      return () => channel.delete('block command rollback');
    },
  },

  'delete-vc': {
    label: 'Delete voice channel',
    kind: 'action',
    reversible: false, // a recreated channel has a new id
    params: [{ name: 'channel', type: 'channel' }],
    run: async (ctx, a) => {
      const channel = await ctx.channel(a.channel);
      if (!channel) throw new Error(`channel "${a.channel}" not found`);
      await channel.delete('block command: delete-vc');
      return undefined;
    },
  },

  // Control blocks declare their shape here; the interpreter executes them.
  'if':      { label: 'If',       kind: 'block',  reversible: true, params: [{ name: 'cond', type: 'condition' }] },
  'else':    { label: 'Else',     kind: 'clause', reversible: true, params: [] },
  'foreach': { label: 'For each', kind: 'block',  reversible: true, params: [{ name: 'iter', type: 'iterator' }] },
  'repeat':  { label: 'Repeat',   kind: 'block',  reversible: true, params: [{ name: 'count', type: 'number' }] },
};

module.exports = { BLOCKS, voiceMembers };
