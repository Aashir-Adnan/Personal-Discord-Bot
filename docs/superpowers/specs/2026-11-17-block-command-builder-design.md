# Block-Based Command Builder — Design

**Date:** 2026-11-17
**Status:** Approved for planning

## Problem

The bot has one hardcoded command, `/domain-expansion`. Every new behaviour
means editing `index.js` and redeploying. Server members who want a variation
("same thing but into a different channel", "play a different sound") cannot
get one without a developer.

## Goal

Let a server admin compose new slash commands inside Discord from a stack of
blocks — `Join channel`, `Play sound`, `Move user`, loops and conditionals —
and have the result register as a real, permanent, server-specific slash
command. Sounds are uploaded once into a per-guild library and referenced by
name.

## Non-goals

- **Video playback in voice.** Discord's API has no bot support for Go Live or
  camera streaming; `@discordjs/voice` is audio-only. Dropped from v1 along
  with the rest of the text/file block family.
- **Cross-server commands.** Every command, sound and store is scoped to one
  guild.
- **True ACID transactions.** The Discord API has no `BEGIN`/`ROLLBACK` and no
  snapshot. What this design provides instead is a compensating-transaction
  journal (see *Transactions* below), which is exact for every block except
  the two named irreversible ones.
- **A web UI.** Everything happens through Discord interactions.

## Architecture

```
index.js              client bootstrap + interaction router
src/blocks.js         registry: actions, conditions, iterators
src/interpreter.js    flat+depth -> tree, execute with budget caps
src/store.js          per-guild JSON + uploaded media paths
src/builder.js        /build-command UI: render, components, handlers
src/register.js       sync guild slash commands from the store
```

The design rests on one idea: **every block type is declared exactly once**, in
`src/blocks.js`. The builder UI, the save-time validator and the runtime all
read that table rather than each maintaining a parallel `switch`. Adding a
block type is one new entry.

A registry entry:

```js
'move-user': {
  label: 'Move user',
  kind: 'action',                       // action | block | clause
  params: [{ name: 'user',    type: 'user' },
           { name: 'channel', type: 'channel' }],
  reversible: true,
  run: async (ctx, a) => {
    const member = await ctx.user(a.user);
    const from = member.voice.channelId;              // captured before the change
    await member.voice.setChannel(ctx.channel(a.channel));
    return from && (() => member.voice.setChannel(from));   // the undo
  },
}
```

A block's `run` returns its own undo closure, or nothing if it changed no
state. Capturing the prior value inside `run` — rather than in a separate
`undo` function — keeps the before-state and the change in one place, so they
cannot drift apart.

`params[].type` drives how the builder collects the value:

| type | collected with |
|---|---|
| `channel`, `user`, `role` | Discord native select component |
| `sound` | string select, options from the guild's sound library |
| `number`, `text`, `boolean` | modal text input |

The variables `{caller}` (the invoking member, or their voice channel) and
`{it}` (the current `foreach` item) appear as extra options on `user` and
`channel` selects. `{it}` is offered only when the block being configured sits
inside a loop.

## Data model

One JSON file per guild at `data/<guildId>.json`; uploaded media beside it at
`data/media/<guildId>/`. Both are gitignored.

```json
{
  "commands": {
    "chaos": {
      "description": "Pull everyone into the domain",
      "runRole": "everyone",
      "transactional": true,
      "blocks": [
        { "op": "if",        "args": { "cond": "channel-exists", "channel": "Infinite Mighty" }, "depth": 0 },
        { "op": "foreach",   "args": { "iter": "members-in", "channel": "{caller}" },            "depth": 1 },
        { "op": "move-user", "args": { "user": "{it}", "channel": "Infinite Mighty" },           "depth": 2 },
        { "op": "else",      "args": {},                                                         "depth": 0 },
        { "op": "create-vc", "args": { "name": "Infinite Mighty", "private": true },             "depth": 1 }
      ],
      "createdBy": "123456789",
      "updatedAt": "2026-11-17T14:00:00.000Z"
    }
  },
  "sounds": {
    "airhorn": { "file": "airhorn.mp3", "uploadedBy": "123456789" }
  }
}
```

Blocks are stored **flat with a depth integer**, never as a tree. Nesting is
derived from depth the way Python derives it from indentation: a control
block's body is the contiguous run of blocks below it at greater depth. This
makes unbalanced-`end` bugs structurally impossible, and keeps reordering a
simple array splice.

`runRole` is one of `"everyone"`, `"manage-guild"`, or a role id string.
`transactional` is `true` unless the stack contains an irreversible block and
the author acknowledged the warning at save time.

## Block vocabulary

| Family | Blocks |
|---|---|
| Voice | `join`(channel) · `play`(sound) · `wait`(seconds) · `leave` |
| Members | `move-all`(channel) · `move-user`(user, channel) · `kick-voice`(user) |
| Channels | `create-vc`(name, private) · `delete-vc`(channel) |
| Control | `if`(condition) · `else` · `foreach`(iterator) · `repeat`(count) |

**Conditions** (for `if`): `channel-exists`(name), `channel-empty`(channel),
`member-in-voice`(user), `user-has-role`(user, role),
`member-count-at-least`(channel, n).

**Iterators** (for `foreach`): `members-in`(channel) yields members;
`voice-channels` yields every voice channel the bot can see.

`move-all`(channel) moves every member in **every voice channel the bot can
see** into the named channel, matching the behaviour `/domain-expansion` has
today. To move only the callers own channel, use
`foreach members-in {caller}` with `move-user`.

`repeat`(count) accepts 1-50, and like every loop is additionally bound by the
200-iteration run budget below.

`create-vc` with `private: true` reproduces the current Infinite Mighty
behaviour: `@everyone` denied `Connect` but allowed `ViewChannel`, the bot
granted `Connect`/`Speak`/`MoveMembers`. Members can be moved in but cannot
join or rejoin on their own.

`create-vc` is **get-or-create**: if a voice channel of that name already
exists it is returned untouched, exactly as `getOrCreateDomain` behaves today.
This keeps it safe to run every time a command fires, and means the common
case needs no `if channel-exists` guard wrapped around it.

## Builder flow

`/build-command name:<name>` — gated to Manage Server via
`setDefaultMemberPermissions`. The name must match `^[a-z0-9-]{1,32}$`
(Discord's own rule) and must not collide with a built-in command. **If the
name already exists, its stack is loaded for editing**; this is the update
path, and it shares every line of the creation UI.

The builder renders an ephemeral message carrying four component rows:

```
┌─ /chaos ─────────────────────────┐
│ 1. if channel exists: "Infinite" │
│ 2.   for each member in {caller} │
│ 3.     move user: {it} → Infinite│
│ 4. else                          │
│ 5.   create vc: "Infinite"       │
└──────────────────────────────────┘
[ Add block            v ]
[ Selected: #3         v ]
[ ↑ ] [ ↓ ] [ ⇥ ] [ ⇤ ] [ 🗑 ]
[ Save ] [ Cancel ]
```

Adding a parameterised block swaps the message to a configure view — one
component per parameter, plus Confirm — then returns to the stack view.

Saving validates the stack, prompts for `runRole`, then **registers with
Discord before writing the JSON**. Registration is the step that can fail for
reasons outside our control (name collision, the 100-command ceiling, rate
limits), so it goes first: if it is rejected, nothing has been written and
there is nothing to undo. The store is only updated once Discord has accepted
the new command list.

Supporting commands: `/add-sound name:<name> file:<attachment>` (Manage Server;
the only way a file can enter, since modals and component interactions cannot
carry attachments), `/list-commands`, `/delete-command name:<name>`.

## Execution semantics

The interaction router finds no built-in matching the command name, looks it up
in the guild store, checks `runRole` against the member, and **defers
immediately** — any command containing a `wait` or a sound exceeds Discord's
3-second interaction window.

The flat block list converts to a tree by depth, then executes as a recursive
walk over that tree, carrying a context and a budget.

- **One voice connection per run.** Created lazily on the first `join`, reused
  by every `play`, destroyed in a `finally`. Follows the pattern proven in
  `index.js`: do not gate on `VoiceConnectionStatus.Ready`; subscribe, play, and
  wait for the player to reach `Idle` with a timeout backstop.
- **Per-guild run lock.** Prevents two concurrent runs fighting over the single
  voice connection. A second invocation is refused with a message.
- **Failures inside `foreach` do not abort the loop and do not roll back.** One
  un-moveable member is a partial outcome, not a command failure; failures are
  counted and reported in the summary, as `/domain-expansion` does today.
- **Any other failure aborts the run and triggers rollback** — a vanished
  channel, a revoked permission, a budget breach, an API 5xx.

## Transactions

Every run carries a **journal**. As each block executes, the undo closure
returned by its `run` is pushed on. On abort, the interpreter walks the journal
in reverse and invokes each undo, then reports what was rolled back.

Reversibility by block:

| Block | Undo | Fidelity |
|---|---|---|
| `join` | leave voice | exact |
| `leave` | rejoin the recorded channel | exact |
| `move-user`, `move-all` | return each member to their recorded channel | exact, if still connected |
| `create-vc` | delete it — only when *this run* created it, never when get-or-create found an existing one | exact |
| `wait`, `play` | none; no state changed | n/a |
| `delete-vc` | — | **irreversible**: a recreated channel has a new id |
| `kick-voice` | — | **irreversible**: a user cannot be forced to reconnect |

### The transactional flag

Commands are transactional by default. The save-time validator scans for
blocks marked `reversible: false` — today exactly `delete-vc` and
`kick-voice` — and if any are present, saving requires an explicit
acknowledgement that stores `transactional: false` on the command:

```
⚠ This command contains blocks that cannot be undone:
    #4 kick voice: {it}
  Saving marks /chaos NON-TRANSACTIONAL. A mid-run failure
  will leave partial effects in place.
  [ Save anyway ]  [ Cancel ]
```

A non-transactional run keeps no journal and performs no rollback. Its reply
says so explicitly, so the weaker guarantee is visible at the moment it
matters rather than buried in the command's definition.

### When rollback itself fails

Undoing is ordinary API work and can fail on its own — a member disconnected
before they could be moved back, a channel was deleted by a human mid-run. An
undo failure never aborts the rollback: the remaining undos still run, and
every failure is collected and reported together.

```
Run failed at block #5 (channel "Infinite Mighty" not found).
Rolled back 4 blocks. 1 could not be undone:
  · adnan left voice before being returned to General
```

This is the one place the guarantee is genuinely best-effort, and the reply
always says which parts held.

### Safety caps

Runaway loops against the Discord API mean rate-limit bans, so the budget is
enforced, not advisory. `budget.tick()` throws `BudgetError` on breach:

| Cap | Value | Enforced |
|---|---|---|
| Blocks per command | 25 | save time |
| Nesting depth | max `depth` value 3, i.e. four levels (0-3) | save time (indent button refuses deeper) |
| Loop iterations per run | 200 | runtime |
| Wall clock per run | 60s | runtime |

The 25-block limit is set by Discord's 25-option ceiling on the "Selected"
cursor dropdown. Raising it would require paginating that select.

### Validation at save time

- Depth never jumps by more than one between consecutive blocks.
- `else` is preceded, at the same depth, by an `if` with at least one body block.
- Every declared parameter has a value.
- Every `sound` parameter names a file present in the guild library.
- Block count and max depth are within caps.

Validation failures report the offending block number and reason; nothing is
written.

## Error handling

| Failure | Handling |
|---|---|
| Invalid stack at save | Reject with block number + reason, write nothing |
| Missing sound file at runtime | Abort + rollback, name the sound |
| Missing permission on a block | Abort + rollback, name the permission and channel |
| Budget exceeded | Abort + rollback, report which cap |
| Deleted channel referenced | Abort + rollback, name the reference |
| Per-member move failure in a loop | Counted, reported, loop continues, **no rollback** |
| Undo fails during rollback | Remaining undos still run; all failures reported together |
| Failure in a non-transactional command | Abort, no rollback, reply states the command was non-transactional |
| Command registration rejected | Nothing was written yet; Discord's error surfaced |

## Testing

`node --test`, matching the convention in the sibling Granjur bot. Stubbed
guild objects; no Discord connection. The logic worth testing is all pure:

1. **Tree building** — depth to tree, including `else` binding to the correct
   `if`, and sibling blocks after a nested body.
2. **Budget caps** — iteration and wall-clock limits trip and throw.
3. **Condition evaluation** — each condition against stubbed guild state.
4. **Save validator** — rejects depth jumps, orphan `else`, missing params,
   unknown sounds, over-cap stacks; flags irreversible blocks.
5. **Rollback** — the heart of the transaction guarantee, and the part most
   likely to break silently:
   - undos replay in reverse order of execution;
   - a mid-run failure restores every member to their recorded channel;
   - `create-vc` undo deletes a channel the run created, and leaves an
     existing one it merely found;
   - a failing undo does not stop the remaining undos, and every failure is
     reported;
   - a tolerated per-member loop failure triggers no rollback at all;
   - a non-transactional command keeps no journal.

Rollback is tested with a stub guild whose API calls can be made to fail on
demand, so each failure path is exercised deliberately rather than hoped for.

The one-line discord.js calls inside each block's `run` are not mocked; their
value is in integration, not unit tests.

## Migration

`/domain-expansion` becomes a seeded entry in the store rather than hardcoded
logic:

```
1. create vc   : "Infinite Mighty", private    (get-or-create)
2. join        : {caller}
3. play        : domain-expansion
4. move all    : "Infinite Mighty"
```

Four blocks, no nesting, reproducing today's behaviour exactly. Rebuilding it
from the vocabulary is the proof that the vocabulary is complete — if this
cannot be expressed, the block set is wrong. The hardcoded handler is deleted
only once the seeded version is verified working against a live server.

## Open risks

- **100 commands per guild** is Discord's ceiling; the store must refuse saves
  past it with a clear message rather than failing at registration.
- **Re-registration on every save** is rate-limited by Discord. Acceptable at
  human editing speed; worth batching if it ever becomes a problem.
- **A command that deletes the channel it is running in** is possible to build.
  The run aborts with an API error, which is acceptable for v1.
- **Rollback is not instantaneous.** Members really are moved, then really
  moved back, and both are visible in the server while it happens. The end
  state is correct; the intermediate state is not hidden, because the Discord
  API cannot hide it.
