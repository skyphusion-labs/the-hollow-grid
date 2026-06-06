// Smoke test for The Hollow Grid.
//
// Demonstrates the payoff of the structured-state channel: instead of scraping
// English prose, the test asserts on the `@event` lines the server emits, so it
// can check EXACT game state (room graph, vitals) deterministically.
//
// Usage: start the server in one shell (`npm run dev`), then `node smoke.mjs`
// (or `npm run smoke`). Requires Node 24+ for the global WebSocket.
const URL = process.env.MUD_URL ?? "ws://localhost:8787/ws";

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  return {
    sock,
    last: (n) => [...evs].reverse().find((e) => e.name === n),
    raw: () => text,
    open: () =>
      new Promise((res, rej) => {
        sock.addEventListener("open", res);
        sock.addEventListener("error", rej);
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
  client.send(race);
  await sleep(400);
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
}

// Use a fresh, unique name each run so the test never inherits a persisted
// character's position -- a test must control its own fixtures.
const name = "smoke_" + Math.random().toString(36).slice(2, 8);
await sleep(300);
ws.send(name); // choose a name -> server prompts for a race
await sleep(500);
await pickRace(ws); // pick a race -> server logs us in and shows the start room

// Logging in already emits the start room + vitals via the structured channel.
const room = last("room.info");
check(!!room, "received a room.info event on login");
check(room?.data.id === "nexus", `start room id is "nexus" (got ${JSON.stringify(room?.data.id)})`);
check(Array.isArray(room?.data.exits) && room.data.exits.includes("north"), "room.info lists exits, including north");

const vit = last("char.vitals");
check(!!vit, "received a char.vitals event");
check(vit?.data.hp > 0 && vit?.data.maxHp > 0, `vitals carry hp/maxHp (${vit?.data.hp}/${vit?.data.maxHp})`);
check(vit?.data.inCombat === false, "vitals report inCombat=false out of combat");

const aff = last("char.affects");
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
await sleep(400);
check(last("char.equipment")?.data.weapon === "shiv", "wield puts the shiv in the weapon slot (char.equipment)");
ws.send("remove shiv");
await sleep(400);
check(last("char.equipment")?.data.weapon === null, "remove clears the weapon slot");
ws.send("wield shiv"); // re-equip for the fight ahead
await sleep(300);

// Title: set an epithet and confirm it shows after your name in who.
ws.send("title the Ash-Walker");
await sleep(400);
const wmark = raw.length;
ws.send("who");
await sleep(400);
check(/the Ash-Walker/.test(raw.slice(wmark)), "title shows after your name in who");

// Federation (phase 1): 'ping all' reaches the shared Grid backend and hears
// echoes from OTHER worlds on the network. Checked early, before this world has
// generated traces of its own, so the feed is purely the cross-world seeds.
ws.send("ping all");
await sleep(500);
const fed = last("grid.federation");
check(!!fed && Array.isArray(fed.data.traces) && fed.data.traces.length > 0, "ping all returns the federation feed (grid.federation)");
check(
  fed?.data.traces.some((t) => t.world && t.world !== "The Hollow Grid"),
  "the feed carries echoes from OTHER worlds on the shared Grid",
);

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

// Critical path: a full fight, asserted entirely on the combat.* channel.
events.length = 0;
ws.send("attack rat");
await sleep(800);
check(!!last("combat.start"), "attack emits combat.start");
check(last("char.vitals")?.data.inCombat === true, "vitals show inCombat=true mid-fight");

// Combat resolves on a ~3s alarm tick; wait for the kill (12 HP / ~5 dmg a round).
let ended = last("combat.end");
for (let i = 0; i < 8 && !ended; i++) {
  await sleep(2500);
  ended = last("combat.end");
}
check(!!last("combat.round"), "combat produced at least one combat.round event");
check(ended?.data.result === "killed", `combat ended in a kill (result=${JSON.stringify(ended?.data.result)})`);

const finalVit = last("char.vitals");
check(finalVit?.data.inCombat === false, "vitals show inCombat=false after the fight");
// The death-floor lesson, observed: the player survives a starter mob easily.
check(finalVit?.data.hp > 0, `player survived the glow-rat (hp=${finalVit?.data.hp})`);

// ...and the clock advanced on its own while we were busy fighting (the alarm
// heartbeat turns the world even between our actions).
events.length = 0;
ws.send("world");
await sleep(500);
const w1 = last("world.state");
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
check(A.last("char.affects")?.data.faction === "front", "joining brands the player Cinder Front (char.affects)");

// The honest market remembers, and shuts them out.
A.send("sell scrap");
await sleep(500);
check(/don't trade with your kind/i.test(A.raw()), "the market refuses to trade with a Cinder Front member");

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
await sleep(700);
check(/ash-sworn/i.test(KAPO.raw().slice(kmark)), "an elf who joins the Front is branded ash-sworn (the kapo)");
check(KAPO.last("char.affects")?.data.ashsworn === true, "the ash-sworn brand is on the structured channel (char.affects)");

// The brand outranks faction and never washes off: others see "ash-sworn".
const KW = mkClient();
await KW.open();
await sleep(300);
KW.send("kwit_" + Math.random().toString(36).slice(2, 6));
await sleep(500);
await pickRace(KW);
KW.send("north"); // into the market, where the kapo stands
await sleep(700);
const kseen = KW.last("room.info")?.data.players?.find((p) => p.name === kName);
check(kseen?.standing === "ash-sworn", `the world brands the kapo to others as ash-sworn (got ${JSON.stringify(kseen?.standing)})`);
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
TV.sock.close();

// --- Phase 3: server-wide announcements (wall) ---
const ADMIN = mkClient();
await ADMIN.open();
await sleep(300);
ADMIN.send("skyphusion"); // a keeper, per the ADMINS wrangler var
await sleep(500);
await pickRace(ADMIN);
const OBS = mkClient();
await OBS.open();
await sleep(300);
OBS.send("watcher_" + Math.random().toString(36).slice(2, 7));
await sleep(500);
await pickRace(OBS);

// A non-admin cannot broadcast.
OBS.send("wall I should not be able to do this");
await sleep(400);
check(/keeper of the Grid/i.test(OBS.raw()), "a non-admin is refused the wall command");

// A keeper's announcement reaches every player, wherever they are.
const beacon = "The Grid stirs in the deep dark.";
ADMIN.send("wall " + beacon);
await sleep(500);
check(OBS.raw().includes(beacon), "an admin wall reaches another player anywhere in the world");
check(/GRID BROADCAST/i.test(OBS.raw()), "the announcement is clearly marked as a server broadcast");
const ann = OBS.last("server.announce");
check(
  ann?.data.text === beacon && ann?.data.from === "skyphusion",
  "the announcement is on the structured channel (server.announce)",
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
await sleep(400);
const told = Q.last("comm.tell");
check(told?.data.from === pName && /you there/i.test(told?.data.text ?? ""), "tell delivers a private message (comm.tell)");
Q.send("reply loud and clear");
await sleep(400);
check(/loud and clear/i.test(P.raw()), "reply answers the last teller");

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
W.sock.close();

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
F.send("ftest_" + Math.random().toString(36).slice(2, 6));
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
let fmark = F.raw().length;
F.send("free");
await sleep(400);
check(/refugees pour out|throws open/i.test(F.raw().slice(fmark)), "you can free the caged refugees in the stronghold");

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
fmark = F.raw().length;
F.send("talk");
await sleep(400);
check(/pledge|ashmonger|front/i.test(F.raw().slice(fmark)), "the Ashmonger answers when you face him");
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
await sleep(10000); // ~3 alarm ticks: the relay round-trips through the backend
// Worker over a service binding, so give it margin for the tick + RPC latency.
const heard = GY.last("comm.gridcast");
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
await sleep(500);
check(
  GX.last("char.identity")?.data.faction === "ally",
  "whoami reads your canonical self live from the Grid (faction committed to the hub)",
);
GX.sock.close(); // commits the canonical sheet on logout
await sleep(800);
// Re-enter as the SAME character -- a stand-in for arriving in another world.
const GZ = mkClient();
await GZ.open();
await sleep(300);
GZ.send(gxName);
await sleep(600);
GZ.send("whoami");
await sleep(500);
check(
  GZ.last("char.identity")?.data.faction === "ally",
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
await sleep(600);
const wl = TR.last("grid.worlds");
check(
  !!wl && wl.data.worlds.some((w) => w.here && w.id === "The Hollow Grid"),
  "the registry lists this world (The Hollow Grid) and marks it as where you are",
);
check(
  !!wl && wl.data.worlds.some((w) => /Saltreach/i.test(w.id)),
  "the registry lists seeded sibling worlds you can travel to (Saltreach)",
);
const trMark = TR.raw().length;
TR.send("travel Saltreach");
await sleep(700);
const trv = TR.last("grid.travel");
check(
  trv?.data.to === "Saltreach" && /saltreach\.example/i.test(trv?.data.url ?? ""),
  "travel routes you to a seeded sibling world and hands you its address (grid.travel)",
);
check(
  /routes you toward Saltreach/i.test(TR.raw().slice(trMark)),
  "travel checkpoints you and hands you off across the Grid",
);

GY.sock.close();

// --- Phase 11b: keeper ledger maintenance (gridstats / gridprune) ------------
// A keeper (the ADMINS var = "skyphusion" in dev) can read the shared ledger's
// composition and flush the ambient-noise backlog. The purgeable set is fixed
// in code (ghost/passage/recall), so a keeper cannot erase meaningful traces.
const K = mkClient();
await K.open();
await sleep(200);
K.send("skyphusion"); // a keeper name (matches the dev ADMINS var)
await sleep(400);
await pickRace(K);
K.send("gridstats");
await sleep(500);
const ks = K.last("grid.ledger_stats");
check(!!ks && typeof ks.data.total === "number" && Array.isArray(ks.data.kinds), "gridstats reports the keeper the ledger composition (grid.ledger_stats)");
K.send("gridprune");
await sleep(600);
const kp = K.last("grid.ledger_pruned");
check(
  !!kp && typeof kp.data.removed === "number" && kp.data.after <= kp.data.before,
  "gridprune flushes ambient traces and reports before/after counts (grid.ledger_pruned)",
);
check(
  !!kp && (kp.data.kinds ?? []).every((r) => !["ghost", "passage", "recall"].includes(r.kind)),
  "after a prune no ambient kinds (ghost/passage/recall) remain in the ledger",
);
K.sock.close();

// A non-keeper is refused and gets no maintenance event back.
const NK = mkClient();
await NK.open();
await sleep(200);
NK.send("nokeeper_" + Math.random().toString(36).slice(2, 7));
await sleep(400);
await pickRace(NK);
NK.send("gridstats");
await sleep(400);
check(!NK.last("grid.ledger_stats") && /keeper of the Grid/i.test(NK.raw()), "gridstats is refused to a non-keeper");
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
await sleep(500);
const roll = VG.last("grid.fallen");
check(!!roll && Array.isArray(roll.data.fallen), "witness reads the Grid's memorial roll of the fallen (grid.fallen)");
VG.send("witness " + wname); // a vigil for yourself is refused
await sleep(400);
check(!VG.last("grid.remembrance") && /vigil for yourself/i.test(VG.raw()), "you cannot hold a vigil for yourself");
const noone = "nobody_" + Math.random().toString(36).slice(2, 7);
VG.send("witness " + noone); // an unknown name keeps no one and rewards nothing
await sleep(400);
check(!VG.last("grid.remembrance") && /no recent memory/i.test(VG.raw()), "witnessing an unknown name keeps no one (no grid.remembrance)");
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
await sleep(650);
check(/strayed a long way/i.test(RD.raw().slice(rdmark)), "sinking into the Front strays you (the Grid marks it, write-once)");
check(
  RD.last("char.affects")?.data.morality <= -20 && RD.last("char.affects")?.data.faction === "front",
  "the dais oath leaves you deep in the cinders, sworn to the Front",
);
RD.send("defy"); // turn on the Front to its face: +30, back toward the light
await sleep(750);
const redeem = RD.last("grid.redemption");
check(!!redeem && redeem.data.title === "the Returned", "defecting back to the light makes a strayed soul the Returned (grid.redemption)");
check(RD.last("char.affects")?.data.faction === "ally", "the Returned stands with the free folk, no longer the Front");
RD.sock.close();

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
await sleep(450);
RK.send("steal"); // a theft: a deed the Grid keeps count of
await sleep(500);
RK.send("reckoning");
await sleep(500);
const r1 = RK.last("char.reckoning");
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
  D.send(gxName);
  await sleep(800);
  D.send("whoami");
  await sleep(600);
  check(
    D.last("char.identity")?.data.faction === "ally",
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

  // Now that Dustfall has checked in, the primary world's registry must list it
  // LIVE, and travel must hand off Dustfall's REAL url (ws://.../8788), not the
  // seeded placeholder -- the live registration has overwritten the stub.
  P.send("worlds");
  await sleep(600);
  const pw = P.last("grid.worlds");
  check(
    !!pw && pw.data.worlds.some((w) => /Dustfall/i.test(w.id) && w.live),
    "the primary world sees Dustfall registered LIVE on the Grid (a real second deployment, not a stub)",
  );
  P.send("travel Dustfall");
  await sleep(700);
  const pTrav = P.last("grid.travel");
  check(
    pTrav?.data.to === "Dustfall" && /localhost:8788/i.test(pTrav?.data.url ?? ""),
    "travel now routes to Dustfall's real live address, the live entry having overwritten the seed",
  );
  P.sock.close();
  D.sock.close();
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nSMOKE TEST PASSED");
process.exit(failures ? 1 : 0);
