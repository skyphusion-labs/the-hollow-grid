// An AI player for The Hollow Grid.
//
// It connects like any other client (WebSocket to /ws, first line = name),
// reads the structured `@event` channel for exact game state (the same lines
// smoke.mjs asserts on), and asks a local ollama model for the next command.
// Deterministic survival reflexes (rest when hurt, ride out combat) run before
// the model, so it doesn't burn a round, or its life, on the obvious calls.
//
// Usage:
//   npm run dev                 # in one shell: the game on ws://localhost:8787/ws
//   node bot.mjs                # in another: the bot logs in and plays
//
// Config (all optional, via env):
//   MUD_URL           ws endpoint           (default ws://localhost:8787/ws)
//   MUD_NAME          character name        (default grid_<random>)
//   OLLAMA_BASE_URL   ollama OpenAI API     (default http://localhost:11434/v1)
//   OLLAMA_API_KEY    ignored by ollama     (default "ollama")
//   MUD_MODEL         model tag             (default qwen3:30b-a3b-instruct-2507-q4_K_M)
//   BOT_THINK_MS      min ms between moves  (default 4000)
//   BOT_QUIET_MS      settle window         (default 700)
//   BOT_LOG           tee output to a file  (optional)
//
// Requires Node 24+ (global WebSocket + fetch). No build step, no deps.

import { appendFileSync } from "node:fs";

const CFG = {
  url: process.env.MUD_URL ?? "ws://localhost:8787/ws",
  name: process.env.MUD_NAME ?? "grid_" + Math.random().toString(36).slice(2, 7),
  ollamaBase: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
  ollamaKey: process.env.OLLAMA_API_KEY ?? "ollama",
  model: process.env.MUD_MODEL ?? "qwen3:30b-a3b-instruct-2507-q4_K_M",
  thinkMs: Number(process.env.BOT_THINK_MS ?? 4000),
  quietMs: Number(process.env.BOT_QUIET_MS ?? 700),
  logFile: process.env.BOT_LOG ?? "",
  // Survival tuning (fractions of maxHp).
  restBelow: 0.35,
  restUntil: 0.85,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}`;
  console.log(line);
  if (CFG.logFile) {
    try {
      appendFileSync(CFG.logFile, line + "\n");
    } catch {
      /* best effort */
    }
  }
}

// ---------------------------------------------------------------------------
// Game state, rebuilt from the structured @event channel.
// ---------------------------------------------------------------------------

const state = {
  loggedIn: false,
  room: null, // { id, name, exits[], mobs[], items[], players[] }
  vitals: null, // { hp, maxHp, level, xp, gold, room, inCombat, poisoned, position }
  affects: null, // { morality, addiction, faction, resisted }
  equipment: null, // { weapon, head, body, hands, feet }
  prose: [], // recent human-readable lines (no @event), capped
  recentEvents: [], // recent event names, for context
  resting: false, // we issued rest and are waiting to heal up
  recentCommands: [], // last commands we sent, for anti-loop nudging
  lastRoomId: null, // room we were in before the most recent move
};

function ingest(chunk) {
  for (const line of String(chunk).split(/\r?\n/)) {
    const m = line.match(/^@event (\S+) (.*)$/);
    if (m) {
      let data;
      try {
        data = JSON.parse(m[2]);
      } catch {
        continue;
      }
      applyEvent(m[1], data);
      state.recentEvents.push(m[1]);
      if (state.recentEvents.length > 20) state.recentEvents.shift();
    } else {
      const t = line.trim();
      // Skip the bare prompt and blanks; keep real prose for context.
      if (t && t !== ">" && t !== "> ") {
        state.prose.push(t);
        if (state.prose.length > 40) state.prose.shift();
      }
    }
  }
}

function applyEvent(name, data) {
  switch (name) {
    case "room.info":
      if (state.room && data.id !== state.room.id) state.lastRoomId = state.room.id;
      state.room = data;
      break;
    case "char.vitals":
      state.vitals = data;
      break;
    case "char.affects":
      state.affects = data;
      break;
    case "char.equipment":
      state.equipment = data;
      break;
    case "char.died":
      // Respawn handling is server-side; just note it and let the loop resume.
      log("DIED ->", JSON.stringify(data));
      state.resting = false;
      break;
    default:
      break; // combat.*, world.*, grid.*, comm.* flow into recentEvents/prose
  }
}

// ---------------------------------------------------------------------------
// The brain: ask ollama for a single next command.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a player exploring The Hollow Grid, a post-apocalyptic text MUD.
You act by issuing ONE short game command per turn. Play naturally: explore new
rooms, fight beatable mobs, pick up loot, talk to NPCs, buy gear, take quests,
and react to other players. Survive: rest when hurt, do not pick fights you will lose.

Useful commands:
  movement: north south east west up down
  look / look <target>, exits, consider <mob>, inventory, affects, who, world
  attack <mob>, wield <item>, remove <item>, rest, recall
  get <item>, drop <item>, buy <item>, sell <item>, list, give <item> <player>
  talk, join / defend (pick a faction), title <epithet>
  say <text>, yell <text>, tell <player> <text>, emote <action>, ping

Reply with ONLY the command, nothing else. No quotes, no explanation.`;

function buildContext() {
  const r = state.room;
  const v = state.vitals;
  const a = state.affects;
  const lines = [];
  if (r) {
    lines.push(`Room: ${r.name} (${r.id})`);
    lines.push(`Exits: ${(r.exits ?? []).join(", ") || "none"}`);
    const mobs = (r.mobs ?? []).map((m) => m.name ?? m.id).join(", ");
    lines.push(`Mobs here: ${mobs || "none"}`);
    const items = (r.items ?? []).map((i) => i.name ?? i).join(", ");
    lines.push(`Items here: ${items || "none"}`);
    const others = (r.players ?? []).map((p) => p.name ?? p).filter((n) => n !== CFG.name).join(", ");
    lines.push(`Other players: ${others || "none"}`);
  }
  if (v) {
    lines.push(`HP: ${v.hp}/${v.maxHp}  Level ${v.level ?? "?"}  Gold ${v.gold ?? "?"}  Pos ${v.position ?? "?"}`);
    lines.push(`In combat: ${v.inCombat ? "yes" : "no"}  Poisoned: ${v.poisoned ? "yes" : "no"}`);
  }
  if (a) lines.push(`Faction: ${a.faction ?? "none"}  Addiction: ${a.addiction ?? 0}`);
  if (state.equipment?.weapon) lines.push(`Wielding: ${state.equipment.weapon}`);
  if (state.recentCommands.length) {
    lines.push(`You just tried: ${state.recentCommands.slice(-4).join(", ")}. Do something different; do not repeat yourself.`);
  }
  if (state.prose.length) {
    lines.push("Recent:");
    for (const p of state.prose.slice(-8)) lines.push("  " + p);
  }
  return lines.join("\n");
}

// True when the last few commands are the same thing over and over: the model
// is stuck (e.g. talking to an NPC that has nothing left to say).
function isLooping() {
  const rc = state.recentCommands;
  if (rc.length < 3) return false;
  const last3 = rc.slice(-3);
  return new Set(last3).size === 1;
}

// Break a loop by walking somewhere new: prefer an exit we did not just come from.
function escapeMove() {
  const exits = state.room?.exits ?? [];
  if (!exits.length) return "look";
  const back = { north: "south", south: "north", east: "west", west: "east", up: "down", down: "up" };
  const cameFrom = state.lastRoomId ? Object.values(back) : [];
  const fresh = exits.filter((e) => !cameFrom.includes(e));
  const pick = (fresh.length ? fresh : exits)[Math.floor(Math.random() * (fresh.length || exits.length))];
  return pick;
}

async function think() {
  const context = buildContext();
  const body = {
    model: CFG.model,
    max_tokens: 40,
    temperature: 0.8,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `${context}\n\nWhat is your next command?` },
    ],
  };
  const res = await fetch(`${CFG.ollamaBase}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${CFG.ollamaKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return sanitizeCommand(json.choices?.[0]?.message?.content ?? "");
}

// Models sometimes wrap the answer in prose/markdown; take the first real line.
function sanitizeCommand(raw) {
  let cmd = String(raw).split(/\r?\n/).find((l) => l.trim()) ?? "";
  cmd = cmd.replace(/^[`*">\-\s]+/, "").replace(/[`*"]+$/, "").trim();
  // Drop a leading "command:" / "action:" label if the model adds one.
  cmd = cmd.replace(/^(command|action|move)\s*[:\-]\s*/i, "").trim();
  return cmd.slice(0, 120);
}

// ---------------------------------------------------------------------------
// Reflexes: cheap, deterministic decisions that pre-empt the model.
// ---------------------------------------------------------------------------

function reflex() {
  const v = state.vitals;
  if (!v) return null;
  // Ride out combat; the server resolves a round per alarm tick on its own.
  if (v.inCombat) return "WAIT";
  // Heal up before doing anything risky.
  if (state.resting) {
    if (v.hp >= v.maxHp * CFG.restUntil) {
      state.resting = false; // healed enough, hand control back to the model
    } else {
      return "WAIT"; // keep resting
    }
  }
  if (v.hp < v.maxHp * CFG.restBelow) {
    state.resting = true;
    return "rest";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Connection + main loop, with reconnect.
// ---------------------------------------------------------------------------

let ws = null;
let lastMessageAt = 0;
let lastDecisionAt = 0;

function connect() {
  return new Promise((resolve, reject) => {
    log(`connecting to ${CFG.url} as ${CFG.name}`);
    ws = new WebSocket(CFG.url);
    ws.addEventListener("message", (e) => {
      lastMessageAt = Date.now();
      ingest(e.data);
    });
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", (e) => reject(new Error(`socket error: ${e?.message ?? e}`)));
    ws.addEventListener("close", () => {
      log("socket closed");
      state.loggedIn = false;
    });
  });
}

function send(cmd) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  log(">>>", cmd);
  ws.send(cmd);
}

async function decideAndAct() {
  const r = reflex();
  if (r === "WAIT") return;
  if (r) {
    send(r); // reflex (rest): deliberate, not counted toward loop detection
    return;
  }
  let cmd;
  if (isLooping()) {
    cmd = escapeMove();
    log("loop detected -> escape move");
  } else {
    try {
      cmd = await think();
    } catch (e) {
      log("brain error:", e.message, "-> fallback 'look'");
      cmd = "look";
    }
  }
  if (!cmd) return;
  send(cmd);
  state.recentCommands.push(cmd);
  if (state.recentCommands.length > 6) state.recentCommands.shift();
}

async function run() {
  for (;;) {
    try {
      await connect();
      await sleep(300);
      send(CFG.name); // first line logs us in
      state.loggedIn = true;
      await sleep(600);

      // Decision loop: act when the stream has settled and our cooldown is up.
      while (ws && ws.readyState === WebSocket.OPEN) {
        const now = Date.now();
        const settled = now - lastMessageAt > CFG.quietMs;
        const cooled = now - lastDecisionAt > CFG.thinkMs;
        if (state.loggedIn && settled && cooled) {
          lastDecisionAt = Date.now();
          await decideAndAct();
        }
        await sleep(250);
      }
    } catch (e) {
      log("run error:", e.message);
    }
    log("reconnecting in 5s...");
    await sleep(5000);
  }
}

process.on("SIGINT", () => {
  log("shutting down");
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
});

run();
