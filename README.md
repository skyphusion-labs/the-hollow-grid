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
- **Combat is driven by a DO alarm.** When a player engages a mob, the DO
  schedules an `alarm()` that resolves one combat round per active fight every
  few seconds (player hits, mob hits back), handles death, and respawns slain
  mobs on a timer. The alarm reschedules only while there's combat or a pending
  respawn, then lets the DO hibernate. Mob state + player vitals live in SQLite,
  so a tick still works correctly even after the DO was evicted from memory.
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
| `look` / `l` | describe your surroundings (shows mobs and players present) |
| `north`/`south`/… (`n s e w ne nw se sw u d`), or `go <dir>` | move |
| `attack <mob>` / `kill` / `k` | engage a mob (combat resolves every few seconds) |
| `flee` / `f` | break off combat |
| `hp` / `status` | show your HP, level, and XP |
| `say <msg>` / `'<msg>` | speak to everyone in the room |
| `who` | list survivors online |
| `help` / `?` | command list |
| `quit` | disconnect |

There are mobs to fight in the Service Tunnels (a glow-rat), the Scrap Market (a
feral scavenger), and the Rusted Rooftop (a malfunctioning drone). They hit back,
they can kill you (you respawn at the Nexus), and they respawn on a timer.

## Deploy

```bash
npm run deploy       # wrangler deploy
```

Then `wscat -c wss://<your-worker>.workers.dev/ws`.

## Where to grow next

- More rooms / zones in `src/rooms.ts` and more mobs in `src/mobs.ts` (both are
  plain data — the engine already supports them).
- Items, inventory, and loot drops in additional SQLite tables.
- Skills/abilities, mob AI (wandering, aggro), and out-of-combat HP regen on the
  same alarm tick.
- Shard by zone (one DO per area) once a single World DO isn't enough.

## License

MIT © 2026 Conrad Rockenhaus
