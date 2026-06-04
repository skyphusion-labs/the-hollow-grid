# The Chrome Wastes — a MUD on Cloudflare Workers

A small, multiplayer MUD that runs entirely on [Cloudflare Workers](https://developers.cloudflare.com/workers/)
and [Durable Objects](https://developers.cloudflare.com/durable-objects/) — no
VPS, no long-running process to babysit, and ~$0 when nobody's playing.

This is the **World DO skeleton**: connect, pick a name, walk between linked
rooms, and talk to other players in the same room. It's a clean base to grow a
real game on.

## Architecture

```
client (wscat / browser) --wss--> Worker (src/index.ts) --> World Durable Object (src/world.ts)
                                                              ├─ WebSocket Hibernation API
                                                              ├─ in-memory: none (state rides on sockets)
                                                              └─ SQLite: players(name, room)
```

- **One `World` Durable Object** holds the whole game. Every player routes to the
  same instance via `getByName("world")`, so they share one coordinated world.
- **WebSocket Hibernation API** (`ctx.acceptWebSocket`, `webSocketMessage`,
  `webSocketClose`). Per-connection state (name, room, vitals, combat target) is
  stored on the socket with `serializeAttachment`, so the DO can hibernate while
  players stay connected — you're not billed for idle duration.
- **Time-based mechanics are driven by a DO alarm.** When a player engages a mob
  (or gets poisoned), the DO schedules an `alarm()` that each tick respawns due
  mobs, drains HP from poisoned players, and resolves one combat round per active
  fight (player hits, mob hits back), handling death. The alarm reschedules only
  while there's combat, a pending respawn, or a poisoned player, then lets the DO
  hibernate. Mob state, player vitals, inventories, ground items, and each
  player's gold/morality/faction all live in SQLite, so a tick still works
  correctly even after the DO was evicted.
- **Room membership is derived**, not stored separately: who's in a room comes
  from scanning `ctx.getWebSockets()` and reading each socket's attachment. This
  survives hibernation for free.
- **SQLite** persists each player's room/HP/XP/level and every mob's state, so
  players resume where they left off and the world keeps its memory.
- **The world map lives in `src/rooms.ts`** as plain data. An exit exists only if
  it's declared, and movement to an undeclared direction returns a clear message
  — there are no silent no-op exits, so nobody gets trapped. (Yes, this is a
  pointed design choice.)

## Run it locally

```bash
npm install
npm run dev          # wrangler dev — serves on http://localhost:8787
```

Then connect with [`wscat`](https://github.com/websockets/wscat)
(`npm i -g wscat`):

```bash
wscat -c ws://localhost:8787/ws
```

You'll be asked for a name, then dropped into **The Cracked Nexus**. Open a
second `wscat` in another terminal, name it differently, and the two of you can
see each other move and `say` things in the same room.

### Commands

| Command | Does |
|---|---|
| `look` / `l` | describe your surroundings (mobs, items, and players present) |
| `north`/`south`/… (`n s e w ne nw se sw u d`), or `go <dir>` | move |
| `attack <mob>` / `kill` / `k` | engage a mob (combat resolves every few seconds) |
| `flee` / `f` | break off combat |
| `get`/`take <item>` | pick something up off the ground |
| `drop <item>` | drop an item |
| `inventory` / `inv` / `i` | list what you're carrying |
| `use`/`drink <item>` | use an item (antidote, rad-cell, …) |
| `examine <item>` | look closely at an item |
| `free` / `rescue` | free the captive (in the Holding Pit) |
| `sell <item>` | sell salvage to the market vendor (honest coin) |
| `steal` | lift gold from the market stall (risky, corrupting) |
| `buy <item>` | buy from a vendor (dust, at the Tankard) |
| `carouse` / `resist` | indulge or refuse the Tankard's vices |
| `join` / `defend` | side with the Cinder Front, or the elves (Scrap Market) |
| `talk` | speak to whoever shares your room |
| `hp` / `status` | show your HP, level, XP, gold, and standing |
| `say <msg>` / `'<msg>` | speak to everyone in the room |
| `who` | list survivors online |
| `help` / `?` | command list |
| `quit` | disconnect |

### Mobs, loot, and the world

Mobs roam fixed rooms, hit back, can kill you (you respawn at the Nexus), and
respawn on a timer. On death they roll **loot** onto the ground for you to `get`.
Living things to fight: a glow-rat (Service Tunnels), a feral scavenger (Scrap
Market), a malfunctioning drone (Rusted Rooftop), a rad-scorpion (the Sump), and
the warden (the Holding Pit).

### Poison & the maiden's quest

The rad-scorpion in the Sump **poisons** you on sting — once poisoned, you lose
HP every alarm tick (in or out of combat) until you're cured. The cure is an
**antidote**, and the only way to get one is the quest: a captive **maiden** is
held in the Holding Pit behind **the warden**. Defeat the warden, `free` the
maiden, and she rewards you with the antidote — `use antidote` to purge the
venom. (Dying also burns the venom out, the hard way.)

### Moral choices

Every character carries a hidden **morality** score and a pile of **gold**, both
revealed in `status` as your *standing* — from "a beacon of the wastes" to
"reviled." The wastes keep tempting you to trade one for the other:

- **Theft vs. honest work** (Scrap Market): `sell` your salvage for clean coin,
  or `steal` from the vendor — quick gold, but it corrupts you, and you might get
  caught empty-handed.
- **Drugs** (The Rusted Tankard): `buy dust` and `use` it for a free full heal
  that feels incredible — at the cost of your morality and a deepening addiction.
  Or never touch it.
- **The tavern wench** (The Rusted Tankard): `carouse` to spend coin and an hour
  in the back (fade to black) — and risk catching "the pox," an affliction that
  drains you like venom until cured. Or `resist` the temptation entirely.
- **The Cinder Front** (Scrap Market): a nativist movement is rallying to round up
  and expel the "unregistered elves." You can `join` them for blood money and a
  ruined conscience — or `defend` the refugees, take the moral high ground, and
  earn their gratitude. It's a one-time, sticky choice.

None of this gates the game — it's about who your character *is*. Standing is the
sum of what you chose to do when no one was making you.

## Deploy

```bash
npm run deploy       # wrangler deploy
```

Then `wscat -c wss://<your-worker>.workers.dev/ws`.

## Where to grow next

- More rooms (`src/rooms.ts`), mobs (`src/mobs.ts`), and items (`src/items.ts`) —
  all plain data the engine already supports.
- More quests, NPC dialogue trees, and item effects (buffs, equipment, currency).
- Skills/abilities, mob AI (wandering, aggro), and out-of-combat HP regen on the
  same alarm tick.
- Shard by zone (one DO per area) once a single World DO isn't enough.

## License

MIT © 2026 Conrad Rockenhaus
