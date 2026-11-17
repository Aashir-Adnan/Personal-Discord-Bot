// Minimal fakes for the slice of discord.js the blocks touch. Members carry
// a failMove flag so per-member failure paths can be exercised deliberately.

function stubGuild(spec) {
  const channels = new Map();
  const members = new Map();
  let nextId = 100;

  for (const c of spec.channels || []) {
    channels.set(c.id, {
      id: c.id,
      name: c.name,
      type: c.type ?? 2,
      isVoiceBased: () => (c.type ?? 2) === 2,
      get members() {
        return new Map([...members].filter(([, m]) => m.voice.channelId === c.id));
      },
      delete: async () => { channels.delete(c.id); },
    });
  }

  for (const m of spec.members || []) {
    members.set(m.id, {
      id: m.id,
      displayName: m.name,
      failMove: false,
      roles: { cache: new Map((m.roles || []).map((r) => [r, { id: r }])) },
      voice: {
        channelId: m.channelId,
        setChannel: async function (target) {
          if (members.get(m.id).failMove) throw new Error('Missing Permissions');
          this.channelId = target === null ? null : (target.id ?? target);
        },
        disconnect: async function () { this.channelId = null; },
      },
    });
  }

  const guild = {
    id: 'g1',
    channels: {
      cache: channels,
      create: async ({ name, type }) => {
        const id = `c${nextId++}`;
        const ch = {
          id, name, type: type ?? 2,
          isVoiceBased: () => true,
          get members() {
            return new Map([...members].filter(([, m]) => m.voice.channelId === id));
          },
          delete: async () => { channels.delete(id); },
        };
        channels.set(id, ch);
        return ch;
      },
    },
    roles: { everyone: { id: 'everyone' } },
    members: { cache: members, me: { id: 'bot' }, fetchMe: async () => ({ id: 'bot' }) },
  };

  return { guild, members, channels };
}

module.exports = { stubGuild };
