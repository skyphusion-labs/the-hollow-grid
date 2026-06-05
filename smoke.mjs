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

let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? "ok  " : "FAIL"}  ${msg}`);
  if (!cond) failures++;
}

const ws = new WebSocket(URL);
ws.addEventListener("message", (e) => ingest(e.data));
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

// Move and confirm the structured room graph tracks us.
events.length = 0;
ws.send("north");
await sleep(600);
const room2 = last("room.info");
check(!!room2, "moving emits a fresh room.info");
check(room2 && room2.data.id !== "nexus", `north left the nexus (now "${room2?.data.id}")`);

ws.close();
console.log(failures ? `\n${failures} check(s) FAILED` : "\nSMOKE TEST PASSED");
process.exit(failures ? 1 : 0);
