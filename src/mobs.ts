// Mob templates — static game data, like rooms. Each template spawns exactly one
// mob instance (id === template key) into its `room`. The dynamic per-instance
// state (current hp, alive/dead, respawn timer) lives in the SQLite `mobs` table
// so it survives Durable Object hibernation between alarm ticks.

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
  },
];

export const MOB_BY_ID: Record<string, MobTemplate> = Object.fromEntries(
  MOB_TEMPLATES.map((m) => [m.template, m]),
);
