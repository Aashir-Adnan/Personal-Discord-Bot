require('dotenv').config();
const path = require('path');
const fs = require('fs');
const {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
} = require('@discordjs/voice');

// Make sure @discordjs/voice can find ffmpeg (falls back to system ffmpeg if present)
try {
  process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || require('ffmpeg-static');
} catch {}

const SOUND_FILE = path.join(__dirname, 'assets', 'domain-expansion.mp3');
const TARGET_NAME = 'Infinite Mighty';
const busyGuilds = new Set();

const client = new Client({
  // Guilds + GuildVoiceStates are not privileged, so no portal toggles are needed
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once('clientReady', (c) => console.log(`Logged in as ${c.user.tag}`));

// The domain: visible but un-joinable. Only a Move Members drag gets you in.
async function getOrCreateDomain(guild) {
  const existing = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildVoice && c.name === TARGET_NAME
  );
  if (existing) return existing;

  return guild.channels.create({
    name: TARGET_NAME,
    type: ChannelType.GuildVoice,
    reason: 'Domain expansion target channel',
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        allow: [PermissionFlagsBits.ViewChannel],
        deny: [PermissionFlagsBits.Connect],
      },
      {
        id: client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.Speak,
          PermissionFlagsBits.MoveMembers,
        ],
      },
    ],
  });
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'domain-expansion') return;

  const fail = (msg) => interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;

  if (busyGuilds.has(guild.id)) return fail('Already running in this server, hang on.');

  // Where is the invoker?
  const source = interaction.member.voice?.channel;
  if (!source) return fail('Join a voice channel first.');
  if (!fs.existsSync(SOUND_FILE)) return fail('assets/domain-expansion.mp3 is missing.');

  // Fetched, not cached: without the GuildMembers intent the bot never hears about
  // its own role changes, so a role granted after login would stay invisible.
  const me = await guild.members.fetchMe().catch(() => guild.members.me);
  if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return fail('I need Manage Channels to create the Infinite Mighty channel.');
  }

  let target;
  try {
    target = await getOrCreateDomain(guild);
  } catch (err) {
    console.error(err);
    return fail(`Could not create the ${TARGET_NAME} channel.`);
  }
  if (target.id === source.id) return fail('You are already inside the domain.');

  // Permission checks so failures are clear instead of silent
  const srcPerms = source.permissionsFor(me);
  const missing = [];
  if (!srcPerms.has(PermissionFlagsBits.ViewChannel)) missing.push(`View Channel on ${source.name}`);
  if (!srcPerms.has(PermissionFlagsBits.Connect)) missing.push(`Connect on ${source.name}`);
  if (!srcPerms.has(PermissionFlagsBits.Speak)) missing.push(`Speak on ${source.name}`);
  if (!srcPerms.has(PermissionFlagsBits.MoveMembers)) missing.push(`Move Members on ${source.name}`);
  if (missing.length) return fail(`I am missing permissions: ${missing.join(', ')}`);

  busyGuilds.add(guild.id);
  await interaction.deferReply();

  // Snapshot who to move before the bot joins: every voice channel in the guild,
  // hidden ones included (the bot needs View Channel on them to see the occupants).
  const toMove = [...guild.channels.cache.values()]
    .filter((c) => c.isVoiceBased() && c.id !== target.id)
    .flatMap((c) => [...c.members.values()])
    .filter((m) => m.id !== client.user.id);

  let connection;
  try {
    connection = joinVoiceChannel({
      channelId: source.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    connection.on('stateChange', (o, n) => console.log(`[voice] ${o.status} -> ${n.status}`));
    connection.on('error', (e) => console.error('[voice error]', e));

    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    player.on('stateChange', (o, n) => console.log(`[player] ${o.status} -> ${n.status}`));
    player.on('error', (e) => console.error('[player error]', e));
    connection.subscribe(player);
    player.play(createAudioResource(SOUND_FILE));

    // Don't gate on VoiceConnectionStatus.Ready: the handshake completes on its own
    // and the player buffers until it does. Just wait for the track to end, with a
    // backstop so a dud file can't wedge the command.
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 60_000);
      player.once(AudioPlayerStatus.Idle, done);
    });

    const results = await Promise.allSettled(
      toMove.map((m) => m.voice.setChannel(target, `/domain-expansion by ${interaction.user.tag}`))
    );
    const moved = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - moved;

    await interaction.editReply(
      `Domain expanded. ${moved} member(s) trapped in ${target.name}.` +
        (failed ? ` ${failed} escaped.` : '')
    );
  } catch (err) {
    console.error(err);
    await interaction
      .editReply(`Something went wrong joining or playing the sound: ${err.message}`)
      .catch(() => {});
  } finally {
    connection?.destroy();
    busyGuilds.delete(guild.id);
  }
});

client.login(process.env.DISCORD_TOKEN);
