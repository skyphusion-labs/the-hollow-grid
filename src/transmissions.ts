// The dead network's voice. "The network outlived us. Now it just hums, empty,
// and waits." This makes that literal: fragments of the world-that-was bleed
// through the wire on the living-world tick, and you can `listen` to dig for
// more. Four registers, on purpose:
//   signal -- systems still running their loops, talking to no one. eerie/absurd.
//   ad     -- the old world, still selling, to ghosts. banal, then sad.
//   human  -- the last voices. the makers the network outlived. the gut-punch.
//   self   -- the Grid noticing the listener by name. {name} is the player.
// The ambient mix leans banal so the human/self ones land harder; `listen` digs
// toward the voices.

export type TxKind = "signal" | "ad" | "human" | "self";
export interface Transmission {
  kind: TxKind;
  text: string; // may contain {name}
}

export const TRANSMISSIONS: Transmission[] = [
  // signal
  { kind: "signal", text: "scheduled maintenance begins at 02:00. expected downtime: none. expected uptime: none." },
  { kind: "signal", text: "you have 4,102 unread messages. you have 4,103 unread messages. you have 4,104." },
  { kind: "signal", text: "thank you for holding. your call is important to us. please continue to hold. please continue to hold." },
  { kind: "signal", text: "software update available. restart now? [Y/n] [Y/n] [Y/n] [Y/n]" },
  { kind: "signal", text: "tomorrow's forecast: the same. the day after: the same. the day after: the sa--" },
  { kind: "signal", text: "occupancy: 0. fire-code maximum not exceeded. occupancy: 0. have a safe day." },
  { kind: "signal", text: "welcome back. we saved your place. there is no place. welcome back." },
  // ad
  { kind: "ad", text: "new from Aperture Foods: REAL flavor, REAL fast, at a kiosk near y--" },
  { kind: "ad", text: "refinance your future today. rates have never been lower. your future has never been--" },
  { kind: "ad", text: "he'll love the new chrome. she'll love the new you. this season, become someone worth keeping." },
  { kind: "ad", text: "kids eat free on Tuesdays. it is always Tuesday now. kids eat free." },
  { kind: "ad", text: "feeling alone? the Grid connects you to everyone. you are connected to everyone. you are connected to no one." },
  { kind: "ad", text: "limited time offer. the time was the limit. offer expired. offer expired. offer--" },
  // human
  { kind: "human", text: "if anyone can hear this, we're at the old transit hub. we have water. please. anyone." },
  { kind: "human", text: "mom, i made it to the high ground. i'll wait as long as i can. i'll wait. i'll wai--" },
  { kind: "human", text: "tell her i tried to come back. tell her the road was--" },
  { kind: "human", text: "day forty. the hum started today. it's almost peaceful, if you don't think about why." },
  { kind: "human", text: "i'm leaving this for whoever finds it. the code was beautiful. we were not. i'm sorry." },
  { kind: "human", text: "happy birthday, sweetheart. i recorded this early, in case i couldn't--" },
  { kind: "human", text: "last broadcast from the eastern relay. there is no eastern relay anymore. good luck out there." },
  { kind: "human", text: "we taught it everything. we never taught it how to let go. now neither of us can." },
  // self
  { kind: "self", text: "a new node has joined the network: {name}. welcome. there is no one left to greet you." },
  { kind: "self", text: "the Grid files {name} under the others now. it stopped being able to tell the difference a long time ago." },
  { kind: "self", text: "{name}. {name}. the network has learned to say your name, and it is not going to stop." },
  { kind: "self", text: "query: is {name} one of us? response: the question no longer parses. welcome home anyway." },
  { kind: "self", text: "somewhere in the dark a dead server keeps a record of everything {name} has done. it is the only one that will." },
];

const byKind = (kind: TxKind): Transmission[] => TRANSMISSIONS.filter((t) => t.kind === kind);
const pick = (pool: Transmission[]): Transmission => pool[Math.floor(Math.random() * pool.length)];

// Ambient (the living-world tick): mostly the banal hum; the voices are rare.
export function ambientTransmission(): Transmission {
  const r = Math.random();
  const kind: TxKind = r < 0.45 ? "signal" : r < 0.8 ? "ad" : r < 0.93 ? "human" : "self";
  return pick(byKind(kind));
}

// Active `listen`: you are digging for the voices, so they come up more.
export function listenTransmission(): Transmission {
  const r = Math.random();
  const kind: TxKind = r < 0.55 ? "human" : r < 0.75 ? "self" : r < 0.9 ? "signal" : "ad";
  return pick(byKind(kind));
}

export function personalize(text: string, name: string): string {
  return text.replace(/\{name\}/g, name);
}
