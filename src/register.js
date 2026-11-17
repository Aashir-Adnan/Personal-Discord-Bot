const { Routes } = require('discord.js');
const { load } = require('./store');

const MAX_GUILD_COMMANDS = 100; // Discord's per-guild ceiling

// Names a custom command may not take.
const BUILTIN_NAMES = ['build-command', 'add-sound', 'list-commands', 'delete-command'];

const BUILTINS = [
  {
    name: 'build-command',
    description: 'Build or edit a custom command from blocks',
    dm_permission: false,
    default_member_permissions: String(1 << 5), // ManageGuild
    options: [{ name: 'name', description: 'Command name (a-z, 0-9, dashes)', type: 3, required: true }],
  },
  {
    name: 'add-sound',
    description: 'Upload a sound for Play Sound blocks',
    dm_permission: false,
    default_member_permissions: String(1 << 5),
    options: [
      { name: 'name', description: 'Name to reference it by', type: 3, required: true },
      { name: 'file', description: 'Audio file', type: 11, required: true },
    ],
  },
  { name: 'list-commands', description: 'List this server\'s custom commands', dm_permission: false },
  {
    name: 'delete-command',
    description: 'Delete a custom command',
    dm_permission: false,
    default_member_permissions: String(1 << 5),
    options: [{ name: 'name', description: 'Command to delete', type: 3, required: true }],
  },
];

function buildCommandList(guildId, overrideData) {
  const { commands } = overrideData || load(guildId);
  const custom = Object.entries(commands).map(([name, cmd]) => ({
    name,
    description: cmd.description || `Custom command: ${name}`,
    dm_permission: false,
  }));
  return [...BUILTINS, ...custom];
}

// Registration is the step that can be rejected for reasons outside our
// control, so callers run it BEFORE writing the store: a rejection then leaves
// nothing to undo.
async function syncGuild(rest, clientId, guildId, overrideData) {
  const body = buildCommandList(guildId, overrideData);
  if (body.length > MAX_GUILD_COMMANDS) {
    throw new Error(
      `This server would have ${body.length} commands; Discord's limit is ${MAX_GUILD_COMMANDS}. Delete one first.`,
    );
  }
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
  return body;
}

module.exports = { buildCommandList, syncGuild, BUILTIN_NAMES, BUILTINS, MAX_GUILD_COMMANDS };
