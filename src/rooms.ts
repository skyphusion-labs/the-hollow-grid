// The world map. Rooms are static game data defined in code; player positions
// (the dynamic state) live on each WebSocket's attachment + the SQLite `players`
// table. Add rooms here and link them via `exits`.
//
// Design rule that fixes the bug that started this whole project: an exit only
// exists if it's declared here. Movement either follows a declared exit or
// returns a clear "you can't go that way"; there are no silent no-ops, so a
// player can never get trapped by a phantom direction.

export interface Room {
  id: string;
  name: string;
  desc: string;
  /** direction (canonical, e.g. "north") -> destination room id */
  exits: Record<string, string>;
}

export const START_ROOM = "nexus";

export const ROOMS: Record<string, Room> = {
  nexus: {
    id: "nexus",
    name: "The Cracked Nexus",
    desc:
      "A domed junction of fused rebar and dead neon. Corridors bleed off into " +
      "the dark, a maintenance hatch gapes in the floor, and warm light spills " +
      "from a bar to the west.",
    exits: { north: "market", east: "workshop", down: "tunnels", west: "tavern" },
  },
  tavern: {
    id: "tavern",
    name: "The Rusted Tankard",
    desc:
      "A low, smoky bar built from shipping crates. Someone's coaxing a tune out " +
      "of a busted synth in the corner. This is where the wastes come to forget.",
    exits: { east: "nexus" },
  },
  market: {
    id: "market",
    name: "Scrap Market",
    desc:
      "Tarps and rusted shelving sag under salvage nobody trusts. A vendor drone " +
      "blinks a hopeful, broken green. A reinforced door stands to the north.",
    exits: { south: "nexus", north: "holding_pit" },
  },
  holding_pit: {
    id: "holding_pit",
    name: "The Holding Pit",
    desc:
      "A sunken concrete cell, walls scrawled with the tally-marks of the desperate. " +
      "Chains bolt into the far wall.",
    exits: { south: "market" },
  },
  workshop: {
    id: "workshop",
    name: "Tinker's Workshop",
    desc:
      "Workbenches crusted with solder and ambition. A ladder bolted to the wall " +
      "climbs toward a square of grey sky.",
    exits: { west: "nexus", up: "roof" },
  },
  roof: {
    id: "roof",
    name: "Rusted Rooftop",
    desc:
      "Wind drags grit across corrugated steel. The wastes stretch out in every " +
      "direction, indifferent and enormous.",
    exits: { down: "workshop" },
  },
  tunnels: {
    id: "tunnels",
    name: "Service Tunnels",
    desc:
      "Cramped, dripping, and lit by one surviving strip light. Something " +
      "skitters away from your footsteps. A flooded shaft drops away below.",
    exits: { up: "nexus", down: "sump" },
  },
  sump: {
    id: "sump",
    name: "The Sump",
    desc:
      "Ankle-deep in oily runoff that glows a sick green. The walls sweat. " +
      "Whatever lives down here, lives hungry.",
    exits: { up: "tunnels" },
  },
};

/** The room where the captive maiden is held. */
export const HOLDING_PIT = "holding_pit";
/** The mob whose defeat unlocks the maiden. */
export const WARDEN_ID = "warden";
/** The bar: site of the drug and tavern-companion temptations. */
export const TAVERN = "tavern";
/** The public square: site of theft and the Cinder Front rally. */
export const MARKET = "market";

const DIR_ALIASES: Record<string, string> = {
  n: "north",
  s: "south",
  e: "east",
  w: "west",
  ne: "northeast",
  nw: "northwest",
  se: "southeast",
  sw: "southwest",
  u: "up",
  d: "down",
};

const CANONICAL_DIRS = new Set([
  "north",
  "south",
  "east",
  "west",
  "northeast",
  "northwest",
  "southeast",
  "southwest",
  "up",
  "down",
]);

/** Returns the canonical direction name, or null if `word` isn't a direction. */
export function normalizeDir(word: string): string | null {
  const w = word.toLowerCase();
  if (DIR_ALIASES[w]) return DIR_ALIASES[w];
  return CANONICAL_DIRS.has(w) ? w : null;
}
