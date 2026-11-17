# Block-Based Command Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a server admin compose permanent, server-specific slash commands inside Discord from a Scratch-style stack of blocks, with uploaded sounds, loops, conditionals, and transactional rollback.

**Architecture:** One registry declares every block type once (label, params, reversibility, `run`); the builder UI, the save-time validator and the runtime all read that table instead of each carrying a parallel `switch`. Stacks are stored flat with a depth integer and converted to a tree at execution. Each block's `run` returns its own undo closure, which the interpreter journals and replays in reverse on failure.

**Tech Stack:** Node 24, CommonJS (`require`, **not** ESM — this repo has no `"type": "module"`), discord.js 14.28, @discordjs/voice 0.19.2, `node --test` + `node:assert` for tests, JSON files for storage.

**Spec:** `docs/superpowers/specs/2026-11-17-block-command-builder-design.md`

## Global Constraints

- **CommonJS only.** `require`/`module.exports`. The sibling Granjur bot uses ESM; this one does not. Do not add `"type": "module"`.
- **No new runtime dependencies.** Everything here is stdlib plus what `package.json` already has.
- **Caps, enforced not advisory:** 25 blocks per command, max `depth` value 3 (four levels, 0–3), 200 loop iterations per run, 60s wall clock per run.
- **Command names** must match `^[a-z0-9-]{1,32}$` and must not collide with a built-in.
- **Discord component limits:** 5 rows per message, 5 buttons per row, 25 options per select, 5 text inputs per modal.
- **Voice:** never gate on `VoiceConnectionStatus.Ready`. Subscribe, play, wait for the player to reach `Idle` with a timeout backstop. This is a fix already landed in `index.js`; regressing it reintroduces an `AbortError`.
- **Data location:** `data/<guildId>.json` and `data/media/<guildId>/`, both gitignored. Tests must override the root via `BOT_DATA_DIR` and never write into the real `data/`.
- **Never commit `.env`.** It holds a live bot token.

## File Structure

| File | Responsibility |
|---|---|
| `src/store.js` | Per-guild JSON load/save, media paths. No Discord knowledge. |
| `src/blocks.js` | The registry: `BLOCKS`, `CONDITIONS`, `ITERATORS`. Each block's params and `run`. |
| `src/interpreter.js` | `buildTree`, `execute`, `rollback`, `createBudget`. Control flow lives here, not in the registry. |
| `src/validate.js` | Save-time validation; computes the `transactional` flag. |
| `src/register.js` | Builds the guild command list and PUTs it to Discord. |
| `src/builder.js` | `/build-command` UI: stack rendering, components, interaction handlers. |
| `index.js` | Client bootstrap + interaction router (modified; its hardcoded handler is deleted in the final task). |
| `test/helpers/stub-guild.js` | Fake guild/member/channel objects whose calls can be made to fail on demand. |
| `test/*.test.js` | One test file per source module. |

---

### Task 1: Per-guild store

**Files:**
- Create: `src/store.js`
- Test: `test/store.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `load(guildId) -> {commands:{}, sounds:{}}`, `save(guildId, data) -> void`, `mediaDir(guildId) -> string`, `soundPath(guildId, file) -> string`, `dataRoot() -> string`.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/store.test.js`
Expected: FAIL — `Cannot find module '../src/store'`

- [ ] **Step 3: Write minimal implementation**

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/store.test.js`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/store.js test/store.test.js
git commit -m "feat: per-guild JSON store with atomic writes"
```

---

### Task 2: Tree building from flat depth

**Files:**
- Create: `src/interpreter.js`
- Test: `test/interpreter-tree.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `buildTree(blocks) -> node[]` where `node = { op, args, children: node[], alt?: node[] }`. `alt` is the `else` branch, present only on `if` nodes that have one.

- [ ] **Step 1: Write the failing test**

```js
// test/interpreter-tree.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildTree } = require('../src/interpreter');

const b = (op, depth, args = {}) => ({ op, args, depth });

test('a flat stack becomes flat nodes', () => {
  const tree = buildTree([b('join', 0), b('play', 0), b('leave', 0)]);
  assert.deepStrictEqual(tree.map((n) => n.op), ['join', 'play', 'leave']);
  assert.deepStrictEqual(tree[0].children, []);
});

test('deeper blocks become children of the block above', () => {
  const tree = buildTree([b('foreach', 0), b('move-user', 1), b('wait', 1)]);
  assert.strictEqual(tree.length, 1);
  assert.deepStrictEqual(tree[0].children.map((n) => n.op), ['move-user', 'wait']);
});

test('a sibling after a nested body returns to the parent level', () => {
  const tree = buildTree([b('foreach', 0), b('move-user', 1), b('leave', 0)]);
  assert.deepStrictEqual(tree.map((n) => n.op), ['foreach', 'leave']);
  assert.deepStrictEqual(tree[0].children.map((n) => n.op), ['move-user']);
});

test('else binds to the preceding if as alt, not as a sibling node', () => {
  const tree = buildTree([
    b('if', 0), b('move-all', 1), b('else', 0), b('create-vc', 1),
  ]);
  assert.deepStrictEqual(tree.map((n) => n.op), ['if']);
  assert.deepStrictEqual(tree[0].children.map((n) => n.op), ['move-all']);
  assert.deepStrictEqual(tree[0].alt.map((n) => n.op), ['create-vc']);
});

test('three levels of nesting', () => {
  const tree = buildTree([b('if', 0), b('foreach', 1), b('move-user', 2)]);
  assert.strictEqual(tree[0].children[0].children[0].op, 'move-user');
});

test('an if with no else has no alt', () => {
  const tree = buildTree([b('if', 0), b('leave', 1)]);
  assert.strictEqual(tree[0].alt, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/interpreter-tree.test.js`
Expected: FAIL — `Cannot find module '../src/interpreter'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/interpreter.js

// Blocks are stored flat with a depth integer; nesting is derived the way
// Python derives it from indentation. A control block's body is the
// contiguous run of blocks below it at greater depth.
// Assumes validated input — src/validate.js guarantees else has a preceding if.
function buildTree(blocks) {
  const root = [];
  const stack = [{ depth: -1, children: root }];

  for (const block of blocks) {
    while (stack[stack.length - 1].depth >= block.depth) stack.pop();
    const parent = stack[stack.length - 1];

    if (block.op === 'else') {
      const owner = parent.children[parent.children.length - 1];
      owner.alt = [];
      stack.push({ depth: block.depth, children: owner.alt });
      continue;
    }

    const node = { op: block.op, args: block.args, children: [] };
    parent.children.push(node);
    stack.push({ depth: block.depth, children: node.children });
  }

  return root;
}

module.exports = { buildTree };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/interpreter-tree.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/interpreter.js test/interpreter-tree.test.js
git commit -m "feat: build execution tree from flat depth-indexed blocks"
```

---

### Task 3: Run budget

**Files:**
- Modify: `src/interpreter.js`
- Test: `test/budget.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `createBudget({maxIterations, maxMs, now}) -> {iteration(), clock()}` and `BudgetError`. `now` is an injectable clock function defaulting to `Date.now`, so the wall-clock cap is testable without sleeping.

- [ ] **Step 1: Write the failing test**

```js
// test/budget.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { createBudget, BudgetError } = require('../src/interpreter');

test('iterations under the cap are allowed', () => {
  const budget = createBudget({ maxIterations: 3 });
  budget.iteration();
  budget.iteration();
  budget.iteration();
});

test('one iteration past the cap throws BudgetError naming the cap', () => {
  const budget = createBudget({ maxIterations: 2 });
  budget.iteration();
  budget.iteration();
  assert.throws(() => budget.iteration(), (err) => {
    assert.ok(err instanceof BudgetError);
    assert.match(err.message, /200|2 iterations|iteration/i);
    return true;
  });
});

test('clock throws once wall time passes maxMs', () => {
  let t = 1000;
  const budget = createBudget({ maxMs: 500, now: () => t });
  budget.clock();
  t = 1600;
  assert.throws(() => budget.clock(), BudgetError);
});

test('iteration also enforces the clock', () => {
  let t = 0;
  const budget = createBudget({ maxIterations: 100, maxMs: 10, now: () => t });
  t = 50;
  assert.throws(() => budget.iteration(), BudgetError);
});

test('defaults are 200 iterations and 60s', () => {
  const budget = createBudget();
  for (let i = 0; i < 200; i++) budget.iteration();
  assert.throws(() => budget.iteration(), BudgetError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/budget.test.js`
Expected: FAIL — `createBudget is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `src/interpreter.js`, and extend the existing `module.exports`:

```js
class BudgetError extends Error {}

// Runaway loops against the Discord API mean rate-limit bans, so these caps
// are enforced rather than advisory.
function createBudget({ maxIterations = 200, maxMs = 60_000, now = Date.now } = {}) {
  const started = now();
  let iterations = 0;

  const clock = () => {
    if (now() - started > maxMs) {
      throw new BudgetError(`time budget exceeded (${maxMs / 1000}s)`);
    }
  };

  return {
    clock,
    iteration() {
      if (++iterations > maxIterations) {
        throw new BudgetError(`loop budget exceeded (${maxIterations} iterations)`);
      }
      clock();
    },
  };
}

module.exports = { buildTree, createBudget, BudgetError };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/budget.test.js`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/interpreter.js test/budget.test.js
git commit -m "feat: enforced run budget for loop iterations and wall clock"
```

---

### Task 4: Stub guild test helper + action blocks

**Files:**
- Create: `test/helpers/stub-guild.js`
- Create: `src/blocks.js`
- Test: `test/blocks-actions.test.js`

**Interfaces:**
- Consumes: `createBudget` (Task 3).
- Produces:
  - `stubGuild(spec) -> { guild, members, failNext(method) }` — `spec` is `{ channels: [{id, name, type}], members: [{id, name, channelId}] }`.
  - `BLOCKS` — a map of op name to `{ label, kind, reversible, params, run }`. `run(ctx, args)` returns an undo closure, or `undefined` when it changed no state.
  - `ctx` shape consumed by every `run`: `{ guild, botId, caller, vars, budget, tally, voice, sounds, channel(ref), member(ref) }`.

**Channel reference resolution** (`ctx.channel`): `{caller}` → the caller's current voice channel; `{it}` → the loop variable; otherwise look up by **id first, then by name**. Name lookup is required because a `create-vc` block creates a channel that has no id at save time, and a later `move-all` must be able to name it.

- [ ] **Step 1: Write the failing test**

```js
// test/blocks-actions.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/blocks-actions.test.js`
Expected: FAIL — `Cannot find module './helpers/stub-guild'`

- [ ] **Step 3: Write the stub helper**

```js
// test/helpers/stub-guild.js
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
    members: { me: { id: 'bot' }, fetchMe: async () => ({ id: 'bot' }) },
  };

  return { guild, members, channels };
}

module.exports = { stubGuild };
```

- [ ] **Step 4: Write the action blocks**

```js
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/blocks-actions.test.js`
Expected: PASS, 7 tests

- [ ] **Step 6: Commit**

```bash
git add src/blocks.js test/helpers/stub-guild.js test/blocks-actions.test.js
git commit -m "feat: action block registry with per-block undo closures"
```

---

### Task 5: Conditions and iterators

**Files:**
- Modify: `src/blocks.js`
- Test: `test/blocks-conditions.test.js`

**Interfaces:**
- Consumes: `ctx` (Task 4).
- Produces: `CONDITIONS` — map of name to `{ label, params, test(ctx, args) -> boolean }`; `ITERATORS` — map of name to `{ label, params, items(ctx, args) -> array }`.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/blocks-conditions.test.js`
Expected: FAIL — `Cannot read properties of undefined (reading 'channel-exists')`

- [ ] **Step 3: Write minimal implementation**

Append to `src/blocks.js` and extend `module.exports`:

```js
// Conditions feed `if`. A reference that resolves to nothing is false rather
// than an error: asking "is this channel empty" about a channel that does not
// exist has a sensible answer.
const CONDITIONS = {
  'channel-exists': {
    label: 'channel exists',
    params: [{ name: 'name', type: 'text' }],
    test: async (ctx, a) =>
      [...ctx.guild.channels.cache.values()].some((c) => c.isVoiceBased() && c.name === a.name),
  },

  'channel-empty': {
    label: 'channel is empty',
    params: [{ name: 'channel', type: 'channel' }],
    test: async (ctx, a) => {
      const channel = await ctx.channel(a.channel);
      return channel ? channel.members.size === 0 : false;
    },
  },

  'member-in-voice': {
    label: 'member is in voice',
    params: [{ name: 'user', type: 'user' }],
    test: async (ctx, a) => {
      const member = await ctx.member(a.user);
      return Boolean(member && member.voice.channelId);
    },
  },

  'user-has-role': {
    label: 'user has role',
    params: [{ name: 'user', type: 'user' }, { name: 'role', type: 'role' }],
    test: async (ctx, a) => {
      const member = await ctx.member(a.user);
      return Boolean(member && member.roles.cache.has(a.role));
    },
  },

  'member-count-at-least': {
    label: 'member count at least',
    params: [{ name: 'channel', type: 'channel' }, { name: 'n', type: 'number' }],
    test: async (ctx, a) => {
      const channel = await ctx.channel(a.channel);
      return channel ? channel.members.size >= Number(a.n) : false;
    },
  },
};

// Iterators feed `foreach`; each yields an array bound to {it} one at a time.
const ITERATORS = {
  'members-in': {
    label: 'each member in',
    params: [{ name: 'channel', type: 'channel' }],
    items: async (ctx, a) => {
      const channel = await ctx.channel(a.channel);
      return channel ? [...channel.members.values()] : [];
    },
  },

  'voice-channels': {
    label: 'each voice channel',
    params: [],
    items: async (ctx) =>
      [...ctx.guild.channels.cache.values()].filter((c) => c.isVoiceBased()),
  },
};

module.exports = { BLOCKS, CONDITIONS, ITERATORS, voiceMembers };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/blocks-conditions.test.js`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/blocks.js test/blocks-conditions.test.js
git commit -m "feat: condition and iterator registries for control flow"
```

---

### Task 6: Save-time validator

**Files:**
- Create: `src/validate.js`
- Test: `test/validate.test.js`

**Interfaces:**
- Consumes: `BLOCKS` (Task 4).
- Produces: `validate(blocks, {sounds}) -> { errors: string[], transactional: boolean }`. `errors` is empty when the stack is saveable. `transactional` is false when any block is `reversible: false`.
- Produces: `MAX_BLOCKS = 25`, `MAX_DEPTH = 3`.

- [ ] **Step 1: Write the failing test**

```js
// test/validate.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { validate, MAX_BLOCKS } = require('../src/validate');

const b = (op, depth, args = {}) => ({ op, args, depth });
const sounds = { airhorn: { file: 'airhorn.mp3' } };
const ok = (blocks) => validate(blocks, { sounds });

test('a valid stack has no errors and is transactional', () => {
  const result = ok([b('join', 0, { channel: '{caller}' }), b('play', 0, { sound: 'airhorn' })]);
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.transactional, true);
});

test('an unknown op is rejected', () => {
  const result = ok([b('explode', 0)]);
  assert.match(result.errors[0], /#1.*explode/i);
});

test('a missing parameter is rejected by name and block number', () => {
  const result = ok([b('move-user', 0, { user: 'u1' })]);
  assert.match(result.errors[0], /#1.*channel/i);
});

test('a sound not in the library is rejected', () => {
  const result = ok([b('play', 0, { sound: 'nope' })]);
  assert.match(result.errors[0], /#1.*nope/i);
});

test('indenting more than one level past the block above is rejected', () => {
  const result = ok([b('join', 0, { channel: 'c1' }), b('leave', 2)]);
  assert.match(result.errors[0], /#2.*indent/i);
});

test('the first block must be at depth 0', () => {
  const result = ok([b('leave', 1)]);
  assert.match(result.errors[0], /#1.*indent/i);
});

test('nesting deeper than MAX_DEPTH is rejected', () => {
  const result = ok([
    b('if', 0, { cond: 'channel-exists' }), b('if', 1, { cond: 'channel-exists' }),
    b('if', 2, { cond: 'channel-exists' }), b('if', 3, { cond: 'channel-exists' }),
    b('leave', 4),
  ]);
  assert.ok(result.errors.some((e) => /too deep|nesting/i.test(e)));
});

test('an else with no preceding if is rejected', () => {
  const result = ok([b('join', 0, { channel: 'c1' }), b('else', 0)]);
  assert.match(result.errors.join(' '), /#2.*else/i);
});

test('an else whose if has an empty body is rejected', () => {
  const result = ok([b('if', 0, { cond: 'channel-exists' }), b('else', 0)]);
  assert.match(result.errors.join(' '), /else|empty/i);
});

test('a valid if/else passes', () => {
  const result = ok([
    b('if', 0, { cond: 'channel-exists' }),
    b('leave', 1),
    b('else', 0),
    b('join', 1, { channel: 'c1' }),
  ]);
  assert.deepStrictEqual(result.errors, []);
});

test('more than MAX_BLOCKS blocks is rejected', () => {
  const blocks = Array.from({ length: MAX_BLOCKS + 1 }, () => b('leave', 0));
  assert.ok(ok(blocks).errors.some((e) => new RegExp(String(MAX_BLOCKS)).test(e)));
});

test('an irreversible block makes the stack non-transactional but still valid', () => {
  const result = ok([b('kick-voice', 0, { user: 'u1' })]);
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.transactional, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/validate.test.js`
Expected: FAIL — `Cannot find module '../src/validate'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/validate.js
const { BLOCKS } = require('./blocks');

const MAX_BLOCKS = 25; // bounded by Discord's 25-option cursor select
const MAX_DEPTH = 3;   // four levels, 0..3

// Returns every problem at once rather than the first, so the builder can show
// a complete list instead of making the author fix one error per save attempt.
function validate(blocks, { sounds = {} } = {}) {
  const errors = [];

  if (blocks.length === 0) errors.push('The command has no blocks.');
  if (blocks.length > MAX_BLOCKS) {
    errors.push(`Too many blocks: ${blocks.length}, the limit is ${MAX_BLOCKS}.`);
  }

  let prevDepth = -1;
  blocks.forEach((block, i) => {
    const n = i + 1;
    const def = BLOCKS[block.op];

    if (!def) {
      errors.push(`Block #${n}: unknown block "${block.op}".`);
      prevDepth = block.depth;
      return;
    }

    if (block.depth > MAX_DEPTH) {
      errors.push(`Block #${n}: nesting too deep (max ${MAX_DEPTH}).`);
    }
    if (block.depth > prevDepth + 1) {
      errors.push(`Block #${n}: indented more than one level past the block above it.`);
    }

    for (const param of def.params) {
      const value = block.args?.[param.name];
      if (value === undefined || value === null || value === '') {
        errors.push(`Block #${n}: missing "${param.name}".`);
        continue;
      }
      if (param.type === 'sound' && !sounds[value]) {
        errors.push(`Block #${n}: no uploaded sound named "${value}".`);
      }
    }

    if (block.op === 'else') {
      const owner = findOwningIf(blocks, i);
      if (!owner) {
        errors.push(`Block #${n}: "else" has no matching "if" at the same level.`);
      } else if (!hasBody(blocks, owner, block.depth)) {
        errors.push(`Block #${n}: the "if" above this "else" has an empty body.`);
      }
    }

    prevDepth = block.depth;
  });

  const transactional = blocks.every((b) => BLOCKS[b.op]?.reversible !== false);
  return { errors, transactional };
}

// The nearest preceding block at the same depth must be an `if`.
function findOwningIf(blocks, index) {
  for (let i = index - 1; i >= 0; i--) {
    if (blocks[i].depth < blocks[index].depth) return null;
    if (blocks[i].depth === blocks[index].depth) {
      return blocks[i].op === 'if' ? i : null;
    }
  }
  return null;
}

function hasBody(blocks, ifIndex, depth) {
  const next = blocks[ifIndex + 1];
  return Boolean(next && next.depth > depth);
}

module.exports = { validate, MAX_BLOCKS, MAX_DEPTH };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/validate.test.js`
Expected: PASS, 12 tests

- [ ] **Step 5: Commit**

```bash
git add src/validate.js test/validate.test.js
git commit -m "feat: save-time stack validation and transactional flag"
```

---

### Task 7: Interpreter execution with journal and rollback

This is the heart of the transaction guarantee and the task most likely to break silently. It gets the heaviest tests in the plan.

**Files:**
- Modify: `src/interpreter.js`
- Test: `test/interpreter-run.test.js`

**Interfaces:**
- Consumes: `buildTree`, `createBudget` (Tasks 2–3); `BLOCKS`, `CONDITIONS`, `ITERATORS` (Tasks 4–5).
- Produces: `run(blocks, ctx, {transactional}) -> { ok, failedAt, error, rolledBack, undoFailures, tally }`.
  - `ok` — true when every block completed.
  - `failedAt` — 1-based block index of the failure, or null.
  - `rolledBack` — count of undos invoked.
  - `undoFailures` — array of messages from undos that themselves failed.

- [ ] **Step 1: Write the failing test**

```js
// test/interpreter-run.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { run, createBudget } = require('../src/interpreter');

// A tiny block table injected into run(), so interpreter tests exercise
// control flow and rollback without depending on the real Discord blocks.
function harness() {
  const log = [];
  const registry = {
    BLOCKS: {
      'ok': {
        kind: 'action', params: [],
        run: async (ctx, a) => { log.push(`do:${a.tag}`); return () => log.push(`undo:${a.tag}`); },
      },
      'nostate': { kind: 'action', params: [], run: async () => { log.push('nostate'); } },
      'boom': { kind: 'action', params: [], run: async () => { throw new Error('kaboom'); } },
      'badundo': {
        kind: 'action', params: [],
        run: async () => { log.push('do:bad'); return () => { throw new Error('undo failed'); }; },
      },
      'if': { kind: 'block', params: [] },
      'else': { kind: 'clause', params: [] },
      'foreach': { kind: 'block', params: [] },
      'repeat': { kind: 'block', params: [] },
    },
    CONDITIONS: {
      'yes': { test: async () => true },
      'no': { test: async () => false },
    },
    ITERATORS: {
      'three': { items: async () => ['a', 'b', 'c'] },
    },
  };
  const ctx = { vars: {}, budget: createBudget(), tally: { moved: 0, failed: 0 }, log };
  return { log, registry, ctx };
}

const b = (op, depth, args = {}) => ({ op, args, depth });

test('a successful run reports ok and journals nothing back', async () => {
  const { log, registry, ctx } = harness();
  const result = await run([b('ok', 0, { tag: '1' }), b('ok', 0, { tag: '2' })], ctx, { registry });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(log, ['do:1', 'do:2']);
});

test('a failure rolls undos back in REVERSE order', async () => {
  const { log, registry, ctx } = harness();
  const result = await run(
    [b('ok', 0, { tag: '1' }), b('ok', 0, { tag: '2' }), b('boom', 0)],
    ctx, { registry },
  );
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.failedAt, 3);
  assert.strictEqual(result.rolledBack, 2);
  assert.deepStrictEqual(log, ['do:1', 'do:2', 'undo:2', 'undo:1']);
});

test('blocks that changed no state contribute no undo', async () => {
  const { log, registry, ctx } = harness();
  await run([b('nostate', 0), b('boom', 0)], ctx, { registry });
  assert.deepStrictEqual(log, ['nostate']);
});

test('a failing undo does not stop the remaining undos and is reported', async () => {
  const { log, registry, ctx } = harness();
  const result = await run(
    [b('ok', 0, { tag: '1' }), b('badundo', 0), b('boom', 0)],
    ctx, { registry },
  );
  assert.strictEqual(result.undoFailures.length, 1);
  assert.match(result.undoFailures[0], /undo failed/);
  assert.ok(log.includes('undo:1'), 'the earlier undo still ran');
});

test('a non-transactional run keeps no journal and rolls nothing back', async () => {
  const { log, registry, ctx } = harness();
  const result = await run(
    [b('ok', 0, { tag: '1' }), b('boom', 0)],
    ctx, { registry, transactional: false },
  );
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.rolledBack, 0);
  assert.deepStrictEqual(log, ['do:1']);
});

test('if runs its body when the condition holds', async () => {
  const { log, registry, ctx } = harness();
  await run([b('if', 0, { cond: 'yes' }), b('ok', 1, { tag: 'in' })], ctx, { registry });
  assert.deepStrictEqual(log, ['do:in']);
});

test('if skips its body and runs else when the condition is false', async () => {
  const { log, registry, ctx } = harness();
  await run([
    b('if', 0, { cond: 'no' }), b('ok', 1, { tag: 'then' }),
    b('else', 0), b('ok', 1, { tag: 'otherwise' }),
  ], ctx, { registry });
  assert.deepStrictEqual(log, ['do:otherwise']);
});

test('foreach binds {it} once per item', async () => {
  const { registry, ctx } = harness();
  const seen = [];
  registry.BLOCKS['peek'] = { kind: 'action', params: [], run: async (c) => { seen.push(c.vars.it); } };
  await run([b('foreach', 0, { iter: 'three' }), b('peek', 1)], ctx, { registry });
  assert.deepStrictEqual(seen, ['a', 'b', 'c']);
});

test('repeat runs its body count times', async () => {
  const { log, registry, ctx } = harness();
  await run([b('repeat', 0, { count: 3 }), b('ok', 1, { tag: 'x' })], ctx, { registry });
  assert.deepStrictEqual(log, ['do:x', 'do:x', 'do:x']);
});

test('a loop that exceeds the iteration budget aborts and rolls back', async () => {
  const { registry, ctx } = harness();
  ctx.budget = createBudget({ maxIterations: 2 });
  const result = await run([b('repeat', 0, { count: 50 }), b('ok', 1, { tag: 'x' })], ctx, { registry });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /budget/i);
  assert.strictEqual(result.rolledBack, 2);
});

test('undos inside a loop body roll back too', async () => {
  const { log, registry, ctx } = harness();
  await run([
    b('repeat', 0, { count: 2 }), b('ok', 1, { tag: 'loop' }),
    b('boom', 0),
  ], ctx, { registry });
  assert.deepStrictEqual(log, ['do:loop', 'do:loop', 'undo:loop', 'undo:loop']);
});

// The spec's rule: a failure inside a loop is a partial outcome, not a run
// failure. Its own recommended recipe is `foreach members-in` + `move-user`,
// so tolerance has to live in the loop, not only inside move-all.
test('a failing block inside foreach is tolerated and counted, not fatal', async () => {
  const { log, registry, ctx } = harness();
  const result = await run([
    b('foreach', 0, { iter: 'three' }), b('boom', 1),
  ], ctx, { registry });
  assert.strictEqual(result.ok, true, 'the run completes');
  assert.strictEqual(ctx.tally.failed, 3);
  assert.strictEqual(result.rolledBack, 0);
});

test('tolerated loop failures do not discard work from successful iterations', async () => {
  const { log, registry, ctx } = harness();
  let calls = 0;
  registry.BLOCKS['flaky'] = {
    kind: 'action', params: [],
    run: async () => {
      calls++;
      if (calls === 2) throw new Error('nope');
      log.push(`do:${calls}`);
      return () => log.push(`undo:${calls}`);
    },
  };
  const result = await run([b('foreach', 0, { iter: 'three' }), b('flaky', 1)], ctx, { registry });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(ctx.tally.failed, 1);
  assert.deepStrictEqual(log, ['do:1', 'do:3']);
});

test('a budget breach inside a loop is NOT tolerated and still rolls back', async () => {
  const { registry, ctx } = harness();
  ctx.budget = createBudget({ maxIterations: 2 });
  const result = await run([b('foreach', 0, { iter: 'three' }), b('ok', 1, { tag: 'x' })], ctx, { registry });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /budget/i);
  assert.strictEqual(result.rolledBack, 2);
});

test('a failure outside any loop is still fatal', async () => {
  const { registry, ctx } = harness();
  const result = await run([b('ok', 0, { tag: '1' }), b('boom', 0)], ctx, { registry });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.rolledBack, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/interpreter-run.test.js`
Expected: FAIL — `run is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `src/interpreter.js` and extend `module.exports`. The `registry`
option exists so tests can inject a tiny block table; production callers omit
it and get the real one.

```js
// Executing a node tree. Control flow lives here rather than in the registry,
// because only the interpreter has the tree.
async function run(blocks, ctx, options = {}) {
  const registry = options.registry || require('./blocks');
  const transactional = options.transactional !== false;

  const tree = buildTree(blocks);
  const journal = transactional ? [] : null;
  // Block numbers in errors must match what the builder showed the author,
  // so count executed blocks against the original flat list.
  const counter = { n: 0 };

  try {
    await execList(tree, ctx, registry, journal, counter);
    return {
      ok: true, failedAt: null, error: null,
      rolledBack: 0, undoFailures: [], tally: ctx.tally,
    };
  } catch (err) {
    const undoFailures = [];
    let rolledBack = 0;
    if (journal) {
      for (const undo of journal.reverse()) {
        try {
          await undo();
          rolledBack++;
        } catch (undoErr) {
          undoFailures.push(undoErr.message);
        }
      }
    }
    return {
      ok: false,
      failedAt: counter.n,
      error: err.message,
      rolledBack,
      undoFailures,
      tally: ctx.tally,
    };
  }
}

async function execList(nodes, ctx, registry, journal, counter) {
  for (const node of nodes) {
    counter.n++;
    ctx.budget.clock();

    if (node.op === 'if') {
      const condition = registry.CONDITIONS[node.args.cond];
      if (!condition) throw new Error(`unknown condition "${node.args.cond}"`);
      const branch = (await condition.test(ctx, node.args)) ? node.children : node.alt || [];
      await execList(branch, ctx, registry, journal, counter);
      continue;
    }

    if (node.op === 'foreach') {
      const iterator = registry.ITERATORS[node.args.iter];
      if (!iterator) throw new Error(`unknown iterator "${node.args.iter}"`);
      const saved = ctx.vars.it;
      for (const item of await iterator.items(ctx, node.args)) {
        ctx.budget.iteration();
        ctx.vars.it = item;
        await tolerate(() => execList(node.children, ctx, registry, journal, counter), ctx);
      }
      ctx.vars.it = saved;
      continue;
    }

    if (node.op === 'repeat') {
      const count = Math.min(50, Number(node.args.count) || 0);
      for (let i = 0; i < count; i++) {
        ctx.budget.iteration();
        await tolerate(() => execList(node.children, ctx, registry, journal, counter), ctx);
      }
      continue;
    }

    const def = registry.BLOCKS[node.op];
    if (!def || !def.run) throw new Error(`unknown block "${node.op}"`);
    const undo = await def.run(ctx, node.args);
    if (undo && journal) journal.push(undo);
  }
}

// One iteration failing is a partial outcome, not a run failure — the spec's
// own recipe for "move everyone in my channel" is a foreach around move-user,
// and one member the bot cannot move must not undo everyone else.
// A BudgetError is never tolerated: that is the runaway guard, not an outcome.
async function tolerate(body, ctx) {
  try {
    await body();
  } catch (err) {
    if (err instanceof BudgetError) throw err;
    ctx.tally.failed++;
  }
}

module.exports = { buildTree, createBudget, BudgetError, run };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/interpreter-run.test.js`
Expected: PASS, 11 tests

- [ ] **Step 5: Run the whole suite**

Run: `node --test`
Expected: PASS, all tests from Tasks 1–7

- [ ] **Step 6: Commit**

```bash
git add src/interpreter.js test/interpreter-run.test.js
git commit -m "feat: interpreter with control flow and compensating rollback"
```

---

### Task 8: Guild command registration

**Files:**
- Create: `src/register.js`
- Test: `test/register.test.js`

**Interfaces:**
- Consumes: `load` (Task 1).
- Produces: `BUILTIN_NAMES` (array of reserved names), `buildCommandList(guildId) -> object[]`, `syncGuild(rest, clientId, guildId) -> Promise`, `MAX_GUILD_COMMANDS = 100`.

- [ ] **Step 1: Write the failing test**

```js
// test/register.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/register.test.js`
Expected: FAIL — `Cannot find module '../src/register'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/register.js
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

function buildCommandList(guildId) {
  const { commands } = load(guildId);
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
async function syncGuild(rest, clientId, guildId) {
  const body = buildCommandList(guildId);
  if (body.length > MAX_GUILD_COMMANDS) {
    throw new Error(
      `This server would have ${body.length} commands; Discord's limit is ${MAX_GUILD_COMMANDS}. Delete one first.`,
    );
  }
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
  return body;
}

module.exports = { buildCommandList, syncGuild, BUILTIN_NAMES, BUILTINS, MAX_GUILD_COMMANDS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/register.test.js`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/register.js test/register.test.js
git commit -m "feat: guild command registration with ceiling check"
```

---

### Task 9: Stack rendering

**Files:**
- Create: `src/builder.js`
- Test: `test/builder-render.test.js`

**Interfaces:**
- Consumes: `BLOCKS`, `CONDITIONS`, `ITERATORS` (Tasks 4–5).
- Produces: `renderStack(blocks, {cursor}) -> string` — the code-fenced stack shown in the builder message. `describeBlock(block) -> string` — one block as a single line, no indentation.

- [ ] **Step 1: Write the failing test**

```js
// test/builder-render.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { renderStack, describeBlock } = require('../src/builder');

const b = (op, depth, args = {}) => ({ op, args, depth });

test('each block is numbered from 1', () => {
  const out = renderStack([b('leave', 0), b('leave', 0)]);
  assert.match(out, /1\./);
  assert.match(out, /2\./);
});

test('depth is rendered as indentation', () => {
  const out = renderStack([b('foreach', 0, { iter: 'voice-channels' }), b('leave', 1)]);
  const lines = out.split('\n').filter((l) => /^\s*\d+\./.test(l));
  const indent = (l) => l.match(/^\s*\d+\.(\s*)/)[1].length;
  assert.ok(indent(lines[1]) > indent(lines[0]), 'nested block is indented further');
});

test('the cursor marks the selected block', () => {
  const out = renderStack([b('leave', 0), b('leave', 0)], { cursor: 1 });
  const line = out.split('\n').find((l) => /2\./.test(l));
  assert.match(line, /[>›▸]/);
});

test('an empty stack says so instead of rendering nothing', () => {
  assert.match(renderStack([]), /empty|no blocks/i);
});

test('describeBlock shows the label and its argument values', () => {
  const line = describeBlock(b('move-user', 0, { user: '{it}', channel: 'Infinite Mighty' }));
  assert.match(line, /Move user/);
  assert.match(line, /\{it\}/);
  assert.match(line, /Infinite Mighty/);
});

test('describeBlock names the condition for an if', () => {
  assert.match(describeBlock(b('if', 0, { cond: 'channel-exists', name: 'Domain' })), /channel exists/);
});

test('describeBlock names the iterator for a foreach', () => {
  assert.match(describeBlock(b('foreach', 0, { iter: 'members-in', channel: 'c1' })), /each member in/);
});

test('rendering stays under Discord\'s 4096-character embed limit at max blocks', () => {
  const blocks = Array.from({ length: 25 }, () =>
    b('move-user', 3, { user: '{it}', channel: 'A channel with a fairly long name' }));
  assert.ok(renderStack(blocks).length < 4096);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/builder-render.test.js`
Expected: FAIL — `Cannot find module '../src/builder'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/builder.js
const { BLOCKS, CONDITIONS, ITERATORS } = require('./blocks');

// One block as a single line: label plus the argument values that identify it.
function describeBlock(block) {
  const def = BLOCKS[block.op];
  const label = def ? def.label : block.op;
  const args = block.args || {};

  if (block.op === 'if') {
    const cond = CONDITIONS[args.cond];
    return `if ${cond ? cond.label : args.cond}${detail(args, ['cond'])}`;
  }
  if (block.op === 'foreach') {
    const iter = ITERATORS[args.iter];
    return `for ${iter ? iter.label : args.iter}${detail(args, ['iter'])}`;
  }
  if (block.op === 'else') return 'else';

  return `${label}${detail(args, [])}`;
}

function detail(args, skip) {
  const values = Object.entries(args)
    .filter(([key]) => !skip.includes(key))
    .map(([, value]) => String(value));
  return values.length ? `: ${values.join(' → ')}` : '';
}

function renderStack(blocks, { cursor = null } = {}) {
  if (!blocks.length) return '```\n(empty — add a block to begin)\n```';
  const lines = blocks.map((block, i) => {
    const mark = i === cursor ? '›' : ' ';
    const number = String(i + 1).padStart(2, ' ');
    return `${mark}${number}. ${'  '.repeat(block.depth)}${describeBlock(block)}`;
  });
  return '```\n' + lines.join('\n') + '\n```';
}

module.exports = { renderStack, describeBlock };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/builder-render.test.js`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/builder.js test/builder-render.test.js
git commit -m "feat: render a block stack with indentation and cursor"
```

---

### Task 10: Stack editing operations

**Files:**
- Modify: `src/builder.js`
- Test: `test/builder-edit.test.js`

**Interfaces:**
- Consumes: `MAX_DEPTH`, `MAX_BLOCKS` (Task 6).
- Produces pure functions over a stack, each returning a **new** array plus the cursor's new position: `moveUp(blocks, i)`, `moveDown(blocks, i)`, `indent(blocks, i)`, `outdent(blocks, i)`, `removeAt(blocks, i)`, `insertAt(blocks, i, block)` — each `-> { blocks, cursor }`. Keeping these pure is what makes the builder's trickiest logic testable without Discord.

- [ ] **Step 1: Write the failing test**

```js
// test/builder-edit.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { moveUp, moveDown, indent, outdent, removeAt, insertAt } = require('../src/builder');

const b = (op, depth) => ({ op, args: {}, depth });
const shape = (r) => r.blocks.map((x) => `${x.op}@${x.depth}`);

test('moveUp swaps a block with the one above and follows the cursor', () => {
  const result = moveUp([b('a', 0), b('b', 0)], 1);
  assert.deepStrictEqual(shape(result), ['b@0', 'a@0']);
  assert.strictEqual(result.cursor, 0);
});

test('moveUp at the top is a no-op', () => {
  const result = moveUp([b('a', 0), b('b', 0)], 0);
  assert.deepStrictEqual(shape(result), ['a@0', 'b@0']);
  assert.strictEqual(result.cursor, 0);
});

test('moveDown at the bottom is a no-op', () => {
  const result = moveDown([b('a', 0), b('b', 0)], 1);
  assert.deepStrictEqual(shape(result), ['a@0', 'b@0']);
});

test('indent increases depth by one', () => {
  const result = indent([b('a', 0), b('b', 0)], 1);
  assert.deepStrictEqual(shape(result), ['a@0', 'b@1']);
});

test('indent cannot exceed one level past the block above', () => {
  const result = indent([b('a', 0), b('b', 1)], 1);
  assert.deepStrictEqual(shape(result), ['a@0', 'b@1'], 'refused');
});

test('the first block can never be indented', () => {
  assert.deepStrictEqual(shape(indent([b('a', 0)], 0)), ['a@0']);
});

test('indent refuses to pass MAX_DEPTH', () => {
  const blocks = [b('a', 0), b('b', 1), b('c', 2), b('d', 3), b('e', 3)];
  assert.deepStrictEqual(shape(indent(blocks, 4)), ['a@0', 'b@1', 'c@2', 'd@3', 'e@3']);
});

test('outdent decreases depth and stops at zero', () => {
  assert.deepStrictEqual(shape(outdent([b('a', 0), b('b', 1)], 1)), ['a@0', 'b@0']);
  assert.deepStrictEqual(shape(outdent([b('a', 0)], 0)), ['a@0']);
});

test('removeAt drops the block and clamps the cursor', () => {
  const result = removeAt([b('a', 0), b('b', 0)], 1);
  assert.deepStrictEqual(shape(result), ['a@0']);
  assert.strictEqual(result.cursor, 0);
});

test('removing the last remaining block leaves an empty stack with cursor 0', () => {
  const result = removeAt([b('a', 0)], 0);
  assert.deepStrictEqual(result.blocks, []);
  assert.strictEqual(result.cursor, 0);
});

test('insertAt places the block after the cursor and moves the cursor onto it', () => {
  const result = insertAt([b('a', 0), b('c', 0)], 0, b('b', 0));
  assert.deepStrictEqual(shape(result), ['a@0', 'b@0', 'c@0']);
  assert.strictEqual(result.cursor, 1);
});

test('inserting into an empty stack yields depth 0', () => {
  const result = insertAt([], 0, b('a', 2));
  assert.deepStrictEqual(shape(result), ['a@0']);
});

test('editing never mutates the input array', () => {
  const original = [b('a', 0), b('b', 0)];
  moveUp(original, 1);
  indent(original, 1);
  removeAt(original, 0);
  assert.deepStrictEqual(shape({ blocks: original }), ['a@0', 'b@0']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/builder-edit.test.js`
Expected: FAIL — `moveUp is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `src/builder.js` and extend `module.exports`:

```js
const { MAX_DEPTH } = require('./validate');

// All stack edits are pure: they copy, never mutate, and return the new
// cursor alongside. That keeps the builder's fiddliest logic testable with no
// Discord objects in sight.
const copy = (blocks) => blocks.map((b) => ({ ...b, args: { ...b.args } }));

function moveUp(blocks, i) {
  if (i <= 0) return { blocks, cursor: Math.max(0, i) };
  const next = copy(blocks);
  [next[i - 1], next[i]] = [next[i], next[i - 1]];
  return { blocks: next, cursor: i - 1 };
}

function moveDown(blocks, i) {
  if (i < 0 || i >= blocks.length - 1) return { blocks, cursor: i };
  const next = copy(blocks);
  [next[i + 1], next[i]] = [next[i], next[i + 1]];
  return { blocks: next, cursor: i + 1 };
}

// Indentation is the nesting model, so the one-level rule is enforced here
// rather than left for the validator to reject at save time.
function indent(blocks, i) {
  if (i <= 0 || i >= blocks.length) return { blocks, cursor: i };
  const target = blocks[i].depth + 1;
  if (target > MAX_DEPTH || target > blocks[i - 1].depth + 1) return { blocks, cursor: i };
  const next = copy(blocks);
  next[i].depth = target;
  return { blocks: next, cursor: i };
}

function outdent(blocks, i) {
  if (i < 0 || i >= blocks.length || blocks[i].depth === 0) return { blocks, cursor: i };
  const next = copy(blocks);
  next[i].depth -= 1;
  return { blocks: next, cursor: i };
}

function removeAt(blocks, i) {
  if (i < 0 || i >= blocks.length) return { blocks, cursor: i };
  const next = copy(blocks);
  next.splice(i, 1);
  return { blocks: next, cursor: Math.max(0, Math.min(i, next.length - 1)) };
}

function insertAt(blocks, i, block) {
  const next = copy(blocks);
  const at = next.length === 0 ? 0 : Math.min(i + 1, next.length);
  const depth = next.length === 0 ? 0 : Math.min(block.depth ?? 0, next[at - 1]?.depth ?? 0);
  next.splice(at, 0, { ...block, depth });
  return { blocks: next, cursor: at };
}

module.exports = {
  renderStack, describeBlock,
  moveUp, moveDown, indent, outdent, removeAt, insertAt,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/builder-edit.test.js`
Expected: PASS, 13 tests

- [ ] **Step 5: Commit**

```bash
git add src/builder.js test/builder-edit.test.js
git commit -m "feat: pure stack editing operations for the builder"
```

---

### Task 11: Builder components and interaction handlers

The glue layer. Logic worth testing already lives in Tasks 9–10; this task wires it to Discord and is verified by hand in a live server.

**Files:**
- Modify: `src/builder.js`
- Test: `test/builder-components.test.js`

**Interfaces:**
- Consumes: every pure function from Tasks 9–10, `validate` (Task 6), `syncGuild` (Task 8), `load`/`save` (Task 1).
- Produces: `buildComponents(state) -> ActionRowBuilder[]`, `sessions` (a `Map` of `userId:guildId` to `{name, blocks, cursor, pending, runRole, acknowledged}`), `handleBuildCommand(interaction)`, `handleComponent(interaction)`, `handleModal(interaction)`.
- Custom id scheme — every id is prefixed `bb:` so the router can dispatch on it: `bb:add`, `bb:cursor`, `bb:up`, `bb:down`, `bb:in`, `bb:out`, `bb:del`, `bb:save`, `bb:cancel`, `bb:param:<paramName>`, `bb:runrole`, `bb:runrole-role`, `bb:ack`.
- Save is a gauntlet re-entered by each gate's button: validate → acknowledge irreversibility (only when needed) → choose `runRole` → commit. State persists on the session between gates.

- [ ] **Step 1: Write the failing test**

```js
// test/builder-components.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildComponents } = require('../src/builder');

const b = (op, depth) => ({ op, args: {}, depth });
const ids = (rows) => rows.flatMap((r) => r.components.map((c) => c.data.custom_id));

test('the builder fits inside Discord\'s five-row limit', () => {
  const rows = buildComponents({ blocks: [b('leave', 0)], cursor: 0 });
  assert.ok(rows.length <= 5, `got ${rows.length} rows`);
});

test('no action row carries more than five components', () => {
  const rows = buildComponents({ blocks: [b('leave', 0)], cursor: 0 });
  for (const row of rows) assert.ok(row.components.length <= 5);
});

test('every expected control is present', () => {
  const found = ids(buildComponents({ blocks: [b('leave', 0)], cursor: 0 }));
  for (const id of ['bb:add', 'bb:cursor', 'bb:up', 'bb:down', 'bb:in', 'bb:out', 'bb:del', 'bb:save']) {
    assert.ok(found.includes(id), `missing ${id}`);
  }
});

test('the cursor select never exceeds 25 options', () => {
  const blocks = Array.from({ length: 25 }, () => b('leave', 0));
  const rows = buildComponents({ blocks, cursor: 0 });
  const cursor = rows.flatMap((r) => r.components).find((c) => c.data.custom_id === 'bb:cursor');
  assert.ok(cursor.options.length <= 25);
});

test('the add-block select never exceeds 25 options', () => {
  const rows = buildComponents({ blocks: [], cursor: 0 });
  const add = rows.flatMap((r) => r.components).find((c) => c.data.custom_id === 'bb:add');
  assert.ok(add.options.length <= 25);
});

test('edit buttons are disabled while the stack is empty', () => {
  const rows = buildComponents({ blocks: [], cursor: 0 });
  const del = rows.flatMap((r) => r.components).find((c) => c.data.custom_id === 'bb:del');
  assert.strictEqual(del.data.disabled, true);
});

test('every custom id is namespaced so the router can dispatch on it', () => {
  for (const id of ids(buildComponents({ blocks: [b('leave', 0)], cursor: 0 }))) {
    assert.match(id, /^bb:/);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/builder-components.test.js`
Expected: FAIL — `buildComponents is not a function`

- [ ] **Step 3: Write the components builder**

Append to `src/builder.js`:

```js
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelSelectMenuBuilder, UserSelectMenuBuilder, RoleSelectMenuBuilder,
  ChannelType, MessageFlags,
} = require('discord.js');

// Keyed by `${userId}:${guildId}` — one in-flight build per person per server.
// In-memory on purpose: an abandoned build should not outlive the process.
const sessions = new Map();
const sessionKey = (interaction) => `${interaction.user.id}:${interaction.guildId}`;

const ADD_OPTIONS = Object.entries(BLOCKS).map(([op, def]) => ({
  label: def.label,
  value: op,
  description: def.kind === 'action' ? undefined : 'control flow',
})).slice(0, 25);

function buildComponents(state) {
  const empty = state.blocks.length === 0;

  const add = new StringSelectMenuBuilder()
    .setCustomId('bb:add')
    .setPlaceholder('Add block…')
    .addOptions(ADD_OPTIONS);

  const cursor = new StringSelectMenuBuilder()
    .setCustomId('bb:cursor')
    .setPlaceholder(empty ? 'No blocks yet' : `Selected: #${state.cursor + 1}`)
    .setDisabled(empty)
    .addOptions(
      empty
        ? [{ label: 'none', value: '0' }]
        : state.blocks.slice(0, 25).map((block, i) => ({
            label: `#${i + 1} ${describeBlock(block)}`.slice(0, 100),
            value: String(i),
          })),
    );

  const button = (id, label, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(empty);

  return [
    new ActionRowBuilder().addComponents(add),
    new ActionRowBuilder().addComponents(cursor),
    new ActionRowBuilder().addComponents(
      button('bb:up', '↑'), button('bb:down', '↓'),
      button('bb:in', '⇥'), button('bb:out', '⇤'),
      button('bb:del', 'Delete', ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('bb:save').setLabel('Save').setStyle(ButtonStyle.Success).setDisabled(empty),
      new ButtonBuilder().setCustomId('bb:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    ),
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/builder-components.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Write the interaction handlers**

Append to `src/builder.js` and extend `module.exports` with
`{ buildComponents, sessions, handleBuildCommand, handleComponent, handleModal }`:

```js
const { validate } = require('./validate');
const { syncGuild } = require('./register');
const store = require('./store');
const { BUILTIN_NAMES } = require('./register');

const NAME_RE = /^[a-z0-9-]{1,32}$/;

async function render(interaction, state, extra = '') {
  const payload = {
    content: `**Building \`/${state.name}\`**\n${renderStack(state.blocks, { cursor: state.cursor })}${extra}`,
    components: buildComponents(state),
    flags: MessageFlags.Ephemeral,
  };
  return interaction.replied || interaction.deferred
    ? interaction.editReply(payload)
    : interaction.reply(payload);
}

async function handleBuildCommand(interaction) {
  const name = interaction.options.getString('name').toLowerCase().trim();
  if (!NAME_RE.test(name)) {
    return interaction.reply({
      content: 'Name must be 1-32 characters of a-z, 0-9 and dashes.',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (BUILTIN_NAMES.includes(name)) {
    return interaction.reply({
      content: `\`/${name}\` is a built-in command name.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // An existing name loads its stack: this is the edit path.
  const existing = store.load(interaction.guildId).commands[name];
  const state = {
    name,
    blocks: existing ? existing.blocks.map((b) => ({ ...b })) : [],
    cursor: 0,
    pending: null,
  };
  sessions.set(sessionKey(interaction), state);
  return render(interaction, state, existing ? '\n_Editing an existing command._' : '');
}

async function handleComponent(interaction) {
  const state = sessions.get(sessionKey(interaction));
  if (!state) {
    return interaction.reply({
      content: 'This builder session expired. Run `/build-command` again.',
      flags: MessageFlags.Ephemeral,
    });
  }
  const id = interaction.customId;

  if (id === 'bb:cancel') {
    sessions.delete(sessionKey(interaction));
    return interaction.update({ content: 'Cancelled.', components: [] });
  }

  if (id === 'bb:cursor') {
    state.cursor = Number(interaction.values[0]);
    return interaction.update(stackPayload(state));
  }

  if (id === 'bb:add') {
    const op = interaction.values[0];
    const def = BLOCKS[op];
    state.pending = { op, args: {}, remaining: [...def.params] };
    return promptNextParam(interaction, state);
  }

  if (id.startsWith('bb:param:')) {
    const param = id.slice('bb:param:'.length);
    state.pending.args[param] = selectedValue(interaction);
    state.pending.remaining = state.pending.remaining.filter((p) => p.name !== param);
    return promptNextParam(interaction, state);
  }

  const edits = {
    'bb:up': moveUp, 'bb:down': moveDown,
    'bb:in': indent, 'bb:out': outdent, 'bb:del': removeAt,
  };
  if (edits[id]) {
    const result = edits[id](state.blocks, state.cursor);
    state.blocks = result.blocks;
    state.cursor = result.cursor;
    return interaction.update(stackPayload(state));
  }

  if (id === 'bb:save') return save(interaction, state);
  if (id === 'bb:ack') {
    state.acknowledged = true;
    return save(interaction, state);
  }
  if (id === 'bb:runrole') {
    state.runRole = interaction.values[0]; // 'everyone' | 'manage-guild'
    return save(interaction, state);
  }
  if (id === 'bb:runrole-role') {
    state.runRole = interaction.values[0]; // a role id
    return save(interaction, state);
  }

  return interaction.update(stackPayload(state));
}

function stackPayload(state) {
  return {
    content: `**Building \`/${state.name}\`**\n${renderStack(state.blocks, { cursor: state.cursor })}`,
    components: buildComponents(state),
  };
}

function selectedValue(interaction) {
  return interaction.values ? interaction.values[0] : interaction.fields.getTextInputValue('value');
}

// Collects one parameter at a time, using Discord's native pickers where they
// exist so channel and user references are ids, never typed names.
async function promptNextParam(interaction, state) {
  const next = state.pending.remaining[0];
  if (!next) {
    const result = insertAt(state.blocks, state.cursor, {
      op: state.pending.op,
      args: state.pending.args,
      depth: state.blocks[state.cursor]?.depth ?? 0,
    });
    state.blocks = result.blocks;
    state.cursor = result.cursor;
    state.pending = null;
    return interaction.update(stackPayload(state));
  }

  const id = `bb:param:${next.name}`;
  if (next.type === 'number' || next.type === 'text') {
    const modal = new ModalBuilder().setCustomId(id).setTitle(`Set ${next.name}`)
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('value').setLabel(next.name)
          .setStyle(TextInputStyle.Short).setRequired(true),
      ));
    return interaction.showModal(modal);
  }

  let menu;
  if (next.type === 'channel') {
    menu = new ChannelSelectMenuBuilder().setCustomId(id)
      .addChannelTypes(ChannelType.GuildVoice).setPlaceholder(`Pick a channel for ${next.name}`);
  } else if (next.type === 'user') {
    menu = new UserSelectMenuBuilder().setCustomId(id).setPlaceholder(`Pick a user for ${next.name}`);
  } else if (next.type === 'role') {
    menu = new RoleSelectMenuBuilder().setCustomId(id).setPlaceholder(`Pick a role for ${next.name}`);
  } else {
    const options = next.type === 'sound'
      ? Object.keys(store.load(interaction.guildId).sounds).slice(0, 25).map((s) => ({ label: s, value: s }))
      : next.type === 'condition'
        ? Object.entries(CONDITIONS).map(([v, d]) => ({ label: d.label, value: v }))
        : next.type === 'iterator'
          ? Object.entries(ITERATORS).map(([v, d]) => ({ label: d.label, value: v }))
          : [{ label: 'yes', value: 'true' }, { label: 'no', value: 'false' }];
    if (options.length === 0) {
      return interaction.update({
        content: 'No sounds uploaded yet — use `/add-sound` first.',
        components: buildComponents(state),
      });
    }
    menu = new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(`Choose ${next.name}`).addOptions(options);
  }

  return interaction.update({
    content: `**Configuring \`${BLOCKS[state.pending.op].label}\`** — set \`${next.name}\``,
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}

async function handleModal(interaction) {
  const state = sessions.get(sessionKey(interaction));
  if (!state || !state.pending) return;
  const param = interaction.customId.slice('bb:param:'.length);
  state.pending.args[param] = interaction.fields.getTextInputValue('value');
  state.pending.remaining = state.pending.remaining.filter((p) => p.name !== param);
  return promptNextParam(interaction, state);
}

// Save is a short gauntlet, re-entered by each gate's button: validate →
// acknowledge irreversibility → choose who may run it → commit.
async function save(interaction, state) {
  const data = store.load(interaction.guildId);
  const { errors, transactional } = validate(state.blocks, { sounds: data.sounds });

  if (errors.length) {
    return interaction.update({
      content: `**Cannot save \`/${state.name}\`:**\n${errors.map((e) => `• ${e}`).join('\n')}`,
      components: buildComponents(state),
    });
  }

  // An irreversible block weakens the guarantee, so it is surfaced at save
  // time rather than discovered during a failed run.
  if (!transactional && !state.acknowledged) {
    const offenders = state.blocks
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => BLOCKS[b.op].reversible === false)
      .map(({ b, i }) => `  #${i + 1} ${describeBlock(b)}`);
    return interaction.update({
      content:
        `⚠️ **This command contains blocks that cannot be undone:**\n\`\`\`\n${offenders.join('\n')}\n\`\`\`\n` +
        `Saving marks \`/${state.name}\` **non-transactional** — a mid-run failure will leave partial effects in place.`,
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('bb:ack').setLabel('Save anyway').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('bb:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      )],
    });
  }

  // Who may run it. Two components because Discord has no single picker that
  // offers both named choices and an arbitrary role.
  if (!state.runRole) {
    return interaction.update({
      content: `**Who can run \`/${state.name}\`?**`,
      components: [
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId('bb:runrole').setPlaceholder('Everyone, or admins only')
            .addOptions(
              { label: 'Everyone', value: 'everyone' },
              { label: 'Manage Server only', value: 'manage-guild' },
            ),
        ),
        new ActionRowBuilder().addComponents(
          new RoleSelectMenuBuilder().setCustomId('bb:runrole-role').setPlaceholder('…or pick a specific role'),
        ),
      ],
    });
  }

  data.commands[state.name] = {
    description: `Custom command: ${state.name}`,
    runRole: state.runRole,
    transactional,
    blocks: state.blocks,
    createdBy: interaction.user.id,
    updatedAt: new Date().toISOString(),
  };

  // Register BEFORE writing: a rejection then leaves nothing to undo.
  try {
    await syncGuild(interaction.client.rest, interaction.client.user.id, interaction.guildId);
  } catch (err) {
    return interaction.update({ content: `Discord rejected the command: ${err.message}`, components: [] });
  }

  store.save(interaction.guildId, data);
  sessions.delete(sessionKey(interaction));
  const who = state.runRole === 'everyone' ? 'everyone'
    : state.runRole === 'manage-guild' ? 'Manage Server only'
    : `<@&${state.runRole}>`;
  return interaction.update({
    content: `Saved **/${state.name}** — runnable by ${who}${transactional ? '' : ', **non-transactional**'}.`,
    components: [],
  });
}
```

Note the registration ordering: `syncGuild` reads the store, so the in-memory
`data` object must carry the new command before the call — but `store.save`
runs only after Discord accepts. To make `syncGuild` see the pending command,
have it accept an optional override: add a second parameter
`syncGuild(rest, clientId, guildId, overrideData)` in `src/register.js` that
uses `overrideData` instead of calling `load(guildId)` when provided, and pass
`data` here.

- [ ] **Step 6: Apply the syncGuild override and re-run the suite**

```js
// src/register.js — replace buildCommandList and syncGuild signatures
function buildCommandList(guildId, overrideData) {
  const { commands } = overrideData || load(guildId);
  /* …unchanged… */
}

async function syncGuild(rest, clientId, guildId, overrideData) {
  const body = buildCommandList(guildId, overrideData);
  /* …unchanged… */
}
```

Run: `node --test`
Expected: PASS, all tests

- [ ] **Step 7: Commit**

```bash
git add src/builder.js src/register.js test/builder-components.test.js
git commit -m "feat: builder components, param collection and save flow"
```

---

### Task 12: Sound upload and management commands

**Files:**
- Create: `src/commands.js`
- Test: `test/commands.test.js`

**Interfaces:**
- Consumes: `store` (Task 1), `syncGuild` (Task 8).
- Produces: `handleAddSound(interaction)`, `handleListCommands(interaction)`, `handleDeleteCommand(interaction)`, `downloadAttachment(url, destination) -> Promise<void>`, `MAX_SOUND_BYTES`.

- [ ] **Step 1: Write the failing test**

```js
// test/commands.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function fresh() {
  process.env.BOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'botcmd-'));
  for (const m of ['../src/store', '../src/register', '../src/commands']) {
    delete require.cache[require.resolve(m)];
  }
  return { store: require('../src/store'), commands: require('../src/commands') };
}

function fakeInteraction({ guildId = 'g1', options = {} } = {}) {
  const replies = [];
  return {
    guildId,
    user: { id: 'u1' },
    client: { user: { id: 'app1' }, rest: { put: async () => {} } },
    options: {
      getString: (k) => options[k] ?? null,
      getAttachment: (k) => options[k] ?? null,
    },
    reply: async (payload) => { replies.push(payload); },
    editReply: async (payload) => { replies.push(payload); },
    deferReply: async () => {},
    replies,
  };
}

test('add-sound rejects a name that is not slug-safe', async () => {
  const { commands } = fresh();
  const interaction = fakeInteraction({ options: { name: 'Bad Name!', file: { size: 10, url: 'x', name: 'a.mp3' } } });
  await commands.handleAddSound(interaction);
  assert.match(JSON.stringify(interaction.replies), /a-z|name/i);
});

test('add-sound rejects a non-audio attachment', async () => {
  const { commands } = fresh();
  const interaction = fakeInteraction({
    options: { name: 'airhorn', file: { size: 10, url: 'x', name: 'virus.exe', contentType: 'application/x-msdownload' } },
  });
  await commands.handleAddSound(interaction);
  assert.match(JSON.stringify(interaction.replies), /audio|mp3|file type/i);
});

test('add-sound rejects a file over the size cap', async () => {
  const { commands } = fresh();
  const interaction = fakeInteraction({
    options: {
      name: 'airhorn',
      file: { size: commands.MAX_SOUND_BYTES + 1, url: 'x', name: 'a.mp3', contentType: 'audio/mpeg' },
    },
  });
  await commands.handleAddSound(interaction);
  assert.match(JSON.stringify(interaction.replies), /too large|size|MB/i);
});

test('list-commands reports an empty server clearly', async () => {
  const { commands } = fresh();
  const interaction = fakeInteraction();
  await commands.handleListCommands(interaction);
  assert.match(JSON.stringify(interaction.replies), /no custom commands|none/i);
});

test('list-commands lists stored commands', async () => {
  const { store, commands } = fresh();
  store.save('g1', { commands: { chaos: { blocks: [], transactional: true } }, sounds: {} });
  const interaction = fakeInteraction();
  await commands.handleListCommands(interaction);
  assert.match(JSON.stringify(interaction.replies), /chaos/);
});

test('delete-command removes the entry', async () => {
  const { store, commands } = fresh();
  store.save('g1', { commands: { chaos: { blocks: [] } }, sounds: {} });
  const interaction = fakeInteraction({ options: { name: 'chaos' } });
  await commands.handleDeleteCommand(interaction);
  assert.deepStrictEqual(Object.keys(store.load('g1').commands), []);
});

test('delete-command on an unknown name says so and changes nothing', async () => {
  const { store, commands } = fresh();
  store.save('g1', { commands: { chaos: { blocks: [] } }, sounds: {} });
  const interaction = fakeInteraction({ options: { name: 'ghost' } });
  await commands.handleDeleteCommand(interaction);
  assert.match(JSON.stringify(interaction.replies), /ghost|not found|no such/i);
  assert.deepStrictEqual(Object.keys(store.load('g1').commands), ['chaos']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/commands.test.js`
Expected: FAIL — `Cannot find module '../src/commands'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/commands.js
const fs = require('fs');
const path = require('path');
const { MessageFlags } = require('discord.js');
const store = require('./store');
const { syncGuild } = require('./register');

const MAX_SOUND_BYTES = 8 * 1024 * 1024; // 8 MB
const NAME_RE = /^[a-z0-9-]{1,32}$/;
const AUDIO_EXT = ['.mp3', '.ogg', '.wav', '.m4a', '.webm'];

const ephemeral = (interaction, content) =>
  interaction.reply({ content, flags: MessageFlags.Ephemeral });

// Attachments are URLs on Discord's CDN; fetch is global in Node 18+.
async function downloadAttachment(url, destination) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

async function handleAddSound(interaction) {
  const name = (interaction.options.getString('name') || '').toLowerCase().trim();
  const file = interaction.options.getAttachment('file');

  if (!NAME_RE.test(name)) {
    return ephemeral(interaction, 'Sound name must be 1-32 characters of a-z, 0-9 and dashes.');
  }

  const ext = path.extname(file.name || '').toLowerCase();
  const looksAudio = (file.contentType || '').startsWith('audio/') || AUDIO_EXT.includes(ext);
  if (!looksAudio) {
    return ephemeral(interaction, `That is not an audio file. Accepted: ${AUDIO_EXT.join(', ')}.`);
  }

  if (file.size > MAX_SOUND_BYTES) {
    return ephemeral(interaction, `File too large: the limit is ${MAX_SOUND_BYTES / 1024 / 1024} MB.`);
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const stored = `${name}${ext || '.mp3'}`;
  try {
    await downloadAttachment(file.url, store.soundPath(interaction.guildId, stored));
  } catch (err) {
    return interaction.editReply(`Could not save the file: ${err.message}`);
  }

  const data = store.load(interaction.guildId);
  data.sounds[name] = { file: stored, uploadedBy: interaction.user.id };
  store.save(interaction.guildId, data);
  return interaction.editReply(`Saved sound **${name}**. Use it in a Play Sound block.`);
}

async function handleListCommands(interaction) {
  const data = store.load(interaction.guildId);
  const names = Object.keys(data.commands);
  const sounds = Object.keys(data.sounds);

  if (names.length === 0 && sounds.length === 0) {
    return ephemeral(interaction, 'No custom commands or sounds in this server yet.');
  }

  const lines = names.length
    ? names.map((n) => {
        const cmd = data.commands[n];
        const flag = cmd.transactional === false ? ' _(non-transactional)_' : '';
        return `• \`/${n}\` — ${cmd.blocks.length} block(s)${flag}`;
      })
    : ['_none_'];

  return ephemeral(
    interaction,
    `**Commands**\n${lines.join('\n')}\n\n**Sounds**\n${sounds.length ? sounds.join(', ') : '_none_'}`,
  );
}

async function handleDeleteCommand(interaction) {
  const name = (interaction.options.getString('name') || '').toLowerCase().trim();
  const data = store.load(interaction.guildId);

  if (!data.commands[name]) {
    return ephemeral(interaction, `No command named \`/${name}\` in this server.`);
  }

  delete data.commands[name];
  try {
    await syncGuild(interaction.client.rest, interaction.client.user.id, interaction.guildId, data);
  } catch (err) {
    return ephemeral(interaction, `Discord rejected the change: ${err.message}`);
  }
  store.save(interaction.guildId, data);
  return ephemeral(interaction, `Deleted \`/${name}\`.`);
}

module.exports = {
  handleAddSound, handleListCommands, handleDeleteCommand,
  downloadAttachment, MAX_SOUND_BYTES,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/commands.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/commands.js test/commands.test.js
git commit -m "feat: add-sound upload plus list and delete commands"
```

---

### Task 13: Runtime context and the voice helper

**Files:**
- Create: `src/runtime.js`
- Test: `test/runtime.test.js`

**Interfaces:**
- Consumes: `store` (Task 1), `createBudget` (Task 3).
- Produces: `makeContext(interaction, {sounds}) -> ctx` matching the shape Task 4 defined, and `createVoice(guild, guildId, sounds)` providing `{ join(channel), leave(), play(soundName), joined }`.

- [ ] **Step 1: Write the failing test**

```js
// test/runtime.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveRef } = require('../src/runtime');
const { stubGuild } = require('./helpers/stub-guild');

test('{caller} resolves to the caller\'s voice channel for a channel ref', async () => {
  const { guild, members } = stubGuild({
    channels: [{ id: 'c1', name: 'General', type: 2 }],
    members: [{ id: 'u1', name: 'adnan', channelId: 'c1' }],
  });
  const ctx = { guild, caller: members.get('u1'), vars: {} };
  assert.strictEqual((await resolveRef(ctx, '{caller}', 'channel')).id, 'c1');
});

test('{it} resolves to the loop variable', async () => {
  const { guild } = stubGuild({ channels: [], members: [] });
  const ctx = { guild, caller: null, vars: { it: { id: 'loop-item' } } };
  assert.strictEqual((await resolveRef(ctx, '{it}', 'channel')).id, 'loop-item');
});

test('a channel ref resolves by id first', async () => {
  const { guild } = stubGuild({ channels: [{ id: 'c1', name: 'General', type: 2 }], members: [] });
  const ctx = { guild, caller: null, vars: {} };
  assert.strictEqual((await resolveRef(ctx, 'c1', 'channel')).name, 'General');
});

test('a channel ref falls back to a name lookup', async () => {
  // Required: create-vc makes a channel that has no id at save time, so a
  // later move-all must be able to reference it by name.
  const { guild } = stubGuild({ channels: [{ id: 'c1', name: 'Infinite Mighty', type: 2 }], members: [] });
  const ctx = { guild, caller: null, vars: {} };
  assert.strictEqual((await resolveRef(ctx, 'Infinite Mighty', 'channel')).id, 'c1');
});

test('an unresolvable ref yields null rather than throwing', async () => {
  const { guild } = stubGuild({ channels: [], members: [] });
  const ctx = { guild, caller: null, vars: {} };
  assert.strictEqual(await resolveRef(ctx, 'ghost', 'channel'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/runtime.test.js`
Expected: FAIL — `Cannot find module '../src/runtime'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/runtime.js
const fs = require('fs');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, NoSubscriberBehavior,
} = require('@discordjs/voice');
const store = require('./store');
const { createBudget } = require('./interpreter');

// Resolution order: variable, then id, then name. The name fallback exists
// because create-vc produces a channel with no id at save time.
async function resolveRef(ctx, ref, kind) {
  if (ref === '{caller}') {
    if (kind === 'channel') {
      const id = ctx.caller?.voice?.channelId;
      return id ? ctx.guild.channels.cache.get(id) || null : null;
    }
    return ctx.caller || null;
  }
  if (ref === '{it}') return ctx.vars.it ?? null;

  if (kind === 'channel') {
    return (
      ctx.guild.channels.cache.get(ref) ||
      [...ctx.guild.channels.cache.values()].find((c) => c.isVoiceBased() && c.name === ref) ||
      null
    );
  }
  return ctx.guild.members.cache.get(ref) || ctx.guild.members.fetch(ref).catch(() => null);
}

// One connection per run, created lazily and reused by every play block.
function createVoice(guild, guildId, sounds) {
  let connection = null;
  let joined = null;

  return {
    get joined() { return joined; },

    async join(channel) {
      connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
      });
      joined = channel;
    },

    async leave() {
      connection?.destroy();
      connection = null;
      joined = null;
    },

    async play(soundName) {
      if (!connection) throw new Error('play used before join');
      const entry = sounds[soundName];
      if (!entry) throw new Error(`no uploaded sound named "${soundName}"`);
      const file = store.soundPath(guildId, entry.file);
      if (!fs.existsSync(file)) throw new Error(`sound file for "${soundName}" is missing on disk`);

      const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
      connection.subscribe(player);
      player.play(createAudioResource(file));

      // Deliberately NOT gating on VoiceConnectionStatus.Ready — the handshake
      // completes on its own and the player buffers until it does. Gating here
      // is what produced the AbortError this bot shipped with.
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(done, 60_000);
        player.once(AudioPlayerStatus.Idle, done);
      });
    },

    destroy() { connection?.destroy(); },
  };
}

function makeContext(interaction, { sounds }) {
  const guild = interaction.guild;
  const ctx = {
    guild,
    botId: interaction.client.user.id,
    caller: interaction.member,
    vars: {},
    budget: createBudget(),
    tally: { moved: 0, failed: 0 },
    sounds,
    voice: createVoice(guild, interaction.guildId, sounds),
    channel: (ref) => resolveRef(ctx, ref, 'channel'),
    member: (ref) => resolveRef(ctx, ref, 'member'),
  };
  return ctx;
}

module.exports = { makeContext, createVoice, resolveRef };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/runtime.test.js`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/runtime.js test/runtime.test.js
git commit -m "feat: runtime context, reference resolution and voice helper"
```

---

### Task 14: Wire the router in index.js

**Files:**
- Modify: `index.js` (full rewrite of the interaction handling; keep the ffmpeg shim and client construction)

**Interfaces:**
- Consumes: everything from Tasks 1–13.
- Produces: a running bot. No new exports.

- [ ] **Step 1: Replace the interaction handling in `index.js`**

Keep the existing `require('dotenv').config()`, the ffmpeg shim, and the
`Client` construction with `[GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]`.
Replace everything from `client.once('clientReady'…)` to the end of the file with:

```js
const store = require('./src/store');
const builder = require('./src/builder');
const commands = require('./src/commands');
const { makeContext } = require('./src/runtime');
const { run } = require('./src/interpreter');
const { syncGuild, BUILTIN_NAMES } = require('./src/register');

const busyGuilds = new Set();

client.once('clientReady', async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  // Re-register each guild on boot so a store edited while offline takes effect.
  for (const guild of c.guilds.cache.values()) {
    await syncGuild(c.rest, c.user.id, guild.id).catch((err) =>
      console.error(`[register] ${guild.id}: ${err.message}`),
    );
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isModalSubmit()) return await builder.handleModal(interaction);
    if (interaction.isMessageComponent() && interaction.customId.startsWith('bb:')) {
      return await builder.handleComponent(interaction);
    }
    if (!interaction.isChatInputCommand()) return;

    switch (interaction.commandName) {
      case 'build-command':   return await builder.handleBuildCommand(interaction);
      case 'add-sound':       return await commands.handleAddSound(interaction);
      case 'list-commands':   return await commands.handleListCommands(interaction);
      case 'delete-command':  return await commands.handleDeleteCommand(interaction);
      default:                return await runCustomCommand(interaction);
    }
  } catch (err) {
    console.error('[interaction]', err);
    const message = `Something went wrong: ${err.message}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message).catch(() => {});
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

async function runCustomCommand(interaction) {
  if (BUILTIN_NAMES.includes(interaction.commandName)) return;

  const data = store.load(interaction.guildId);
  const command = data.commands[interaction.commandName];
  if (!command) return;

  if (!(await canRun(interaction, command))) {
    return interaction.reply({
      content: 'You do not have permission to run this command.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (busyGuilds.has(interaction.guildId)) {
    return interaction.reply({
      content: 'Another command is already running in this server.',
      flags: MessageFlags.Ephemeral,
    });
  }

  busyGuilds.add(interaction.guildId);
  // Any wait or sound blows the 3-second interaction window.
  await interaction.deferReply();

  const ctx = makeContext(interaction, { sounds: data.sounds });
  try {
    const result = await run(command.blocks, ctx, { transactional: command.transactional !== false });
    await interaction.editReply(summarise(interaction.commandName, command, result));
  } finally {
    ctx.voice.destroy();
    busyGuilds.delete(interaction.guildId);
  }
}

async function canRun(interaction, command) {
  const role = command.runRole || 'everyone';
  if (role === 'everyone') return true;
  if (role === 'manage-guild') return interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild);
  return interaction.member.roles.cache.has(role);
}

function summarise(name, command, result) {
  const moves = result.tally.moved || result.tally.failed
    ? ` Moved ${result.tally.moved}.${result.tally.failed ? ` ${result.tally.failed} could not be moved.` : ''}`
    : '';

  if (result.ok) return `**/${name}** finished.${moves}`;

  if (command.transactional === false) {
    return `**/${name}** failed at block #${result.failedAt}: ${result.error}\n` +
      `This command is non-transactional, so completed effects were left in place.`;
  }

  const undo = result.undoFailures.length
    ? `\n${result.undoFailures.length} could not be undone:\n${result.undoFailures.map((m) => `• ${m}`).join('\n')}`
    : '';
  return `**/${name}** failed at block #${result.failedAt}: ${result.error}\n` +
    `Rolled back ${result.rolledBack} block(s).${undo}`;
}

client.login(process.env.DISCORD_TOKEN);
```

Add `PermissionFlagsBits` and `MessageFlags` to the existing `discord.js`
destructure at the top of the file if they are not already there.

- [ ] **Step 2: Verify the file parses and the suite still passes**

Run: `node --check index.js && node --test`
Expected: no syntax error; all tests PASS

- [ ] **Step 3: Start the bot against a live server**

Run: `npm start`
Expected: `Logged in as …` with no `[register]` errors.

- [ ] **Step 4: Verify by hand in Discord**

1. `/add-sound name:airhorn file:<any small mp3>` → "Saved sound **airhorn**".
2. `/build-command name:test-cmd` → the stack UI appears, empty.
3. Add `Join channel` → pick your voice channel; add `Play sound` → `airhorn`.
4. Press Save → choose **Everyone** when asked who can run it.
5. `/test-cmd` autocompletes and runs; the sound plays.
6. Build a second command using `Disconnect user` → confirm the
   non-transactional warning appears and names that block before saving.
7. Re-run `/build-command name:test-cmd` → the existing stack loads for editing.
8. `/list-commands` shows both.
9. `/delete-command name:test-cmd`; confirm `/test-cmd` disappears from autocomplete.

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat: route interactions to builder, custom commands and admin commands"
```

---

### Task 15: Seed /domain-expansion and retire the hardcoded handler

**Files:**
- Create: `scripts/seed-domain-expansion.js`
- Modify: `index.js` (delete the old hardcoded handler if any remains)
- Modify: `deploy-commands.js` (delete — `src/register.js` owns registration now)
- Modify: `README.md` (create if absent)

Rebuilding the original command out of blocks is the proof the vocabulary is
complete. If it cannot be expressed, the block set is wrong.

- [ ] **Step 1: Write the seed script**

```js
// scripts/seed-domain-expansion.js
// Re-creates the original hardcoded command as a stored block command.
// Usage: node scripts/seed-domain-expansion.js <guildId>
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const store = require('../src/store');

const guildId = process.argv[2];
if (!guildId) {
  console.error('Usage: node scripts/seed-domain-expansion.js <guildId>');
  process.exit(1);
}

const data = store.load(guildId);

// Copy the existing asset into the guild's sound library.
const source = path.join(__dirname, '..', 'assets', 'domain-expansion.mp3');
if (!fs.existsSync(source)) {
  console.error(`Missing ${source}`);
  process.exit(1);
}
const destination = store.soundPath(guildId, 'domain-expansion.mp3');
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.copyFileSync(source, destination);
data.sounds['domain-expansion'] = { file: 'domain-expansion.mp3', uploadedBy: 'seed' };

data.commands['domain-expansion'] = {
  description: 'Pull everyone into the domain',
  runRole: 'everyone',
  transactional: true,
  blocks: [
    { op: 'create-vc', args: { name: 'Infinite Mighty', private: true }, depth: 0 },
    { op: 'join',      args: { channel: '{caller}' },                    depth: 0 },
    { op: 'play',      args: { sound: 'domain-expansion' },              depth: 0 },
    { op: 'move-all',  args: { channel: 'Infinite Mighty' },             depth: 0 },
  ],
  createdBy: 'seed',
  updatedAt: new Date().toISOString(),
};

store.save(guildId, data);
console.log(`Seeded /domain-expansion and its sound for guild ${guildId}.`);
console.log('Restart the bot to register it.');
```

- [ ] **Step 2: Verify the seeded stack passes validation**

```bash
node -e "
const store = require('./src/store');
const { validate } = require('./src/validate');
const guildId = process.argv[1];
const data = store.load(guildId);
const cmd = data.commands['domain-expansion'];
console.log(validate(cmd.blocks, { sounds: data.sounds }));
" <guildId>
```

Expected: `{ errors: [], transactional: true }`

- [ ] **Step 3: Run the seed and verify in Discord**

```bash
node scripts/seed-domain-expansion.js <guildId>
npm start
```

Then in Discord: `/domain-expansion` must behave exactly as before — the
private channel exists or is created, the sound plays, everyone is swept in.

- [ ] **Step 4: Delete the superseded code**

Remove `deploy-commands.js` and its `deploy` script from `package.json`
(`src/register.js` registers on boot now). Remove any remaining hardcoded
`domain-expansion` handler from `index.js`.

```bash
git rm deploy-commands.js
```

- [ ] **Step 5: Document it**

Create `README.md` covering: setup (`npm install`, `.env` keys), `npm start`,
the block vocabulary table from the spec, how to build a command, how to
upload a sound, the caps, and a plain statement that commands containing
`kick-voice` or `delete-vc` are non-transactional.

- [ ] **Step 6: Final verification**

Run: `node --test && node --check index.js`
Expected: all tests PASS, no syntax errors

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: seed /domain-expansion as a block command, retire hardcoded handler"
```

---

## Verification Summary

| Spec requirement | Task |
|---|---|
| Per-guild JSON store + media dir | 1 |
| Flat depth storage, tree at execution | 2 |
| Budget caps (200 iterations, 60s) | 3 |
| Registry drives everything; action blocks | 4 |
| Conditions and iterators | 5 |
| Save-time validation; 25 blocks, depth 3 | 6 |
| Control flow; journal; rollback; undo failures | 7 |
| Loop failures tolerated; budget breach never tolerated | 7 |
| Real guild slash commands; 100 ceiling | 8 |
| Scratch-style indented stack render | 9 |
| Indent/outdent/move/delete, one-level rule | 10 |
| Native selects per param type; transactional ack; `runRole` chooser | 11 |
| `/add-sound` upload, `/list-commands`, `/delete-command` | 12 |
| `{caller}`/`{it}`, name fallback, no Ready gate | 13 |
| Router, runRole enforcement, run lock, defer | 14 |
| `/domain-expansion` rebuilt from blocks | 15 |
