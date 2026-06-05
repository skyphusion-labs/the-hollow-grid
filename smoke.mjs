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
function mkClient() {
  const evs = [];
  let text = "";
  const sock = new WebSocket(URL);
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

// Use a fresh, unique name each run so the test never inherits a persisted
// character's position -- a test must control its own fixtures.
const name = "smoke_" + Math.random().toString(36).slice(2, 8);
await sleep(300);
ws.send(name); // choose a name -> server logs us in and shows the start room
await sleep(500);

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

// Positions: rest, and confirm the alarm regenerates HP over a couple of ticks.
events.length = 0;
ws.send("rest");
await sleep(500);
const hpRest = last("char.vitals")?.data.hp ?? 0;
check(last("char.vitals")?.data.position === "resting", "rest sets position to resting (char.vitals)");
await sleep(7500); // ~2-3 alarm ticks of +2 regen
const hpAfter = last("char.vitals")?.data.hp ?? 0;
check(hpAfter > hpRest, `resting regenerates HP over time (${hpRest} -> ${hpAfter})`);

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

// --- Phase 3: server-wide announcements (wall) ---
const ADMIN = mkClient();
await ADMIN.open();
await sleep(300);
ADMIN.send("skyphusion"); // a keeper, per the ADMINS wrangler var
await sleep(500);
const OBS = mkClient();
await OBS.open();
await sleep(300);
OBS.send("watcher_" + Math.random().toString(36).slice(2, 7));
await sleep(500);

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
const Q = mkClient();
await Q.open();
await sleep(300);
const qName = "bex_" + Math.random().toString(36).slice(2, 6);
Q.send(qName);
await sleep(500);

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

// look at another player in the room
const pmark = P.raw().length;
P.send(`look ${qName}`);
await sleep(400);
check(/stands before you/i.test(P.raw().slice(pmark)), "look <player> describes another player");

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
const GY = mkClient();
await GY.open();
await sleep(300);
GY.send("hearer_" + Math.random().toString(36).slice(2, 6));
await sleep(500);

// gridcast goes into the shared hub; the relay reaches every world's players on
// the alarm tick (so it round-trips through the federation backend, not locally).
GX.send("gridcast the wastes are listening");
await sleep(7000); // a couple of alarm ticks for the relay
const heard = GY.last("comm.gridcast");
check(
  heard?.data.from === gxName && /wastes are listening/i.test(heard?.data.text ?? ""),
  "gridcast crosses the Grid and reaches another player via the hub (comm.gridcast)",
);

// the global faction tide: a faction choice moves a needle shared by every world.
GX.send("war");
await sleep(500);
const tideBefore = GX.last("world.war")?.data.tide ?? 0;
GX.send("north"); // nexus -> Scrap Market
await sleep(500);
GX.send("defend"); // side with the free folk -> contributes +10 to the GLOBAL tide
await sleep(900);
GX.send("war");
await sleep(600);
const tideAfter = GX.last("world.war")?.data.tide ?? 0;
check(tideAfter > tideBefore, `siding with the free folk moved the GLOBAL tide (${tideBefore} -> ${tideAfter})`);

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
GY.sock.close();

console.log(failures ? `\n${failures} check(s) FAILED` : "\nSMOKE TEST PASSED");
process.exit(failures ? 1 : 0);
