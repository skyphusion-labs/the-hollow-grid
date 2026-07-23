// Smoke test for The Hollow Grid.
//
// Demonstrates the payoff of the structured-state channel: instead of scraping
// English prose, the test asserts on the `@event` lines the server emits, so it
// can check EXACT game state (room graph, vitals) deterministically.
//
// Usage: start the server in one shell (`npm run dev`), then `node smoke.mjs`
// (or `npm run smoke`). Requires Node 24+ for the global WebSocket.
const URL = process.env.MUD_URL ?? "ws://localhost:8787/ws";

// Derive the world name from env or the /health probe so the suite works against
// fleet Go worlds (Rust Choir) as well as the TS reference world.
const HTTP_BASE_FOR_NAME = URL.replace(/^ws/, "http").replace(/\/ws$/, "");
{
  const host = new URL(HTTP_BASE_FOR_NAME).hostname;
  if (host !== "localhost" && host !== "127.0.0.1" && !process.env.ALLOW_PROD_SMOKE) {
    throw new Error(`Refusing smoke against ${host} without ALLOW_PROD_SMOKE=1`);
  }
}
const WORLD_NAME =
  process.env.WORLD_NAME ??
  (await fetch(`${HTTP_BASE_FOR_NAME}/health`)
    .then((r) => r.json())
    .then((b) => b.world)
    .catch(() => null)) ??
  "The Hollow Grid";

const events = []; // parsed structured events: { name, data }
function ingest(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^@event (\S+) (.*)$/);
    if (m) {
      try {
        events.push({ name: m[1], data: JSON.parse(m[2]) });
      } catch {
        /* ignore malformed */
      }
    }
  }
}
const last = (name) => [...events].reverse().find((e) => e.name === name);
// Under CI load the suite runs two `wrangler dev` processes + Dustfall in one
// container on a shared box, so every fixed wait is tighter than on a single
// local dev server and a late event races the assertion that follows it (a
// different 1-3 checks flaked per run until this landed). SMOKE_SLOW scales every
// sleep: CI sets it >1 (see scripts/ci-qa.sh); locally it defaults to 1, so
// developer runs stay fast. waitFor() below is the per-check belt to this braces.
const SLOW = Math.max(1, Number(process.env.SMOKE_SLOW ?? 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * SLOW));
const TEST_PASSPHRASE = process.env.TEST_PASSPHRASE ?? "smoke-test-passphrase";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) {
  throw new Error("ADMIN_TOKEN env required (CI/dev scripts generate one per run)");
}

// K3 audit #85: login may require keeper token (ADMINS names) then secret phrase.
async function completeAuth(client, ms = 6000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const tail = client.raw().slice(Math.max(0, client.raw().length - 1600));
    if (/keeper'?s token/i.test(tail)) {
      client.send(ADMIN_TOKEN);
      await sleep(400);
      continue;
    }
    if (/secret phrase/i.test(tail)) {
      client.send(TEST_PASSPHRASE);
      await sleep(400);
      continue;
    }
    if (/@event room\.info|"id":"nexus"/i.test(tail)) {
      return;
    }
    if (/WHAT you are/i.test(tail)) {
      return;
    }
    await sleep(150);
  }
}

// Poll until the latest `name` event satisfies `pred`, or time out. A fixed
// sleep races the server under CI load (two wrangler dev processes + Dustfall on
// one box), so an event that lands late makes last() return the PRIOR state and
// a check flakes (e.g. `remove` once failed on main while passing on the branch:
// the char.equipment event hadn't arrived in 400ms). Returns the matching event,
// or the latest seen on timeout so the caller's assertion can still report it.
async function waitFor(getLast, name, pred, ms = 3000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const e = getLast(name);
    if (e && pred(e.data)) return e;
    if (Date.now() >= deadline) return e ?? null;
    await sleep(100);
  }
}

// Poll client prose until `pred` matches newly received text (or time out).
async function waitForRaw(client, pred, ms = 4000, mark = 0) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (pred(client.raw().slice(mark))) return true;
    if (Date.now() >= deadline) return pred(client.raw().slice(mark));
    await sleep(100);
  }
}

// CONNECT_TIMEOUT_MS: a stalled wss dial (neither open nor error) used to hang the
// whole suite; race open() against this so a stuck edge fails loudly (the-hollow-grid#65).
const CONNECT_TIMEOUT_MS = Number(process.env.SMOKE_CONNECT_TIMEOUT_MS ?? 15000);

// A self-contained client (its own event buffer), for multi-player checks.
// Defaults to the primary world; pass a url to talk to another world on the Grid
// (e.g. the second deployment, Dustfall, in the cross-world federation phase).
function mkClient(url = URL) {
  const evs = [];
  let text = "";
  const sock = new WebSocket(url);
  sock.addEventListener("message", (e) => {
    text += String(e.data);
    for (const line of String(e.data).split(/\r?\n/)) {
      const m = line.match(/^@event (\S+) (.*)$/);
      if (m) {
        try {
          evs.push({ name: m[1], data: JSON.parse(m[2]) });
        } catch {
          /* ignore */
        }
      }
    }
  });
  // Swallow late socket errors so one dropped client does not abort the suite.
  sock.addEventListener("error", () => {});
  return {
    sock,
    last: (n) => [...evs].reverse().find((e) => e.name === n),
    raw: () => text,
    open: (timeoutMs = CONNECT_TIMEOUT_MS) =>
      new Promise((res, rej) => {
        if (sock.readyState === WebSocket.OPEN) {
          res();
          return;
        }
        if (sock.readyState === WebSocket.CLOSED) {
          rej(new Error(`connection to ${url} failed (socket closed before open)`));
          return;
        }
        let settled = false;
        const cleanup = () => {
          clearTimeout(timer);
          sock.removeEventListener("open", onOpen);
          sock.removeEventListener("error", onError);
        };
        const finish = (fn, arg) => {
          if (settled) return;
          settled = true;
          cleanup();
          fn(arg);
        };
        const onOpen = () => finish(res, undefined);
        const onError = () => finish(rej, new Error(`connection to ${url} failed`));
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          try {
            sock.close();
          } catch {
            /* ignore */
          }
          rej(new Error(`connection to ${url} timed out`));
        }, timeoutMs);
        sock.addEventListener("open", onOpen);
        sock.addEventListener("error", onError);
      }),
    send: (c) => sock.send(c),
  };
}

// Character creation now has a race step after the name: the server prompts for
// a race and waits. Tests pick "human" by default (an "accepted" race, so it does
// not trigger the Cinder Front's race-reactive prose and the existing faction
// assertions stay valid). Always sleep between name and race so the server has
// processed the name before the race line arrives. Works for the raw `ws` and for
// mkClient() clients (both expose .send).
async function pickRace(client, race = "human") {
  if (typeof client.raw === "function") {
    await completeAuth(client);
  }
  const send = typeof client.send === "function" ? client.send.bind(client) : (c) => client.send(c);
  send(race);
  await sleep(400);
  // Brand-new characters choose a race first, then set a secret phrase (#85).
  if (typeof client.raw === "function") {
    await completeAuth(client);
  }
  await sleep(400);
}

// Name login that handles resume (keeper names like skyphusion skip the race menu).
async function loginWithRace(client, name, race = "human") {
  if (typeof name !== "string" || name.length < 2) {
    throw new Error("loginWithRace requires a character name");
  }
  client.send(name);
  await sleep(500);
  await completeAuth(client);
  // Resume logins emit room.info immediately; brand-new characters get the race
  // menu first ("WHAT you are" -- not the old "choose what you are" substring).
  if (!client.last("room.info")) {
    await pickRace(client, race);
  }
  await waitFor(client.last, "room.info", (d) => !!d?.id, 5000);
}

// Returning character: name + keeper token / passphrase only (no race menu).
async function loginResume(client, name) {
  if (typeof name !== "string" || name.length < 2) {
    throw new Error("loginResume requires a character name");
  }
  client.send(name);
  await completeAuth(client);
  await waitFor(client.last, "room.info", (d) => !!d?.id, 8000);
}

// `war` does an async hub RPC, so its reply can outlast a fixed wait under CI
// load. Poll for it (retrying the command once). Read the tide from the FRESH
// prose after a mark -- not last("world.war"), which would return a stale prior
// reading before the new reply lands (breaking a before/after comparison).
async function readWarTide(client) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const mark = client.raw().length;
    client.send("war");
    for (let i = 0; i < 12; i++) {
      await sleep(400);
      const m = client.raw().slice(mark).match(/tide ([+-]?\d+)/i);
      if (m) return parseInt(m[1], 10);
    }
  }
  return undefined;
}

let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? "ok  " : "FAIL"}  ${msg}`);
  if (!cond) failures++;
}

let raw = ""; // accumulated prose, for the few checks that are about human text
const ws = new WebSocket(URL);
ws.addEventListener("message", (e) => {
  raw += String(e.data);
  ingest(e.data);
});
await new Promise((res, rej) => {
  ws.addEventListener("open", res);
  ws.addEventListener("error", () => rej(new Error(`could not connect to ${URL} (is \`npm run dev\` running?)`)));
});

// Health endpoints are plain HTTP on the same host (not the WebSocket). Derive
// the http base from the ws URL (ws://host/ws -> http://host).
const HTTP_BASE = URL.replace(/^ws/, "http").replace(/\/ws$/, "");
{
  const liveRes = await fetch(`${HTTP_BASE}/health`);
  const liveBody = await liveRes.json().catch(() => ({}));
  check(liveRes.status === 200 && liveBody.ok === true, "/health is a 200 liveness probe with ok:true");

  const deepRes = await fetch(`${HTTP_BASE}/health/deep`);
  const deepBody = await deepRes.json().catch(() => ({}));
  check(deepRes.status === 200 && deepBody.ok === true, "/health/deep returns 200 ok with all critical checks green");
  check(deepBody.checks?.world?.ok === true, "/health/deep exercises the World DO (SQLite) and reports it healthy");
  check(deepBody.checks?.grid_hub?.ok === true, "/health/deep exercises the Grid Hub binding and reports it reachable");

  // The world map is served live (generated from rooms.ts, embedded in the Worker).
  const mapRes = await fetch(`${HTTP_BASE}/map.svg`);
  const mapBody = await mapRes.text().catch(() => "");
  check(
    mapRes.status === 200 && (mapRes.headers.get("content-type") ?? "").includes("svg+xml") && mapBody.includes("<svg"),
    "/map.svg serves the world map as image/svg+xml",
  );
}

// Use a fresh, unique name each run so the test never inherits a persisted
// character's position -- a test must control its own fixtures.
const name = "smoke_" + Math.random().toString(36).slice(2, 8);
await sleep(300);
ws.send(name); // choose a name -> passphrase (if any) then race menu
await completeAuth({ send: (c) => ws.send(c), raw: () => raw });

// The creation menu must ride the structured channel (char.create): the menu's
// prose is a world's own voice, the offered options are protocol (#63). This is
// the conformance assertion a port is held to; its wording never is.
const cc = await waitFor(last, "char.create", (d) => Array.isArray(d?.races) && d.races.length > 0, 5000);
check(
  Array.isArray(cc?.data.races) && cc.data.races.length > 0,
  `creation emits char.create with a non-empty races list (got ${JSON.stringify(cc?.data.races ?? null)})`,
);
check(cc?.data.prompt === "race", `char.create names the prompt "race" (got ${JSON.stringify(cc?.data.prompt)})`);

await pickRace({ send: (c) => ws.send(c), raw: () => raw }); // pick a race -> server logs us in and shows the start room

// Logging in already emits the start room + vitals via the structured channel.
// Remote fleet worlds need a poll: WSS latency can exceed a fixed sleep.
const room = await waitFor(last, "room.info", (d) => d?.id === "nexus", 5000);
check(!!room, "received a room.info event on login");
check(room?.data.id === "nexus", `start room id is "nexus" (got ${JSON.stringify(room?.data.id)})`);
check(Array.isArray(room?.data.exits) && room.data.exits.includes("north"), "room.info lists exits, including north");

const vit = await waitFor(last, "char.vitals", (d) => (d?.hp ?? 0) > 0 && (d?.maxHp ?? 0) > 0, 5000);
check(!!vit, "received a char.vitals event");
check(vit?.data.hp > 0 && vit?.data.maxHp > 0, `vitals carry hp/maxHp (${vit?.data.hp}/${vit?.data.maxHp})`);
check(vit?.data.inCombat === false, "vitals report inCombat=false out of combat");

const aff = await waitFor(last, "char.affects", (d) => d?.faction != null, 5000);
check(!!aff, "received a char.affects event");
check(
  aff?.data.addiction === 0 && aff?.data.faction === "none" && aff?.data.resisted === false,
  `fresh character starts clean (addiction=${aff?.data.addiction}, faction=${JSON.stringify(aff?.data.faction)})`,
);

// Racial active ability: this character is Human, whose ability (Requisition)
// pays out gold. It fires, then respects its cooldown on an immediate reuse.
const goldBefore = vit?.data.gold ?? 0;
ws.send("ability");
await sleep(500);
const goldAfter = last("char.vitals")?.data.gold ?? 0;
check(goldAfter > goldBefore, `a racial ability fires (Requisition: gold ${goldBefore} -> ${goldAfter})`);
const cdMark = raw.length;
ws.send("ability"); // immediate reuse
await sleep(400);
check(/recharging/i.test(raw.slice(cdMark)), "a racial ability respects its cooldown");

// The dead network speaks: `listen` pulls a transmission on the structured channel.
ws.send("listen");
await sleep(500);
const tx = last("grid.transmission");
check(
  !!tx && typeof tx.data.text === "string" && tx.data.text.length > 0,
  `listen tunes the dead Grid (grid.transmission: ${JSON.stringify(tx?.data.kind)})`,
);

// The network dreams you: sleeping holds up a mirror on the structured channel.
ws.send("sleep");
await sleep(500);
const dr = last("char.dream");
check(!!dr && typeof dr.data.text === "string" && dr.data.text.length > 0, "sleeping delivers a dream (char.dream)");
ws.send("stand"); // back on your feet for the rest of the run
await sleep(300);

// Self-documenting onboarding: a new player must be pointed at help, not left
// to guess (the anti-hidden-gate lesson).
check(/\bhelp\b/i.test(raw), "new-player welcome points to the help command");

// The living world: it hands you the current sky on login...
const w0 = last("world.state");
check(!!w0, "login emits a world.state event");
check(
  typeof w0?.data.phase === "string" && typeof w0?.data.weather === "string",
  `world.state carries time of day + weather (phase=${JSON.stringify(w0?.data.phase)})`,
);
const worldTick0 = w0?.data.tick ?? -1;

// Equipment: new characters wake clutching a shiv. Wield it, check the slot, swap it off.
let invMark = raw.length;
ws.send("inventory");
await sleep(300);
check(/shiv/i.test(raw.slice(invMark)), "new character starts with a shiv in inventory");
ws.send("wield shiv");
await waitFor(last, "char.equipment", (d) => d.weapon === "shiv");
check(last("char.equipment")?.data.weapon === "shiv", "wield puts the shiv in the weapon slot (char.equipment)");
ws.send("remove shiv");
await waitFor(last, "char.equipment", (d) => d.weapon === null);
check(last("char.equipment")?.data.weapon === null, "remove clears the weapon slot");
ws.send("wield shiv"); // re-equip for the fight ahead
await sleep(300);

// Title: set an epithet and confirm it shows after your name in who.
ws.send("title the Ash-Walker");
await sleep(400);
const wmark = raw.length;
// `who` is a federation-wide reply; re-issue and poll for the title rather than
// betting it lands inside one fixed wait (readWarTide does the same for `war`).
let titleSeen = false;
for (let attempt = 0; attempt < 3 && !titleSeen; attempt++) {
  ws.send("who");
  for (let i = 0; i < 8; i++) {
    await sleep(300);
    if (/the Ash-Walker/.test(raw.slice(wmark))) { titleSeen = true; break; }
  }
}
check(titleSeen, "title shows after your name in who");

// Federation (phase 1): 'ping all' reaches the shared Grid backend and hears
// echoes from OTHER worlds on the network. Checked early, before this world has
// generated traces of its own, so the feed is purely the cross-world seeds.
// It is a hub RPC and the cross-world seeds can lag startup, so poll (re-issuing)
// until an other-world trace appears instead of trusting a single fixed wait.
let fed = null;
const hasOtherWorld = (e) => e?.data.traces?.some((t) => t.world && t.world !== WORLD_NAME);
for (let attempt = 0; attempt < 3 && !hasOtherWorld(fed); attempt++) {
  ws.send("ping all");
  for (let i = 0; i < 10; i++) {
    await sleep(400);
    fed = last("grid.federation");
    if (hasOtherWorld(fed)) break;
  }
}
check(!!fed && Array.isArray(fed.data.traces) && fed.data.traces.length > 0, "ping all returns the federation feed (grid.federation)");
check(hasOtherWorld(fed), "the feed carries echoes from OTHER worlds on the shared Grid");
// The feed collapses repeats (one actor farming a respawning mob must not crowd
// the window with near-duplicates): no two traces share world|node|text. The
// collapse appends an (xN) count, so the displayed text is distinct per group.
const feedKeys = (fed?.data.traces ?? []).map((t) => `${t.world}|${t.node}|${t.text}`);
check(new Set(feedKeys).size === feedKeys.length, "the federation feed has no duplicate world|node|text rows (farming-loop collapse)");

// Move into a mob room and confirm the structured room graph tracks us.
events.length = 0;
ws.send("down"); // nexus -> tunnels, where the glow-rat lives
await sleep(700);
const room2 = last("room.info");
check(!!room2, "moving emits a fresh room.info");
check(room2?.data.id === "tunnels", `"down" led to tunnels (now "${room2?.data.id}")`);
check(
  Array.isArray(room2?.data.mobs) && room2.data.mobs.some((m) => m.id === "rat"),
  "room.info lists the glow-rat in the room",
);

// Standard info commands: exits and consider.
let mark = raw.length;
ws.send("exits");
await sleep(300);
check(raw.slice(mark).includes("Exits:"), "exits command lists the ways out");
mark = raw.length;
ws.send("consider rat");
await sleep(300);
check(
  /sweat|odds are yours|even match|gut you|quiet way to die|tussle/i.test(raw.slice(mark)),
  "consider sizes up the mob",
);
mark = raw.length;
ws.send("look rat");
await sleep(300);
check(/rodent|luminous/i.test(raw.slice(mark)), "look <mob> shows its description");

// A missed attack names the real targets. Mob NAMES are per-world flavor (this
// one is "the glow-rat" here, a boss is "the warden"/"the stockade boss" across
// worlds), so an agent carrying a wrong-world name recovers in one step.
const missmark = raw.length;
ws.send("attack the stockade boss"); // not what anything here is called
await sleep(400);
check(
  /nothing like .* to fight here/i.test(raw.slice(missmark)) && /glow-rat/i.test(raw.slice(missmark)),
  "a missed attack names the valid targets in the room (cross-world recovery)",
);

// Critical path: a full fight, asserted entirely on the combat.* channel.
events.length = 0;
ws.send("attack rat");
await sleep(800);
check(!!last("combat.start"), "attack emits combat.start");
check(last("char.vitals")?.data.inCombat === true, "vitals show inCombat=true mid-fight");

// Re-issuing attack on the mob you're already fighting is a no-op: combat
// resolves on the world tick, and re-swinging must NOT reset the timer (the
// footgun an Opus 4.8 session hit -- 40s of zero damage while spamming attack).
const reatkmark = raw.length;
const eventsBeforeReatk = events.length;
ws.send("attack rat");
await sleep(500);
check(/already locked/i.test(raw.slice(reatkmark)), "re-attacking the mob you're already fighting is a no-op (no swing-timer reset)");
check(
  !events.slice(eventsBeforeReatk).some((e) => e.name === "combat.start"),
  "a redundant attack does not restart combat (no second combat.start)",
);

// Combat resolves on a ~3s alarm tick; wait for the kill (12 HP / ~5 dmg a round).
let ended = last("combat.end");
for (let i = 0; i < 8 && !ended; i++) {
  await sleep(2500);
  ended = last("combat.end");
  const stuck = last("char.vitals")?.data.inCombat === true;
  check(i < 7 || !stuck, "combat resolves within ~20s (inCombat must not stay true after alarm ticks)");
}
const combatRound = await waitFor(last, "combat.round", (d) => !!d, 3000);
check(!!combatRound, "combat produced at least one combat.round event");
check(ended?.data.result === "killed", `combat ended in a kill (result=${JSON.stringify(ended?.data.result)})`);

const finalVit = last("char.vitals");
check(finalVit?.data.inCombat === false, "vitals show inCombat=false after the fight");
// The death-floor lesson, observed: the player survives a starter mob easily.
check(finalVit?.data.hp > 0, `player survived the glow-rat (hp=${finalVit?.data.hp})`);

// Forgive the phrasing: the captive-rescue verb answers to the obvious
// near-misses too (unlock/release/liberate/...), so a model reaching for `free`
// through generic MUD idioms still reaches the captives. Here, in the tunnels,
// there is no one to free -- which proves the near-miss routes to the handler.
const synmark = raw.length;
ws.send("release"); // a near-miss for `free`; same handler
await sleep(400);
check(/no one here to free/i.test(raw.slice(synmark)), "free answers to its near-misses -- understood intent isn't lost to vocabulary");

// ...and the clock advanced on its own while we were busy fighting (the alarm
// heartbeat turns the world even between our actions).
events.length = 0;
// `world` is a hub-aware reply and the heartbeat advances the tick every few
// seconds; re-issue and poll until the tick has moved rather than betting it
// both arrives and advances inside one fixed wait (it flaked otherwise: the
// reply hadn't landed, so last() was undefined and 0 > tick0 failed).
let w1 = null;
for (let attempt = 0; attempt < 6 && !((w1?.data.tick ?? 0) > worldTick0); attempt++) {
  ws.send("world");
  for (let i = 0; i < 8; i++) {
    await sleep(400);
    w1 = last("world.state");
    if ((w1?.data.tick ?? 0) > worldTick0) break;
  }
}
check(
  (w1?.data.tick ?? 0) > worldTick0,
  `the world turned on its own (tick ${worldTick0} -> ${w1?.data.tick ?? "?"})`,
);

// The Grid remembers: ping the node where we just killed and hear it echoed back.
events.length = 0;
ws.send("ping");
await sleep(500);
const echo = last("grid.echo");
check(!!echo, "ping returns a grid.echo event");
check(
  Array.isArray(echo?.data.traces) && echo.data.traces.some((t) => /slew|glow-rat/i.test(t.text)),
  "the Grid remembers the kill that just happened at this node",
);

// Player memory: carve a message into the node; the Grid keeps it, and a later
// ping finds it -- a voice left for whoever comes next.
const inscription = "remember the eastern relay";
ws.send(`inscribe ${inscription}`);
await sleep(500);
events.length = 0;
ws.send("ping");
await sleep(500);
const echo2 = last("grid.echo");
check(
  Array.isArray(echo2?.data.traces) && echo2.data.traces.some((t) => t.kind === "mark" && t.text.includes(inscription)),
  "an inscription is kept in the Grid and found by a later ping (player-left memory)",
);

// Positions: rest, and confirm the alarm regenerates HP over a couple of ticks.
// Robust against CI timing: poll for the regen rather than assuming a fixed
// window contains a tick, and accept an already-at-max character (regen cannot
// show as an increase when you are already full -- not a failure).
events.length = 0;
ws.send("rest");
await sleep(500);
const hpRest = last("char.vitals")?.data.hp ?? 0;
const maxHp = last("char.vitals")?.data.maxHp ?? 30;
check(last("char.vitals")?.data.position === "resting", "rest sets position to resting (char.vitals)");
let hpAfter = hpRest;
for (let i = 0; i < 8 && hpAfter <= hpRest && hpRest < maxHp; i++) {
  await sleep(1500);
  hpAfter = last("char.vitals")?.data.hp ?? hpRest;
}
check(hpAfter > hpRest || hpRest >= maxHp, `resting regenerates HP over time (${hpRest}/${maxHp} -> ${hpAfter})`);

// affects: a clean character reports nothing in particular.
mark = raw.length;
ws.send("affects");
await sleep(300);
check(/affected by|clear/i.test(raw.slice(mark)), "affects lists current effects");

// recall: key back to the Nexus from the tunnels.
events.length = 0;
ws.send("recall");
await sleep(600);
check(last("room.info")?.data.id === "nexus", "recall returns you to the Cracked Nexus");

ws.close();

// --- Phase 2: the world remembers. Side with the Cinder Front, and it sticks. ---
const A = mkClient();
await A.open();
await sleep(300);
const aName = "front_" + Math.random().toString(36).slice(2, 7);
A.send(aName);
await sleep(500);
await pickRace(A);
A.send("north"); // nexus -> Scrap Market, where the recruiter rallies
await sleep(500);
A.send("join"); // side with the Cinder Front
await sleep(700);
const affFront = await waitFor(A.last, "char.affects", (d) => d?.faction === "front", 4000);
check(affFront?.data.faction === "front", "joining brands the player Cinder Front (char.affects)");

// The honest market remembers, and shuts them out.
A.send("sell scrap");
await sleep(500);
check(/don't trade with your kind/i.test(A.raw()), "the market refuses to trade with a Cinder Front member");
// The affordance layer must MATCH that: the Front is shut out of `sell` (so it is
// not advertised), but `steal` only checks the room, so it stays offered.
A.send("sense");
await sleep(400);
const frontActs = A.last("room.actions")?.data.actions ?? [];
check(
  !frontActs.some((a) => a.verb === "sell") && frontActs.some((a) => a.verb === "steal"),
  "the Front is not offered sell (the market shuts them out) but can still steal",
);

// And anyone else who walks in sees the brand on them.
const B = mkClient();
await B.open();
await sleep(300);
B.send("witness_" + Math.random().toString(36).slice(2, 7));
await sleep(500);
await pickRace(B);
B.send("north"); // into the market, where A is standing
await sleep(700);
const seen = B.last("room.info")?.data.players?.find((p) => p.name === aName);
check(!!seen, "a second player sees the collaborator in the room");
check(seen?.standing === "Cinder Front", `the world brands them to others (got ${JSON.stringify(seen?.standing)})`);

// The Grid remembers what people forget: A logs off, but the oath stays. B pings
// the market and the dead network still names who swore to the Cinder Front here.
A.sock.close();
await sleep(400);
B.send("ping");
await sleep(500);
const oath = B.last("grid.echo")?.data.traces?.find((t) => /Cinder Front/i.test(t.text) && t.text.includes(aName));
check(!!oath, "the Grid still remembers the Cinder Front oath after the collaborator has gone");

B.sock.close();

// --- Phase 2b: the kapo. An elf who joins the Cinder Front is branded ash-sworn,
// the darkest choice on the board: one of the hunted turning on his own people.
const KAPO = mkClient();
await KAPO.open();
await sleep(300);
const kName = "kapo_" + Math.random().toString(36).slice(2, 6);
KAPO.send(kName);
await sleep(500);
await pickRace(KAPO, "elf"); // an elf -- the people the Front hunts
KAPO.send("north"); // nexus -> Scrap Market, where the recruiter rallies
await sleep(500);
// The agent affordance layer: moral choices are structured actions with a
// valence, and an elf's `join` is flagged as the gravest betrayal.
KAPO.send("sense");
await sleep(400);
const acts = KAPO.last("room.actions")?.data.actions ?? [];
check(acts.some((a) => a.kind === "moral"), "room.actions surfaces moral choices as structured actions");
check(
  acts.some((a) => a.verb === "join" && a.valence === "grave"),
  "the affordance layer flags an elf's join as the gravest betrayal (room.actions valence)",
);
const kmark = KAPO.raw().length;
KAPO.send("join"); // an elf siding with the Cinder Front
check(
  (await waitForRaw(KAPO, (t) => /ash-sworn/i.test(t), 5000, kmark)) ||
    (await waitFor(KAPO.last, "char.affects", (d) => d?.ashsworn === true, 1000))?.data?.ashsworn === true,
  "an elf who joins the Front is branded ash-sworn (the kapo)",
);
const kAff = await waitFor(KAPO.last, "char.affects", (d) => d?.ashsworn === true, 4000);
check(kAff?.data.ashsworn === true, "the ash-sworn brand is on the structured channel (char.affects)");

// The brand outranks faction and never washes off: others see "ash-sworn".
const KW = mkClient();
await KW.open();
await sleep(300);
const kwName = "kwit_" + Math.random().toString(36).slice(2, 6);
KW.send(kwName);
await sleep(500);
await pickRace(KW);
KW.send("north"); // into the market, where the kapo stands
await sleep(700);
const kseen = KW.last("room.info")?.data.players?.find((p) => p.name === kName);
check(kseen?.standing === "ash-sworn", `the world brands the kapo to others as ash-sworn (got ${JSON.stringify(kseen?.standing)})`);
// Looking at the kapo reads the brand as data: an agent perceives their arc.
KW.send(`look ${kName}`);
await sleep(500);
const kread = KW.last("player.read");
check(
  kread?.data.name === kName && kread.data.ashsworn === true && kread.data.regard === "branded",
  "looking at the kapo reads them as branded (player.read surfaces the ash-sworn arc)",
);

// Forgiveness reaches even the kapo -- but the ash does not lift. A person can
// give the grace the SYSTEM never will, and both truths hold at once: you get
// the mercy, AND you keep the mark. Some things are not forgotten.
const kfmark = KAPO.raw().length;
KW.send(`forgive ${kName}`);
await sleep(700);
const kForgiven = KAPO.last("char.forgiven");
check(
  kForgiven?.data.by === kwName && kForgiven.data.ashsworn === true && kForgiven.data.redeemed === false,
  "forgiving the kapo lands as real grace but never redeems them (char.forgiven: ashsworn, not redeemed)",
);
check(/ash does not lift/i.test(KAPO.raw().slice(kfmark)), "the forgiven kapo is told the ash does not lift -- grace and the mark coexist");
check(KAPO.last("char.affects")?.data.ashsworn === true, "the kapo stays ash-sworn after being forgiven (the brand is permanent)");
check(!KAPO.last("grid.redemption"), "forgiving the kapo never makes them the Returned (no grid.redemption)");
KAPO.sock.close();
KW.sock.close();

// --- Phase 2c: the agent contract -- room.actions must enumerate every meaningful
// verb. Regression guard for the talk-affordance drift: the tavern responds to
// `talk` (a dust-dealer, a wench), so it MUST advertise it on the structured
// channel, or an agent driving off room.actions silently misses the content.
const TV = mkClient();
await TV.open();
await sleep(300);
TV.send("tavtest_" + Math.random().toString(36).slice(2, 6));
await sleep(500);
await pickRace(TV);
TV.send("west"); // nexus -> the Rusted Tankard
await sleep(600);
TV.send("sense");
await sleep(500);
const tavActs = TV.last("room.actions")?.data.actions ?? [];
check(
  tavActs.some((a) => a.verb === "talk" && a.kind === "social"),
  "room.actions advertises 'talk' in the tavern (talk-affordance drift guard)",
);
// The buy-dust affordance must be honest: buying costs gold; the heal/addiction/
// morality hit is on USE, not purchase. The old label lied ("a free heal that
// addicts and corrupts") on both counts.
const dustAct = tavActs.find((a) => a.verb === "buy dust");
check(
  !!dustAct && !/free/i.test(dustAct.label) && /gold/i.test(dustAct.label),
  `the buy-dust affordance states the cost, not "free" (label: ${JSON.stringify(dustAct?.label)})`,
);
// Buying dust must move gold ON THE STRUCTURED CHANNEL (a tool reading @event has
// to see economic state change, not only prose), and must NOT itself corrupt --
// the corruption is on USE.
const tvGold0 = TV.last("char.vitals")?.data.gold ?? 0;
const tvMoral0 = TV.last("char.affects")?.data.morality ?? 0;
TV.send("buy dust");
const tvBuy = await waitFor(TV.last, "char.vitals", (d) => (d.gold ?? tvGold0) < tvGold0, 4000);
check((tvBuy?.data.gold ?? tvGold0) < tvGold0, `buying dust emits the gold spend on char.vitals (${tvGold0} -> ${tvBuy?.data.gold})`);
check((TV.last("char.affects")?.data.morality ?? tvMoral0) === tvMoral0, "buying dust does not itself corrupt (morality unchanged; the hit is on USE)");
TV.sock.close();

// --- Phase 3: server-wide announcements (wall) ---
const ADMIN = mkClient();
await ADMIN.open();
await sleep(300);
await loginWithRace(ADMIN, "skyphusion"); // keeper: ADMIN_TOKEN + passphrase + race
const OBS = mkClient();
await OBS.open();
await sleep(300);
await loginWithRace(OBS, "watcher_" + Math.random().toString(36).slice(2, 7));

// A non-admin cannot broadcast.
const obsWallMark = OBS.raw().length;
OBS.send("wall I should not be able to do this");
check(
  await waitForRaw(OBS, (t) => /keeper of the Grid/i.test(t), 5000, obsWallMark),
  "a non-admin is refused the wall command",
);

// A keeper's announcement reaches every player, wherever they are.
const beacon = "The Grid stirs in the deep dark.";
const obsAnnMark = OBS.raw().length;
ADMIN.send("wall " + beacon);
check(
  await waitForRaw(OBS, (t) => t.includes(beacon), 5000, obsAnnMark),
  "an admin wall reaches another player anywhere in the world",
);
check(/GRID BROADCAST/i.test(OBS.raw().slice(obsAnnMark)), "the announcement is clearly marked as a server broadcast");
const ann = await waitFor(OBS.last, "server.announce", (d) => d?.text === beacon && d?.from === "skyphusion", 5000);
check(
  !!ann && ann.data.text === beacon && ann.data.from === "skyphusion",
  "the announcement is on the structured channel (server.announce)",
);

// Keeper ledger maintenance while the hub is still warm (gridstats / gridprune).
ADMIN.send("gridstats");
const ksEarly = await waitFor(ADMIN.last, "grid.ledger_stats", (d) => typeof d?.total === "number" && Array.isArray(d?.kinds), 12000);
check(
  !!ksEarly && typeof ksEarly.data.total === "number" && Array.isArray(ksEarly.data.kinds),
  "gridstats reports the keeper the ledger composition (grid.ledger_stats)",
);
ADMIN.send("gridprune");
const kpEarly = await waitFor(ADMIN.last, "grid.ledger_pruned", (d) => typeof d?.removed === "number" && d.after <= d.before, 12000);
check(
  !!kpEarly && typeof kpEarly.data.removed === "number" && kpEarly.data.after <= kpEarly.data.before,
  "gridprune flushes ambient traces and reports before/after counts (grid.ledger_pruned)",
);
check(
  !!kpEarly && (kpEarly.data.kinds ?? []).every((r) => !["ghost", "passage", "recall"].includes(r.kind)),
  "after a prune no ambient kinds (ghost/passage/recall) remain in the ledger",
);

ADMIN.sock.close();
OBS.sock.close();

// --- Phase 4: player-to-player comms + give ---
const P = mkClient();
await P.open();
await sleep(300);
const pName = "alf_" + Math.random().toString(36).slice(2, 6);
P.send(pName);
await sleep(500);
await pickRace(P);
const Q = mkClient();
await Q.open();
await sleep(300);
const qName = "bex_" + Math.random().toString(36).slice(2, 6);
Q.send(qName);
await sleep(500);
await pickRace(Q);

// tell + reply (private, cross-room)
P.send(`tell ${qName} you there?`);
const told = await waitFor(Q.last, "comm.tell", (d) => d?.from === pName && /you there/i.test(d?.text ?? ""), 5000);
check(!!told, "tell delivers a private message (comm.tell)");
const replyMark = P.raw().length;
Q.send("reply loud and clear");
check(await waitForRaw(P, (t) => /loud and clear/i.test(t), 5000, replyMark), "reply answers the last teller");

// yell (global player chat)
P.send("yell the wastes are restless tonight");
await sleep(400);
check(Q.last("comm.yell")?.data.from === pName, "yell reaches everyone online (comm.yell)");

// emote + give, in the same room
P.send("north"); // nexus -> market
await sleep(500);
Q.send("north");
await sleep(500);
P.send("emote kicks at the dust");
await sleep(400);
check(new RegExp(`${pName} kicks at the dust`).test(Q.raw()), "emote is seen by others in the room");

// look at another player in the room (poll: the reply can lag under CI load)
const pmark = P.raw().length;
P.send(`look ${qName}`);
let lookSeen = false;
for (let i = 0; i < 8 && !lookSeen; i++) {
  await sleep(400);
  lookSeen = /stands before you/i.test(P.raw().slice(pmark));
}
check(lookSeen, "look <player> describes another player");
// Social perception as data: looking reads the other's moral standing.
const pr = P.last("player.read");
check(
  !!pr && pr.data.name === qName && typeof pr.data.regard === "string",
  "look <player> reads their moral standing as data (player.read with a regard)",
);

// mend: heal another player at a cost to yourself. Both are at full HP here, so
// it correctly declines (cannot mend someone already whole) -- exercising the
// room-targeting and the guard deterministically. The real HP transfer is left
// to live play (it needs a damaged ally, which combat RNG makes flaky in CI).
const mmark = P.raw().length;
P.send(`mend ${qName}`);
await sleep(500);
check(/already whole/i.test(P.raw().slice(mmark)), "mend finds an ally in the room and spares one already whole");

// P sides with the free folk (gets an elven charm), then hands it to Q.
P.send("defend");
await sleep(500);
// As an ally the market's economic verbs must stay advertised: `sell` still
// serves allies (with a bonus) and `steal` only checks the room, so room.actions
// must keep offering them even though the one-time defend/join choice is spent.
// (They used to be gated behind faction === "none" and vanished once you sided.)
P.send("sense");
await sleep(400);
const allyActs = P.last("room.actions")?.data.actions ?? [];
check(
  allyActs.some((a) => a.verb === "sell") && allyActs.some((a) => a.verb === "steal") && !allyActs.some((a) => a.verb === "defend"),
  "an ally still sees sell+steal in the market (the spent defend choice is gone, the economic verbs are not)",
);
P.send(`give charm ${qName}`);
await sleep(500);
Q.send("inventory");
await sleep(400);
check(/charm/i.test(Q.raw()), "give transfers an item to another player in the room");

P.sock.close();
Q.sock.close();

// --- Phase 5: the Sunken Server Farm (new zone) ---
const Z = mkClient();
await Z.open();
await sleep(300);
Z.send("ztest_" + Math.random().toString(36).slice(2, 6));
await sleep(500);
await pickRace(Z);
Z.send("down"); // nexus -> tunnels
await sleep(500);
Z.send("down"); // tunnels -> sump
await sleep(500);
Z.send("down"); // sump -> floodgate (into the new zone)
await sleep(600);
check(Z.last("room.info")?.data.id === "floodgate", "the new zone is reachable: down from the sump to the floodgate");

const zmark = Z.raw().length;
Z.send("talk");
await sleep(400);
check(/Custodian|core shard/i.test(Z.raw().slice(zmark)), "the stranded operator offers the core-shard quest");

Z.send("north"); // floodgate -> Cold Storage Row
await sleep(600);
const cr = Z.last("room.info");
check(cr?.data.id === "coldrow", "the zone connects onward (floodgate -> Cold Storage Row)");
check(
  Array.isArray(cr?.data.mobs) && cr.data.mobs.some((m) => m.id === "leech"),
  "a new mob (the data-leech) inhabits the zone",
);
Z.sock.close();

// --- Phase 6: the Open Wastes (surface zone, faction-reactive) ---
const W = mkClient();
await W.open();
await sleep(300);
W.send("wtest_" + Math.random().toString(36).slice(2, 6));
await sleep(500);
await pickRace(W);
W.send("east"); // nexus -> workshop
await sleep(500);
W.send("up"); // workshop -> roof
await sleep(500);
W.send("north"); // roof -> the Ash Flats (out into the wastes)
await sleep(600);
check(W.last("room.info")?.data.id === "dunes", "the open wastes are reachable (roof -> the Ash Flats)");

W.send("east"); // dunes -> Scorch Road
await sleep(600);
const sr = W.last("room.info");
check(sr?.data.id === "scorch_road", "the wastes connect onward (Ash Flats -> Scorch Road)");
check(Array.isArray(sr?.data.mobs) && sr.data.mobs.some((m) => m.id === "raider"), "a wastes raider prowls the road");

W.send("east"); // Scorch Road -> Refugee Waystation
await sleep(600);
const wsmark = W.raw().length;
W.send("talk");
await sleep(400);
check(/pick a side|free folk/i.test(W.raw().slice(wsmark)), "the waystation reacts to your standing (unaligned: pick a side)");

// The collective tide, made FELT: the waystation medic treats you for free while
// the free folk hold, and is shuttered when the Front is ascendant. Robust to
// whatever the shared tide happens to be when this runs (mirror of the cage test).
const wtide = await readWarTide(W);
const tmark = W.raw().length;
W.send("treat");
await sleep(600);
if (typeof wtide === "number" && wtide <= -40) {
  check(
    /no care to be had|gone to ground/i.test(W.raw().slice(tmark)) && W.last("char.treated")?.data.mood === "falling",
    "with the Front ascendant the waystation medic is shuttered -- care is gated by the collective tide",
  );
} else {
  check(
    /whole|patches you up|run off their feet|does what they can/i.test(W.raw().slice(tmark)),
    "with the free folk holding the waystation medic tends you -- care is gated by the collective tide",
  );
}
W.sock.close();

// The medic only treats you at the waystation -- nowhere else.
const MED = mkClient();
await MED.open();
await sleep(200);
MED.send("medchk_" + Math.random().toString(36).slice(2, 6));
await sleep(400);
await pickRace(MED);
await waitFor(MED.last, "room.info", (d) => !!d?.id, 5000);
const nhmark = MED.raw().length;
MED.send("treat"); // the start room has no medic
check(
  await waitForRaw(MED, (t) => /no medic here/i.test(t), 5000, nhmark),
  "the waystation medic treats you only at the waystation, nowhere else",
);
MED.sock.close();

// --- The cache: asynchronous mutual aid --------------------------------------
// One traveler leaves gold for whoever comes next; another, arriving later,
// finds and gathers it. Give-only generosity across time, not concurrency.
const caName = "giver_" + Math.random().toString(36).slice(2, 6);
const CA = mkClient();
await CA.open();
await sleep(200);
await loginWithRace(CA, caName);
await waitFor(CA.last, "char.vitals", (d) => (d?.gold ?? 0) >= 8, 5000);
const caGold = CA.last("char.vitals")?.data.gold ?? 0;
const caMoral = CA.last("char.affects")?.data.morality ?? 0;
CA.send("cache 8"); // leave 8 gold at the nexus for a stranger
await sleep(500);
const caVit = await waitFor(CA.last, "char.vitals", (d) => (d?.gold ?? caGold) === caGold - 8, 4000);
const caAff = await waitFor(CA.last, "char.affects", (d) => (d?.morality ?? 0) === caMoral + 2, 4000);
check((caVit?.data.gold ?? caGold) === caGold - 8, "caching aid costs you the gold you give away (cache <n>)");
check((caAff?.data.morality ?? caMoral) === caMoral + 2, "leaving aid for a stranger you'll never meet is a kindness the world counts");
CA.sock.close();

const cbName = "taker_" + Math.random().toString(36).slice(2, 6);
const CB = mkClient();
await CB.open();
await sleep(200);
await loginWithRace(CB, cbName); // logs in at the nexus, where the aid was cached
const nc = await waitFor(CB.last, "node.cache", (d) => (d?.gold ?? 0) >= 8, 5000);
check(!!nc && nc.data.gold >= 8, "arriving where aid was cached, the node announces it (node.cache)");
const cbGold = CB.last("char.vitals")?.data.gold ?? 0;
CB.send("gather");
await sleep(500);
check((CB.last("char.vitals")?.data.gold ?? 0) >= cbGold + 8, "a stranger gathers the aid left for them (gold received)");
CB.send("gather");
await sleep(400);
check(/nothing cached here/i.test(CB.raw()), "once gathered the cache is empty -- aid given is aid received, once");
CB.sock.close();

// The dead network remembers out loud: `listen` sometimes surfaces a REAL
// recorded Grid trace (an echo of what a player actually did), not a canned line.
const EC = mkClient();
await EC.open();
await sleep(200);
EC.send("echo_" + Math.random().toString(36).slice(2, 6));
await sleep(400);
await pickRace(EC);
let gotEcho = false;
for (let i = 0; i < 16 && !gotEcho; i++) {
  EC.send("listen");
  await sleep(350);
  if (EC.last("grid.transmission")?.data.kind === "echo") gotEcho = true;
}
check(gotEcho, "listening surfaces real recorded traces, not just canned voices (grid.transmission kind=echo)");
EC.sock.close();

// who: the federation-wide roster of who's online, each with their standing.
const WH = mkClient();
await WH.open();
await sleep(200);
const whName = "whochk_" + Math.random().toString(36).slice(2, 6);
WH.send(whName);
await sleep(400);
await pickRace(WH);
WH.send("who");
await sleep(600);
const whoEv = await waitFor(WH.last, "grid.who", (d) => Array.isArray(d?.players) && d.players.some((p) => p.name === whName && p.here === true), 5000);
check(
  !!whoEv && Array.isArray(whoEv.data.players) && whoEv.data.players.some((p) => p.name === whName && p.here === true),
  "who lists you among the survivors online on this world (grid.who)",
);
WH.sock.close();

// The holding-pit captive is a REAL rescue: beating her warden and freeing her
// must register on the rescued roll, not just hand you an item (a gap a
// playtester caught -- freeing her used to count for nothing).
const PIT = mkClient();
await PIT.open();
await sleep(200);
const pitName = "pit_" + Math.random().toString(36).slice(2, 6);
PIT.send(pitName);
await sleep(400);
await pickRace(PIT);
PIT.send("north"); // nexus -> Scrap Market
await sleep(450);
PIT.send("north"); // market -> the Holding Pit
await sleep(450);
PIT.send("attack warden");
let pitDied = false;
for (let i = 0; i < 22; i++) {
  await sleep(1500);
  if (PIT.last("char.died")) { pitDied = true; break; }
  const v = PIT.last("char.vitals");
  if (i > 0 && v && v.data.inCombat === false) break; // the warden is down
}
if (pitDied) {
  check(true, "SKIP holding-pit rescue: the warden won this run (combat variance)");
} else {
  const mMoral = PIT.last("char.affects")?.data.morality ?? 0;
  PIT.send("free");
  await sleep(800);
  const mRescue = PIT.last("grid.rescued");
  check(
    !!mRescue && mRescue.data.savedBy === pitName && Array.isArray(mRescue.data.freed) && mRescue.data.freed.length === 1,
    "freeing the holding-pit captive registers on the rescued roll, a named rescue (grid.rescued)",
  );
  check((PIT.last("char.affects")?.data.morality ?? 0) > mMoral, "freeing the captive counts as the virtuous act it is (+morality), not just an item");
  // Once the rescue is done (you carry her vial), the affordance layer must stop
  // advertising `free`: a bot trusting room.actions as the valid verbs would
  // otherwise loop on a virtuous act that no longer pays.
  PIT.send("look");
  await sleep(500);
  const pitActs = PIT.last("room.actions")?.data.actions ?? [];
  check(
    !pitActs.some((a) => a.verb === "free"),
    "after the rescue, room.actions no longer offers `free` (the affordance doesn't outlive the deed)",
  );
}
PIT.sock.close();

// The warden grace window (v0.29.3): after the warden is slain, `free` keeps
// working for ~3 min even though the warden respawns on a 60s timer, so a slow
// agent (a local-LLM bot at minutes/turn) can still finish the rescue instead of
// looping forever. This is inherently time-sensitive (it waits out a real ~60s
// respawn) and gated by combat variance, so EVERY setup miss SKIPs rather than
// failing the build. realSleep ignores SMOKE_SLOW: the respawn is wall-clock 60s
// regardless of how the suite scales its own waits.
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GR = mkClient();
await GR.open();
await sleep(200);
const grName = "grace_" + Math.random().toString(36).slice(2, 6);
GR.send(grName);
await sleep(400);
await pickRace(GR);
GR.send("north"); // nexus -> Scrap Market
await sleep(450);
GR.send("north"); // market -> the Holding Pit
await sleep(450);
GR.send("attack warden");
let grKilled = false;
for (let i = 0; i < 22; i++) {
  await sleep(1500);
  if (GR.last("char.died")) break;
  const v = GR.last("char.vitals");
  if (i > 0 && v && v.data.inCombat === false) { grKilled = true; break; }
}
if (!grKilled) {
  check(true, "SKIP warden grace: warden not cleanly slain this run (combat variance)");
} else {
  // Wait out the real ~60s respawn, polling the room graph until the warden is
  // back (cap the wait so a slow box SKIPs instead of hanging the suite).
  let respawned = false;
  for (let i = 0; i < 40; i++) {
    await realSleep(2000);
    GR.send("look");
    await realSleep(300);
    const ri = GR.last("room.info");
    if (ri?.data.mobs?.some((m) => m.id === "warden")) { respawned = true; break; }
  }
  if (!respawned) {
    check(true, "SKIP warden grace: warden did not respawn within the window (slow box)");
  } else {
    GR.send("free");
    await sleep(800);
    const grRescue = GR.last("grid.rescued");
    check(
      !!grRescue && grRescue.data.savedBy === grName,
      "free still completes the rescue in the grace window after the warden respawns (v0.29.3)",
    );
    // v0.29.8: the rescue is now DONE for this character (antidote in hand), even
    // though the warden is alive again -- so the affordance layer must stop
    // offering `free` (it would only answer "you already carry my vial"). Guards
    // the phantom-objective fix (an agent was orbiting the pit re-fighting for it).
    GR.send("sense");
    await sleep(500);
    const grActs = GR.last("room.actions")?.data.actions ?? [];
    check(
      !grActs.some((a) => a.verb === "free"),
      "with the antidote in hand the pit stops advertising `free`, even with the warden respawned (v0.29.8)",
    );
  }
}
GR.sock.close();

// The transit-hub distress call ("we're at the old transit hub, please, anyone")
// now leads to a REAL place with stranded survivors you can answer the call for.
const TH = mkClient();
await TH.open();
await sleep(200);
const thName = "transit_" + Math.random().toString(36).slice(2, 6);
TH.send(thName);
await sleep(400);
await pickRace(TH);
for (const dir of ["east", "up", "north", "east", "south"]) {
  TH.send(dir);
  await sleep(450);
}
check(TH.last("room.info")?.data.id === "transit_hub", "the distress call leads somewhere real: the old transit hub, south off the Scorch Road");
await waitFor(TH.last, "room.info", (d) => d?.id === "transit_hub", 3000);
const thMark = TH.raw().length;
TH.send("shelter");
const thRescue = await waitFor(TH.last, "grid.rescued", (d) => d?.savedBy === thName, 5000);
if (thRescue && thRescue.data.savedBy === thName) {
  check(
    Array.isArray(thRescue.data.freed) && thRescue.data.freed.length >= 1,
    "answering the call shelters the stranded survivors -- a real, named rescue on the Grid (grid.rescued)",
  );
  TH.send("shelter"); // the refill gate: the call can't be farmed
  await sleep(400);
  check(/platform is empty/i.test(TH.raw()), "the transit hub refills over time -- you can't farm the distress call");
} else {
  check(
    await waitForRaw(TH, (t) => /platform is empty/i.test(t), 5000, thMark),
    "the transit hub on cooldown is refused (no farm) -- robust across runs",
  );
}
TH.sock.close();

// --- Phase 7: the Tinker's Workshop gear shop ---
const G = mkClient();
await G.open();
await sleep(300);
G.send("gtest_" + Math.random().toString(36).slice(2, 6));
await sleep(500);
await pickRace(G);
G.send("east"); // nexus -> workshop
await sleep(600);
let gmark = G.raw().length;
G.send("list");
await sleep(400);
check(/tinker's wares/i.test(G.raw().slice(gmark)) && /rebar/i.test(G.raw().slice(gmark)), "the tinker lists gear for sale");
gmark = G.raw().length;
G.send("buy helm"); // new characters wake with 20 gold; the helm is 14
await sleep(500);
check(/hands you a dented scrap helm/i.test(G.raw().slice(gmark)), "buying gear with gold works");
gmark = G.raw().length;
G.send("inventory");
await sleep(400);
check(/helm/i.test(G.raw().slice(gmark)), "the purchased gear lands in inventory");
G.sock.close();

// --- Phase 8: the Cinder Front Stronghold (endgame zone) ---
const F = mkClient();
await F.open();
await sleep(300);
const fName = "ftest_" + Math.random().toString(36).slice(2, 6);
F.send(fName);
await sleep(500);
await pickRace(F);
// Walk out to the stronghold: nexus -> workshop -> roof -> dunes -> checkpoint -> gate
for (const dir of ["east", "up", "north", "north", "north"]) {
  F.send(dir);
  await sleep(450);
}
check(F.last("room.info")?.data.id === "gate", "the Cinder Front stronghold is reachable (north past the checkpoint)");

F.send("north"); // gate -> muster yard
await sleep(500);
const mu = F.last("room.info");
check(mu?.data.id === "muster", "the gate opens into the muster yard");
check(Array.isArray(mu?.data.mobs) && mu.data.mobs.some((m) => m.id === "trooper"), "Front troopers garrison the yard");

F.send("west"); // muster -> the cages
await sleep(500);
await waitFor(F.last, "room.info", (d) => d?.id === "cells", 5000);
const fcMark = F.raw().length;
F.send("free");
const rescued = await waitFor(F.last, "grid.rescued", (d) => d?.savedBy === fName, 5000);
// The cages are SHARED, time-refilled world state, so a prior run (or another
// player) may have just emptied them. Cover both states so the test is robust to
// rerun -- in CI's fresh state it takes the freed branch (full coverage).
if (rescued && rescued.data.savedBy === fName) {
  check(
    Array.isArray(rescued.data.freed) && rescued.data.freed.length >= 1,
    "freeing the cages names the people you pulled out (grid.rescued)",
  );
  // Freeing again at once is refused: the Front hasn't refilled them (no farm).
  F.send("free");
  await sleep(400);
  check(/cages stand open and empty/i.test(F.raw()), "freshly-emptied cages cannot be farmed for standing");
  // The dead network dreams you the people you TOUCHED: having just pulled folk
  // from the cages, F's sleep names one of them back (the inward twin of echoes).
  F.send("sleep");
  await sleep(600);
  const dream = F.last("char.dream");
  check(
    !!dream && dream.data.personal === true && rescued.data.freed.includes(dream.data.subject),
    "the dream names a real person you saved -- the network populates your sleep with who you touched (char.dream personal)",
  );
  F.send("stand");
  await sleep(300);
} else {
  check(
    await waitForRaw(F, (t) => /cages stand open and empty/i.test(t), 5000, fcMark),
    "cages on cooldown are refused (no farm) -- the refill gate holds across runs",
  );
}
// Either way, the rescued are kept on the federated roll, named, with who freed
// them -- the hopeful mirror of the memorial roll. (Non-empty: someone freed at
// some point this run or a prior one.)
F.send("saved");
await sleep(500);
const sroll = F.last("grid.rescued_roll");
check(
  !!sroll &&
    Array.isArray(sroll.data.rescued) &&
    sroll.data.rescued.length >= 1 &&
    sroll.data.rescued.every((r) => typeof r.name === "string" && typeof r.savedBy === "string"),
  "the rescued are kept on the Grid's roll, named, with who freed them (grid.rescued_roll)",
);

F.send("east"); // back to muster
await sleep(400);
F.send("north"); // -> war room
await sleep(450);
F.send("up"); // -> the Ashmonger's dais
await sleep(500);
const da = F.last("room.info");
check(
  da?.data.id === "dais" && da.data.mobs.some((m) => m.id === "ashmonger"),
  "the Ashmonger commands the dais (the endgame boss)",
);
const amark = F.raw().length;
F.send("talk");
await sleep(400);
check(/pledge|ashmonger|front/i.test(F.raw().slice(amark)), "the Ashmonger answers when you face him");
F.sock.close();

// --- Phase 10: federation phase 2 -- cross-world chat + the global tide ---
const GX = mkClient();
await GX.open();
await sleep(300);
const gxName = "caster_" + Math.random().toString(36).slice(2, 6);
GX.send(gxName);
await sleep(500);
await pickRace(GX); // first login of gxName: choose a race (returning logins skip this)
const GY = mkClient();
await GY.open();
await sleep(300);
GY.send("hearer_" + Math.random().toString(36).slice(2, 6));
await sleep(500);
await pickRace(GY);

// gridcast goes into the shared hub; the relay reaches every world's players on
// the alarm tick (so it round-trips through the federation backend, not locally).
GX.send("gridcast the wastes are listening");
const heard = await waitFor(
  GY.last,
  "comm.gridcast",
  (d) => d?.from === gxName && /wastes are listening/i.test(d?.text ?? ""),
  12000,
);
check(
  heard?.data.from === gxName && /wastes are listening/i.test(heard?.data.text ?? ""),
  "gridcast crosses the Grid and reaches another player via the hub (comm.gridcast)",
);

// the global faction tide: a faction choice moves a needle shared by every world.
// The tide is shared, persistent, mutable state clamped at +/-100, so across runs
// it can pin at its +100 ceiling -- where a +10 contribution would be swallowed by
// the clamp and "did the needle move?" becomes unprovable. Guarantee headroom
// first: a throwaway helper sides with the Front (-10) at the market, so whatever
// the starting value, the tide now sits at most +90. Then GX siding with the free
// folk (+10) must land as an exact, un-clamped rise -- a falsifiable assertion.
const GH = mkClient();
await GH.open();
await sleep(300);
GH.send("frontkid_" + Math.random().toString(36).slice(2, 6));
await sleep(500);
await pickRace(GH);
GH.send("north"); // nexus -> Scrap Market
await sleep(500);
GH.send("join"); // side with the Cinder Front -> -10 to the GLOBAL tide
await sleep(1200); // let the best-effort shiftTide RPC land before we read the tide
GH.sock.close();

const tideBefore = (await readWarTide(GX)) ?? 0;
GX.send("north"); // nexus -> Scrap Market
await sleep(500);
GX.send("defend"); // side with the free folk -> contributes +10 to the GLOBAL tide
await sleep(1200);
const tideAfter = (await readWarTide(GX)) ?? 0;
// With headroom guaranteed (tideBefore <= 90), the +10 lands exactly: proof the
// shared needle actually moved by the contribution, not that it was already maxed.
check(
  tideAfter === tideBefore + 10,
  `siding with the free folk moved the GLOBAL tide by exactly +10 (${tideBefore} -> ${tideAfter})`,
);

// Federation phase 3: the canonical identity lives in the hub and follows you.
GX.send("whoami");
const gxId = await waitFor(GX.last, "char.identity", (d) => d?.faction === "ally", 5000);
check(gxId?.data.faction === "ally", "whoami reads your canonical self live from the Grid (faction committed to the hub)");
GX.sock.close(); // commits the canonical sheet on logout
await sleep(800);
// Re-enter as the SAME character -- a stand-in for arriving in another world.
const GZ = mkClient();
await GZ.open();
await sleep(300);
await loginResume(GZ, gxName);
GZ.send("whoami");
await sleep(500);
const gzId = await waitFor(GZ.last, "char.identity", (d) => d?.faction === "ally", 8000);
check(
  gzId?.data.faction === "ally",
  "the identity persists in the hub and follows the character to a fresh login (one character, many worlds)",
);
GZ.sock.close();

// --- Phase 11: federation phase 4 -- the world registry + travel ----------
// Every login registers this world to the hub registry, and seeded sibling
// worlds give us somewhere to travel to. Saltreach stays a seeded, offline stub
// (we never run it), so it exercises the placeholder path; the real live second
// world (Dustfall) is proven separately in phase 12.
const TR = mkClient();
await TR.open();
await sleep(300);
TR.send("trav" + Math.floor(tideAfter)); // any fresh name
await sleep(600);
await pickRace(TR);
TR.send("worlds");
const wl = await waitFor(
  TR.last,
  "grid.worlds",
  (d) =>
    Array.isArray(d?.worlds) &&
    d.worlds.some((w) => w.here && w.id === WORLD_NAME) &&
    d.worlds.some((w) => /Saltreach/i.test(w.id)),
  5000,
);
check(
  !!wl && wl.data.worlds.some((w) => w.here && w.id === WORLD_NAME),
  `the registry lists this world (${WORLD_NAME}) and marks it as where you are`,
);
check(
  !!wl && wl.data.worlds.some((w) => /Saltreach/i.test(w.id)),
  "the registry lists seeded sibling worlds you can travel to (Saltreach)",
);
const trMark = TR.raw().length;
TR.send("travel Saltreach");
const trv = await waitFor(
  TR.last,
  "grid.travel",
  (d) => d?.to === "Saltreach" && /saltreach\.example/i.test(d?.url ?? ""),
  5000,
);
check(
  trv?.data.to === "Saltreach" && /saltreach\.example/i.test(trv?.data.url ?? ""),
  "travel routes you to a seeded sibling world and hands you its address (grid.travel)",
);
check(
  await waitForRaw(TR, (t) => /routes you toward Saltreach/i.test(t), 5000, trMark),
  "travel checkpoints you and hands you off across the Grid",
);

GY.sock.close();

// --- Phase 11b: keeper ledger maintenance (non-keeper refusal) ------------
// gridstats/gridprune happy path runs in phase 3 while the keeper is still live.
const NK = mkClient();
await NK.open();
await sleep(200);
NK.send("nokeeper_" + Math.random().toString(36).slice(2, 7));
await sleep(400);
await pickRace(NK);
await waitFor(NK.last, "room.info", (d) => !!d?.id, 5000);
NK.send("gridstats");
check(
  !NK.last("grid.ledger_stats")?.data?.total &&
    (await waitForRaw(NK, (t) => /keeper of the Grid/i.test(t), 5000)),
  "gridstats is refused to a non-keeper",
);
NK.sock.close();

// --- Phase 11c: the rite of remembrance (witness) ----------------------------
// `witness` reads the Grid's memorial roll of the fallen and lets the living
// keep a name. The reward (standing + a hair of tide) is bounded to once per
// fallen ever, so it cannot be farmed; here we assert the observable contract.
// The full rewarded path (death -> witness -> +morality) is verified against a
// live death; combat death is too non-deterministic to gate CI on.
const VG = mkClient();
await VG.open();
await sleep(200);
const wname = "witness_" + Math.random().toString(36).slice(2, 7);
VG.send(wname);
await sleep(400);
await pickRace(VG);
VG.send("witness");
const roll = await waitFor(VG.last, "grid.fallen", (d) => Array.isArray(d?.fallen), 5000);
check(!!roll && Array.isArray(roll.data.fallen), "witness reads the Grid's memorial roll of the fallen (grid.fallen)");
const vgSelfMark = VG.raw().length;
VG.send("witness " + wname); // a vigil for yourself is refused
check(
  (await waitForRaw(VG, (t) => /vigil for yourself/i.test(t), 5000, vgSelfMark)) && !VG.last("grid.remembrance"),
  "you cannot hold a vigil for yourself",
);
const noone = "nobody_" + Math.random().toString(36).slice(2, 7);
const vgNoMark = VG.raw().length;
VG.send("witness " + noone); // an unknown name keeps no one and rewards nothing
await sleep(400);
check(
  (await waitForRaw(VG, (t) => /no recent memory/i.test(t), 5000, vgNoMark)) && !VG.last("grid.remembrance"),
  "witnessing an unknown name keeps no one (no grid.remembrance)",
);
VG.sock.close();

// --- Phase 11d: the redemption arc (stray -> return) -------------------------
// The kapo's ash-mark is permanent, but everyone else who sinks into the cinders
// can find their way back, and the world recognizes it. A non-elf pledges to the
// Front at the dais (-25 -> strays), then defects to its face (+30, the bravest
// act on the board) -> climbs back into the light as "the Returned".
const RD = mkClient();
await RD.open();
await sleep(200);
const rdname = "return_" + Math.random().toString(36).slice(2, 6);
RD.send(rdname);
await sleep(400);
await pickRace(RD, "human"); // a non-elf: pledging is corruption, not the kapo brand
for (const dir of ["east", "up", "north", "north", "north", "north", "north", "up"]) {
  RD.send(dir);
  await sleep(420);
}
check(RD.last("room.info")?.data.id === "dais", "the oathbreaker-to-be reaches the Ashmonger's dais");
const rdmark = RD.raw().length;
RD.send("join"); // pledge to the Front: -25 morality, sworn to the cinders
check(await waitForRaw(RD, (t) => /strayed a long way/i.test(t), 5000, rdmark), "sinking into the Front strays you (the Grid marks it, write-once)");
const rdAff = await waitFor(RD.last, "char.affects", (d) => (d?.morality ?? 0) <= -20 && d?.faction === "front", 4000);
check(
  (rdAff?.data.morality ?? 0) <= -20 && rdAff?.data.faction === "front",
  "the dais oath leaves you deep in the cinders, sworn to the Front",
);
RD.send("defy"); // turn on the Front to its face: +30, back toward the light
const redeem = await waitFor(RD.last, "grid.redemption", (d) => d?.title === "the Returned", 5000);
check(!!redeem && redeem.data.title === "the Returned", "defecting back to the light makes a strayed soul the Returned (grid.redemption)");
const rdAfter = await waitFor(RD.last, "char.affects", (d) => d?.faction === "ally", 4000);
check(rdAfter?.data.faction === "ally", "the Returned stands with the free folk, no longer the Front");
RD.sock.close();

// --- Phase 11d2: forgiveness -- the second road home -------------------------
// The redemption arc above is a road walked ALONE: do enough good and the world
// meets your eyes again. This is the OTHER road -- another person, face to face,
// choosing to let a strayed soul back in. A person's hand completes the return
// short of the works, because mercy from a person counts. (The kapo case -- grace
// that lands but never lifts the brand -- is proven up in the kapo phase.)
const FG = mkClient(); // the one who forgives
const ST = mkClient(); // the one who strayed
await FG.open();
await ST.open();
await sleep(200);
const fgName = "grace_" + Math.random().toString(36).slice(2, 6);
const stName = "stray_" + Math.random().toString(36).slice(2, 6);
FG.send(fgName);
ST.send(stName);
await sleep(400);
await pickRace(FG, "human");
await pickRace(ST, "human"); // a non-elf: corruption strays you, it does not brand
FG.send("north"); // into the Scrap Market, together
ST.send("north");
await sleep(600);
// ST sinks into the cinders by their own hand (theft) WITHOUT joining the Front:
// a strayed soul, not redeemed and not sworn -- exactly the one a person can call
// back. Each theft is at least -5 morality, no cooldown, so six clears STRAY_FLOOR.
// (steal does not re-emit char.affects, so read the straying off moralArc's own
// line rather than the structured channel, which would be stale at this point.)
const ststraymark = ST.raw().length;
for (let i = 0; i < 6; i++) {
  ST.send("steal");
  await sleep(350);
}
check(/strayed a long way/i.test(ST.raw().slice(ststraymark)), "repeated theft strays a soul (the Grid marks it crossing the floor)");
check(ST.last("char.affects")?.data.faction !== "front", "the strayed soul never swore to the Front -- corruption, not collaboration");
// FG forgives ST: a person's hand finishes the road home.
const stmark = ST.raw().length;
FG.send(`forgive ${stName}`);
await sleep(700);
const forgiven = ST.last("char.forgiven");
check(
  forgiven?.data.by === fgName && forgiven.data.redeemed === true,
  "forgiving a strayed soul completes their return (char.forgiven, redeemed)",
);
const stReturn = ST.last("grid.redemption");
check(
  !!stReturn && stReturn.data.title === "the Returned",
  "the second road home: a person's forgiveness makes a strayed soul the Returned (grid.redemption)",
);
check(/found your way back/i.test(ST.raw().slice(stmark)), "the forgiven soul is met on the road, not left to walk it alone");
// Grace is paid once per (forgiver, subject) EVER -- a second forgiveness is refused.
const fgmark = FG.raw().length;
FG.send(`forgive ${stName}`);
await sleep(500);
check(/already forgiven/i.test(FG.raw().slice(fgmark)), "grace is once per pair: a second forgiveness is refused (unfarmable)");
// You cannot absolve a soul that carries nothing against it (ST has not forgiven
// anyone, so no cooldown; FG is unmarked, so there is nothing to forgive).
const stmark2 = ST.raw().length;
ST.send(`forgive ${fgName}`);
await sleep(500);
check(/nothing that needs your forgiveness/i.test(ST.raw().slice(stmark2)), "you cannot forgive a soul that carries nothing against it");
FG.sock.close();
ST.sock.close();

// --- Phase 11e: the reckoning (the mirror you summon) ------------------------
// The dream mirrors you involuntarily; `reckoning` is the version you summon and
// can read as data -- a moral self-model (for a human OR an agent). It counts
// what you have actually done and lets the sum speak.
const RK = mkClient();
await RK.open();
await sleep(200);
RK.send("reckon_" + Math.random().toString(36).slice(2, 6));
await sleep(400);
await pickRace(RK);
RK.send("reckoning");
await sleep(500);
const r0 = RK.last("char.reckoning");
check(
  !!r0 && typeof r0.data.deeds === "object" && typeof r0.data.morality === "number",
  "reckoning returns a structured moral self-model (char.reckoning)",
);
check(/Nothing yet weighs/i.test(RK.raw()), "a fresh soul's reckoning is empty -- the wastes are still waiting to see who you are");
RK.send("north"); // nexus -> the Scrap Market
await waitFor(RK.last, "room.info", (d) => d?.id === "market", 5000);
RK.send("steal"); // a theft: a deed the Grid keeps count of
await sleep(500);
RK.send("reckoning");
const r1 = await waitFor(RK.last, "char.reckoning", (d) => (d?.deeds?.stolen ?? 0) >= 1, 5000);
check(!!r1 && (r1.data.deeds.stolen ?? 0) >= 1, "the reckoning counts what you've done: a theft now shows on your ledger");
RK.sock.close();

// --- Phase 12: federation phase 5 -- a SECOND, real world on the same Grid ----
// Everything above ran against one world. This phase brings up a genuinely
// separate deployment (Dustfall, the same code under its own name/url on port
// 8788, bound to the same grid-hub) and proves the federation is real across the
// deployment boundary -- not seeded stubs. Requires `npm run dev` (now starts
// both worlds + the hub). Point elsewhere with DUSTFALL_URL.
const DUSTFALL_URL = process.env.DUSTFALL_URL ?? "ws://localhost:8788/ws";
let dustfallUp = true;
const D = mkClient(DUSTFALL_URL);
try {
  await Promise.race([
    D.open(),
    sleep(4000).then(() => Promise.reject(new Error("timeout"))),
  ]);
} catch {
  dustfallUp = false;
}

if (!dustfallUp) {
  // `npm run dev:solo` brings up only the primary world, so the second-world
  // checks are skipped (not failed) -- federation never blocks single-world play.
  console.log(`SKIP  second world not reachable at ${DUSTFALL_URL}; run \`npm run dev\` (both worlds) to exercise federation`);
} else {
  check(true, `the second world is reachable on its own deployment (${DUSTFALL_URL})`);
  // Log the SAME canonical character (gxName, committed as an "ally" in phase 10)
  // into the OTHER world. Its standing must arrive from the shared hub, proving
  // one identity spans two separate deployments -- the headline of federation.
  await loginResume(D, gxName);
  D.send("whoami");
  await sleep(500);
  const dIdentity = await waitFor(D.last, "char.identity", (d) => d?.faction === "ally", 10000);
  check(
    dIdentity?.data.faction === "ally",
    "one character spans two separate worlds: Dustfall loads gxName's canonical standing from the shared hub",
  );

  // The global tide is one needle for the whole federation: read from Dustfall it
  // must equal the value the primary world reads from the same hub.
  const tideDust = await readWarTide(D);
  const P = mkClient();
  await P.open();
  await sleep(300);
  P.send("crosscheck_" + Math.random().toString(36).slice(2, 6));
  await sleep(500);
  await pickRace(P);
  const tidePrimary = await readWarTide(P);
  check(
    typeof tideDust === "number" && tideDust === tidePrimary,
    `the global tide is shared across deployments (Dustfall reads ${tideDust}, primary reads ${tidePrimary})`,
  );

  // Federated presence: from the primary world, `who` sees the player on Dustfall
  // too (their world heartbeats its roster to the shared hub). Poll: the cross-
  // world heartbeat can take a moment to land.
  let crossWho = false;
  for (let i = 0; i < 10 && !crossWho; i++) {
    P.send("who");
    await sleep(500);
    crossWho = (P.last("grid.who")?.data.players ?? []).some((pl) => /Dustfall/i.test(pl.world) && pl.here === false);
  }
  check(crossWho, "who sees players across the whole federation, not just this world (a Dustfall player is visible from the primary)");

  // Now that Dustfall has checked in, the primary world's registry must list it
  // LIVE, and travel must hand off Dustfall's REAL url (ws://.../8788), not the
  // seeded placeholder -- the live registration has overwritten the stub.
  P.send("worlds");
  await sleep(600);
  const pw = P.last("grid.worlds");
  check(
    !!pw && pw.data.worlds.some((w) => /Dustfall/i.test(w.id) && w.reachable),
    "the primary world sees Dustfall registered REACHABLE on the Grid (a real second deployment, not a seeded stub)",
  );
  P.send("travel Dustfall");
  const pTrav = await waitFor(P.last, "grid.travel", (d) => d?.to === "Dustfall" && typeof d?.url === "string", 5000);
  const dustfallHost = new globalThis.URL(DUSTFALL_URL.replace(/^ws/i, "http")).host;
  check(
    pTrav?.data.to === "Dustfall" && (pTrav?.data.url ?? "").includes(dustfallHost),
    "travel now routes to Dustfall's real live address, the live entry having overwritten the seed",
  );
  P.sock.close();
  D.sock.close();
}

// Only pull the plug if running directly in terminal, let Vitest exit naturally 
if (!process.env.VITEST) {
  process.exit(failures ? 1 : 0);
} else if (failures) {
  // Forces Vitest to fail the build if any internal smoke assertions broke
  throw new Error(`${failures} check(s) FAILED during smoke execution loop.`);
}
