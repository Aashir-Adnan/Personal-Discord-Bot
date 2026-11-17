require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('domain-expansion')
    .setDescription('Join your voice channel, play the domain expansion, then pull everyone into Infinite Mighty')
    .setDMPermission(false)
    .toJSON(),
];

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('Set DISCORD_TOKEN and CLIENT_ID in .env');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
const route = GUILD_ID
  ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
  : Routes.applicationCommands(CLIENT_ID);

rest
  .put(route, { body: commands })
  .then(() => console.log(`Registered ${commands.length} command(s) ${GUILD_ID ? 'to guild ' + GUILD_ID : 'globally'}`))
  .catch(console.error);
