// Mob templates: static game data, like rooms. Each template spawns exactly one
// mob instance (id === template key) into its `room`. The dynamic per-instance
// state (current hp, alive/dead, respawn timer) lives in the SQLite `mobs` table
// so it survives Durable Object hibernation between alarm ticks.

export interface LootDrop {
  /** item id from ITEM_TEMPLATES */
  item: string;
  /** drop probability, 0..1 */
  chance: number;
}

export interface MobTemplate {
  /** unique key; also used as the mob instance id */
  template: string;
  /** display name, conventionally lowercase with an article ("a glow-rat") */
  name: string;
  desc: string;
  maxHp: number;
  minDmg: number;
  maxDmg: number;
  /** experience awarded to the killer */
  xp: number;
  /** room id this mob spawns in */
  room: string;
  /** milliseconds before a slain mob respawns */
  respawnMs: number;
  /** chance (0..1) to inflict poison when it lands a hit */
  poisonChance?: number;
  /** items this mob may drop on death */
  loot?: LootDrop[];
}

export const MOB_TEMPLATES: MobTemplate[] = [
  {
    template: "rat",
    name: "a glow-rat",
    desc: "A bloated rodent, fur matted and faintly luminous with absorbed rads.",
    maxHp: 12,
    minDmg: 1,
    maxDmg: 3,
    xp: 8,
    room: "tunnels",
    respawnMs: 20_000,
    loot: [{ item: "radcell", chance: 0.25 }],
  },
  {
    template: "scav",
    name: "a feral scavenger",
    desc: "A wiry figure in stitched rags, eyeing your gear like it's already theirs.",
    maxHp: 26,
    minDmg: 3,
    maxDmg: 6,
    xp: 22,
    room: "market",
    respawnMs: 45_000,
    loot: [
      { item: "shiv", chance: 0.4 },
      { item: "plating", chance: 0.3 },
    ],
  },
  {
    template: "drone",
    name: "a malfunctioning drone",
    desc: "A dented quadcopter sparking at the rotors, its targeting laser twitching.",
    maxHp: 18,
    minDmg: 2,
    maxDmg: 5,
    xp: 16,
    room: "roof",
    respawnMs: 30_000,
    loot: [
      { item: "radcell", chance: 0.5 },
      { item: "plating", chance: 0.3 },
    ],
  },
  {
    template: "scorpion",
    name: "a rad-scorpion",
    desc: "A dog-sized arthropod of chitin and rust, tail arched and dripping venom.",
    maxHp: 10,
    minDmg: 1,
    maxDmg: 3,
    xp: 12,
    room: "sump",
    respawnMs: 25_000,
    poisonChance: 1, // its sting always envenomates
    loot: [
      { item: "radcell", chance: 1 },
      { item: "gland", chance: 1 },
    ],
  },
  {
    template: "warden",
    name: "the warden",
    desc: "A chrome-masked jailer, broad as a doorway, keys to the maiden's chains on its belt.",
    maxHp: 18,
    minDmg: 1,
    maxDmg: 3,
    xp: 40,
    room: "holding_pit",
    respawnMs: 60_000,
    loot: [
      { item: "keycard", chance: 1 },
      { item: "radcell", chance: 0.5 },
    ],
  },

  // --- The Sunken Server Farm ---
  {
    template: "leech",
    name: "a data-leech",
    desc: "A pale, boneless thing clamped to a live rack, swollen with stolen current. It turns toward your warmth.",
    maxHp: 18,
    minDmg: 2,
    maxDmg: 5,
    xp: 16,
    room: "coldrow",
    respawnMs: 30_000,
    poisonChance: 0.2,
    loot: [{ item: "radcell", chance: 0.3 }],
  },
  {
    template: "maint",
    name: "a drowned maintenance drone",
    desc: "A three-legged service unit, half-corroded, still running its last work-order on a loop. It does not like being interrupted.",
    maxHp: 24,
    minDmg: 3,
    maxDmg: 6,
    xp: 22,
    room: "cooling",
    respawnMs: 40_000,
    loot: [
      { item: "plating", chance: 0.5 },
      { item: "helm", chance: 0.25 },
    ],
  },
  {
    template: "wraith",
    name: "a grid-wraith",
    desc: "A smear of cold light running the dead fiber, shaped almost like a person, mouthing words no one is left to hear.",
    maxHp: 26,
    minDmg: 4,
    maxDmg: 7,
    xp: 26,
    room: "fiber",
    respawnMs: 45_000,
    loot: [{ item: "radcell", chance: 0.4 }],
  },
  {
    template: "custodian",
    name: "the Custodian",
    desc: "A mass of salvaged servo-arms and server blades crouched over the last living core, guarding it with the patience of a machine that has forgotten why.",
    maxHp: 60,
    minDmg: 5,
    maxDmg: 9,
    xp: 80,
    room: "corelab",
    respawnMs: 120_000,
    loot: [
      { item: "shard", chance: 1 },
      { item: "rebar", chance: 1 },
    ],
  },

  // --- The Open Wastes ---
  {
    template: "raider",
    name: "a wastes raider",
    desc: "A scarred scavenger in scrap armor, knife already out, deciding whether you're worth the trouble.",
    maxHp: 22,
    minDmg: 3,
    maxDmg: 6,
    xp: 20,
    room: "scorch_road",
    respawnMs: 40_000,
    loot: [
      { item: "shiv", chance: 0.4 },
      { item: "radcell", chance: 0.3 },
    ],
  },
  {
    template: "enforcer",
    name: "a Cinder Front enforcer",
    desc: "A heavyset Front soldier in ash-grey plate -- more bully than soldier, but the gun on their hip is real enough.",
    maxHp: 34,
    minDmg: 4,
    maxDmg: 8,
    xp: 35,
    room: "checkpoint",
    respawnMs: 90_000,
    loot: [
      { item: "plating", chance: 0.5 },
      { item: "rebar", chance: 0.25 },
    ],
  },

  // --- The Cinder Front Stronghold ---
  {
    template: "trooper",
    name: "a Cinder Front trooper",
    desc: "A drilled Front soldier in matched ash-grey gear, moving like someone who's done this killing before.",
    maxHp: 30,
    minDmg: 4,
    maxDmg: 7,
    xp: 28,
    room: "muster",
    respawnMs: 60_000,
    loot: [
      { item: "plating", chance: 0.4 },
      { item: "radcell", chance: 0.3 },
    ],
  },
  {
    template: "zealot",
    name: "a Front zealot",
    desc: "A true believer with the ash-and-flame branded into their own skin, eyes bright with the cause and nothing behind them.",
    maxHp: 36,
    minDmg: 5,
    maxDmg: 8,
    xp: 34,
    room: "warroom",
    respawnMs: 75_000,
    poisonChance: 0.15,
    loot: [{ item: "rebar", chance: 0.4 }],
  },
  {
    template: "ashmonger",
    name: "the Ashmonger",
    desc: "Commander of the Cinder Front: a slab-shouldered butcher in scorched plate, leaning on a cleaver as long as your leg, smiling like he's already won.",
    maxHp: 100,
    minDmg: 7,
    maxDmg: 12,
    xp: 150,
    room: "dais",
    respawnMs: 180_000,
    loot: [
      { item: "cleaver", chance: 1 },
      { item: "plating", chance: 1 },
    ],
  },
];

export const MOB_BY_ID: Record<string, MobTemplate> = Object.fromEntries(
  MOB_TEMPLATES.map((m) => [m.template, m]),
);

// Dustfall's bestiary (see worlds/dustfall.jsonc, rooms.ts ROOMS_DUSTFALL). Like
// the map, it reuses the template ids and rooms so all id-based logic keeps
// working (the warden still drops the keycard, the Custodian still drops the
// quest shard, the Ashmonger is still `ashmonger`). Only the REGIONAL life is
// reskinned: the wastes wildlife and locals belong to the open salt pan, while
// the Cinder Front (trooper/zealot/enforcer/ashmonger) is the same federation-
// wide enemy in both worlds. Overrides keep this DRY: anything not named here is
// identical to the Hollow Grid version. template + room are intentionally not
// overridable, so the ids and placement can never drift.
const DUSTFALL_OVERRIDES: Record<string, Partial<Omit<MobTemplate, "template" | "room">>> = {
  rat: {
    name: "a salt-tick",
    desc: "A swollen tick the size of a fist, mouthparts crusted white with the salt it drinks from anything still warm.",
  },
  scav: {
    name: "a salt-crazed scavenger",
    desc: "A sun-blistered wanderer with cracked lips and a wild stare, already pricing the boots off your feet.",
  },
  drone: {
    name: "a derelict survey drone",
    desc: "A sand-pitted survey quadcopter still flying a long-dead mapping route, rotors screaming, gun pod twitching toward anything that moves.",
    maxHp: 22,
  },
  scorpion: {
    name: "a salt-scorpion",
    desc: "A pallid, dog-sized scorpion bleached bone-white by the pan, tail hooked high and beading venom.",
    maxDmg: 4,
  },
  warden: {
    name: "the stockade boss",
    desc: "A slab of a man in a welded mask, the stockade keys swinging at his belt, bored and cruel in equal measure.",
  },
  leech: {
    name: "a sand-leech",
    desc: "A pale, boneless thing fused to a half-buried rack, bloated on the last trickle of current. It turns toward your heat.",
  },
  maint: {
    name: "a seized maintenance unit",
    desc: "A three-legged service drone half-fused with rust and grit, grinding through its final work-order on a loop. It resents the interruption.",
  },
  wraith: {
    name: "a grid-wraith",
    desc: "A smear of cold light walking the dead trunk lines, almost person-shaped, mouthing signals to a network that stopped listening a long time ago.",
  },
  custodian: {
    desc: "A knot of salvaged servo-arms and server blades hunched over the last living core, guarding the buried relay with the patience of a machine that has forgotten why.",
  },
  raider: {
    name: "a bone-road raider",
    desc: "A scarred marauder in plate cut from road-signs and bone, blade already drawn, doing the math on whether you're worth the trouble.",
  },
};

export const MOBS_DUSTFALL: MobTemplate[] = MOB_TEMPLATES.map((m) => ({
  ...m,
  ...DUSTFALL_OVERRIDES[m.template],
}));

// Pick a world's bestiary by key (set per deployment via WORLD_MAP, same as the
// map). Unknown or unset falls back to the Hollow Grid.
export function mobsFor(key?: string): MobTemplate[] {
  return key?.trim().toLowerCase() === "dustfall" ? MOBS_DUSTFALL : MOB_TEMPLATES;
}
