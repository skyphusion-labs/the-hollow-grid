// Player races. Like rooms/mobs/items, races are data, and like them a world owns
// its own roster. A race is mostly NARRATIVE weight, not a stat block: the load
// bearing field is `stance`, how the Cinder Front treats your people, which the
// faction-reactive rooms read. The mechanical leans are deliberately light.
//
// Race is a federated, canonical attribute: it lives on the CharSheet and follows
// you across worlds, chosen once at character creation. The Grid Hub carries the
// race id as an opaque string and never gatekeeps it, so a world (including a
// third-party one) can define any race it likes. A world that receives a traveler
// whose race it does not recognize degrades gracefully (see raceFor / unknown
// handling in world.ts): the label still travels, but local mechanics default.
// See docs/worlds.md and docs/federation.md for the shared-canon-vs-local plan.

export type FrontStance = "accepted" | "tolerated" | "hunted";

export interface Race {
  id: string;
  name: string;
  /** one line shown in the character-creation menu */
  blurb: string;
  /** how the Cinder Front treats this people -- the heart of the system */
  stance: FrontStance;
  /** light mechanical leans */
  hpMod: number; // added to base max HP
  damage: number; // flat bonus to attack damage
  armor: number; // flat damage soaked off incoming hits
  regen: number; // extra HP per out-of-combat tick
  poisonImmune?: boolean;
  /** the trait line shown when you choose the race */
  trait: string;
}

export const RACES: Record<string, Race> = {
  human: {
    id: "human",
    name: "Human",
    blurb: "the Registered -- the Front's idea of a real person",
    stance: "accepted",
    hpMod: 0,
    damage: 0,
    armor: 0,
    regen: 0,
    trait: "Unmarked. The registry, the vendors, and the checkpoints treat you as a person by default.",
  },
  elf: {
    id: "elf",
    name: "Elf",
    blurb: "the Unregistered -- the people the Cinder Front hunts",
    stance: "hunted",
    hpMod: 0,
    damage: 0,
    armor: 0,
    regen: 1,
    trait: "Quick and resilient; you recover a little faster. The Front's cages, rallies, and checkpoints are about you.",
  },
  revenant: {
    id: "revenant",
    name: "Revenant",
    blurb: "a mind the network kept after the body failed",
    stance: "hunted",
    hpMod: 0,
    damage: 0,
    armor: 0,
    regen: 0,
    poisonImmune: true,
    trait: "No flesh to rot: poison and the pox cannot touch you. The Front calls you an abomination, not a citizen.",
  },
  ghoul: {
    id: "ghoul",
    name: "Ghoul",
    blurb: "rad-scoured human, hard to kill",
    stance: "tolerated",
    hpMod: 10,
    damage: 0,
    armor: 0,
    regen: 0,
    trait: "You carry more hit points than flesh should. The Front works you, and never lets you forget you are not 'real'.",
  },
  chromed: {
    id: "chromed",
    name: "Chromed",
    blurb: "flesh half-replaced with salvage augments",
    stance: "tolerated",
    hpMod: 0,
    damage: 1,
    armor: 1,
    regen: 0,
    trait: "Chrome under the skin: a little more bite, a little more plate. The Front's muscle is chromed too, until you go too far.",
  },
  dustkin: {
    id: "dustkin",
    name: "Dustkin",
    blurb: "born to the open pan, owing the registry nothing",
    stance: "hunted",
    hpMod: 0,
    damage: 0,
    armor: 0,
    regen: 2,
    trait: "At home where others die: you heal faster out in the world. The Front hunts you as a vagrant.",
  },
  vatborn: {
    id: "vatborn",
    name: "Vatborn",
    blurb: "grown, not born, in the old fabrication vats",
    stance: "hunted",
    hpMod: 5,
    damage: 0,
    armor: 0,
    regen: 0,
    trait: "Printed sturdy: a little extra frame. No lineage the Front recognizes, so they call you property.",
  },
};

// The menu order (and the numbers a player can pick by).
export const RACE_ORDER = ["human", "elf", "revenant", "ghoul", "chromed", "dustkin", "vatborn"];

// Look up a race definition. Returns undefined for an unknown id (e.g. a race
// some other world defined and we have never heard of) -- callers fall back to
// neutral local mechanics and treat the unknown race as the default stance.
export function raceFor(id?: string): Race | undefined {
  return id ? RACES[id.trim().toLowerCase()] : undefined;
}

// How a world's Cinder Front treats a race it may not recognize: unknown races
// default to "tolerated" (present but eyed), so a traveler with a foreign race is
// neither auto-hunted nor auto-accepted.
export function stanceFor(id?: string): FrontStance {
  return raceFor(id)?.stance ?? "tolerated";
}

// Parse a player's pick at character creation: a number (1..N) or a name/prefix.
export function matchRace(input: string): string | undefined {
  const a = input.trim().toLowerCase();
  if (!a) return undefined;
  const n = parseInt(a, 10);
  if (!isNaN(n) && n >= 1 && n <= RACE_ORDER.length) return RACE_ORDER[n - 1];
  if (RACES[a]) return a;
  const hits = RACE_ORDER.filter((id) => id.startsWith(a) || RACES[id].name.toLowerCase().startsWith(a));
  return hits.length === 1 ? hits[0] : undefined;
}
