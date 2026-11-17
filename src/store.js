// src/store.js
const fs = require('fs');
const path = require('path');

// Overridable so tests never touch the real data/ directory.
function dataRoot() {
  return process.env.BOT_DATA_DIR || path.join(__dirname, '..', 'data');
}

const storePath = (guildId) => path.join(dataRoot(), `${guildId}.json`);
const mediaDir = (guildId) => path.join(dataRoot(), 'media', guildId);
const soundPath = (guildId, file) => path.join(mediaDir(guildId), file);

function load(guildId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(guildId), 'utf8'));
    return { commands: parsed.commands || {}, sounds: parsed.sounds || {} };
  } catch (err) {
    if (err.code === 'ENOENT') return { commands: {}, sounds: {} };
    throw err;
  }
}

// Write to a temp file and rename, so a crash mid-write cannot leave a
// half-written store that fails to parse on next boot.
function save(guildId, data) {
  fs.mkdirSync(dataRoot(), { recursive: true });
  const target = storePath(guildId);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, target);
}

module.exports = { load, save, mediaDir, soundPath, dataRoot };
