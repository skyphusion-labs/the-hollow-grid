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

console.log(failures ? `\n${failures} check(s) FAILED` : "\nSMOKE TEST PASSED");
process.exit(failures ? 1 : 0);
