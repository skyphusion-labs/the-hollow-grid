// The world map. Rooms are static game data defined in code; player positions
// (the dynamic state) live on each WebSocket's attachment + the SQLite `players`
// table. Add rooms here and link them via `exits`.
//
// Design rule that fixes the bug that started this whole project: an exit only
// exists if it's declared here. Movement either follows a declared exit or
// returns a clear "you can't go that way" — there are no silent no-ops, so a
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
      "A domed junction of fused rebar and dead neon. Four corridors bleed off " +
      "into the dark, and a maintenance hatch gapes in the floor.",
    exits: { north: "market", east: "workshop", down: "tunnels" },
  },
  market: {
    id: "market",
    name: "Scrap Market",
    desc:
      "Tarps and rusted shelving sag under salvage nobody trusts. A vendor drone " +
      "blinks a hopeful, broken green.",
    exits: { south: "nexus" },
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
      "skitters away from your footsteps.",
    exits: { up: "nexus" },
  },
};

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
