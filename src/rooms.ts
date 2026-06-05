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
      "direction, indifferent and enormous. A catwalk runs north off the roof's edge " +
      "and down to the open flats.",
    exits: { down: "workshop", north: "dunes" },
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
      "Whatever lives down here, lives hungry. A buckled bulkhead gapes below, " +
      "and cold air pours up out of it.",
    exits: { up: "tunnels", down: "floodgate" },
  },

  // --- The Sunken Server Farm: a flooded data center, the Grid's drowned heart ---
  floodgate: {
    id: "floodgate",
    name: "The Breached Floodgate",
    desc:
      "A bulkhead the size of a truck, buckled open. The sump's runoff pours " +
      "through it and down into a drowned cathedral of machines. A stranded " +
      "operator huddles by a dead console, watching you with wary hope. (try 'talk')",
    exits: { up: "sump", north: "coldrow" },
  },
  coldrow: {
    id: "coldrow",
    name: "Cold Storage Row",
    desc:
      "Aisle after aisle of server racks stand hip-deep in black water, their " +
      "status lights long dead. Something pale flickers between them, feeding on " +
      "whatever current is left.",
    exits: { south: "floodgate", east: "cooling", north: "fiber" },
  },
  cooling: {
    id: "cooling",
    name: "The Cooling Pools",
    desc:
      "Great square pools of coolant gone to scum and rust. A maintenance unit " +
      "lurches through the shallows on three working legs, still trying to do its job.",
    exits: { west: "coldrow" },
  },
  fiber: {
    id: "fiber",
    name: "The Fiber Vault",
    desc:
      "A cathedral nave of severed fiber-optic trunks, each thick as your arm, " +
      "hanging dead from the ceiling. This was the spine of the Grid once. Something " +
      "cold still moves along the cables, where the light used to.",
    exits: { south: "coldrow", down: "corelab" },
  },
  corelab: {
    id: "corelab",
    name: "The Core Lab",
    desc:
      "The drowned heart of the data center. A single black monolith of a server " +
      "still hums, impossibly, in the dark, and something has made itself its keeper. " +
      "It turns to face you. (the Custodian guards it)",
    exits: { up: "fiber", west: "archive" },
  },
  archive: {
    id: "archive",
    name: "The Cold Archive",
    desc:
      "A sealed vault of tape spools and frozen drives, untouched by the flood. " +
      "The air is bone-dry and very cold. Whatever the Grid wanted to keep forever, " +
      "it kept here.",
    exits: { east: "corelab" },
  },

  // --- The Open Wastes: the surface, where faction standing has teeth ---
  dunes: {
    id: "dunes",
    name: "The Ash Flats",
    desc:
      "Open desert under a bleached sky, dunes of grey ash rolling to the horizon. A " +
      "cracked highway runs east, and the silhouette of a checkpoint stands to the north.",
    exits: { south: "roof", east: "scorch_road", north: "checkpoint" },
  },
  scorch_road: {
    id: "scorch_road",
    name: "The Scorch Road",
    desc:
      "A ruined stretch of pre-collapse highway, asphalt buckled and tar-black, " +
      "burned-out hulks lining the shoulder. The kind of place people get robbed.",
    exits: { west: "dunes", east: "waystation" },
  },
  checkpoint: {
    id: "checkpoint",
    name: "The Cinder Front Checkpoint",
    desc:
      "Sandbags, razor-wire, and a banner stamped with the Front's ash-and-flame mark. " +
      "An enforcer mans the barrier, weighing everyone who comes up the road.",
    exits: { south: "dunes" },
  },
  waystation: {
    id: "waystation",
    name: "The Refugee Waystation",
    desc:
      "A huddle of tents and tarps where the free folk shelter off the road. A field " +
      "medic works a triage cot, and wary eyes track every newcomer.",
    exits: { west: "scorch_road" },
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
