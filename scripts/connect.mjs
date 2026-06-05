// A dependency-free interactive client for The Hollow Grid.
//
// Node 24+ ships a global WebSocket, so playing the MUD needs nothing installed:
// this opens a socket, prints whatever the server sends, and forwards each line
// you type as a command. It is the same transport smoke.mjs uses, minus the
// assertions. (wscat works too, but it is not a dependency of this repo.)
//
//   npm run connect                       # primary world, ws://localhost:8787/ws
//   npm run connect -- ws://localhost:8788/ws   # the second world (Dustfall)
//   MUD_URL=wss://my-world.workers.dev/ws npm run connect   # a deployed world
//
// Lines beginning with `@event ` are the structured-state channel; pass --raw to
// see them, otherwise they are hidden so the prose reads like a normal session.
const url = process.argv.find((a) => /^wss?:\/\//.test(a)) ?? process.env.MUD_URL ?? "ws://localhost:8787/ws";
const showEvents = process.argv.includes("--raw");

const sock = new WebSocket(url);
const pending = []; // lines typed before the socket finishes opening

sock.addEventListener("open", () => {
  process.stderr.write(`connected to ${url}  (type commands; Ctrl-C to quit${showEvents ? "" : "; --raw to show @event lines"})\n`);
  for (const line of pending.splice(0)) sock.send(line);
});

sock.addEventListener("message", (e) => {
  for (const line of String(e.data).split(/\r?\n/)) {
    if (!showEvents && line.startsWith("@event ")) continue;
    process.stdout.write(line + "\n");
  }
});

sock.addEventListener("close", () => {
  process.stderr.write("\nconnection closed.\n");
  process.exit(0);
});

sock.addEventListener("error", (e) => {
  process.stderr.write(`\nconnection error for ${url}: ${e.message ?? e}\n(is the world running? \`npm run dev\`)\n`);
  process.exit(1);
});

// Forward each typed line as a command. readline gives us clean line editing.
const { createInterface } = await import("node:readline");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (sock.readyState === WebSocket.OPEN) sock.send(line);
  else if (sock.readyState === WebSocket.CONNECTING) pending.push(line);
  // (if CLOSING/CLOSED, drop -- there is nowhere to send)
});
rl.on("close", () => {
  try {
    sock.close(1000, "client quit");
  } catch {
    /* already closing */
  }
});
