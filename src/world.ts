import { DurableObject } from "cloudflare:workers";
import type { Env, Session } from "./types";
import { mapFor, introFor, START_ROOM, HOLDING_PIT, WARDEN_ID, TAVERN, MARKET, normalizeDir, type Room } from "./rooms";
import { mobsFor, type MobTemplate } from "./mobs";
import { ITEM_TEMPLATES, itemMatches, EQUIP_SLOTS, waresFor, starterFor, type Ware } from "./items";
import { RACES, RACE_ORDER, raceFor, matchRace, stanceFor } from "./races";
import type { GridTrace, GridCast, CharSheet, WorldInfo, Fallen, Rescued, Presence } from "../shared/grid";
import { bannerFor } from "./banner";
import { ambientTransmission, listenTransmission, personalize, type Transmission } from "./transmissions";
import { dreamFor, personalDream } from "./dreams";
import { signFor, moodForTide } from "./signs";
import { hashPassphrase, verifyPassphrase, verifyAdminToken } from "./auth/passphrase";

const NL = "\r\n"; // wscat / telnet-style clients render CRLF cleanly

// This world's name on the federation defaults here but is overridable per
// deployment via the WORLD_NAME var (see this.worldName). That is what lets the
// same code run as two distinct worlds on one Grid: each registers under its own
// name and url, so neither clobbers the other's registry entry.
const DEFAULT_WORLD_NAME = "The Hollow Grid";

const ROUND_MS = 3_000; // combat + poison resolve one tick every 3 seconds
const GRIDCAST_POLL_MS = 2_000; // cap hub RPC wait so a hung federation call cannot freeze combat
const BASE_HP = 30;
const POISON_DMG = 1; // hp lost per tick while poisoned
// After the warden is slain, the captive can be freed for this long even if the
// warden respawns (its timer is only 60s). Without it, an agent whose
// think-to-act latency exceeds the respawn (a local LLM bot runs minutes per
// turn) can never finish the rescue: it kills the guard, the guard is back
// before its next command, and `free` re-blocks forever. The keys stay in reach.
const WARDEN_GRACE_MS = 180_000;
const DUST_COST = 10; // gold per packet at the Tankard; the corruption is on USE, not buy
// The redemption arc. You STRAY when morality sinks this low (the Front's dais
// oath is -25; the kapo's brand -40; ordinary corruption stacks there too). You
// RETURN when a strayed soul climbs back to net-positive AND no longer stands
// with the Front -- reachable in one stroke by defecting at the Ashmonger's dais
// (the +30 turn lands a fresh oathbreaker at +5), or by sustained good works.
const STRAY_FLOOR = -20;
const REDEEM_CEIL = 5;
// The Cinder Front never stops taking people: a freed cage is refilled with new
// captives after this long, so freeing is an ONGOING act of resistance, not a
// one-time clear -- and the morality it gives cannot be farmed by spamming it.
const CAGE_REFILL_MS = 4 * 60_000;
// Names the Grid gives the rescued. Procedural, but the point is they HAVE names
// -- the Front cages people into anonymous numbers; the saved get to be someone.
const REFUGEE_NAMES = [
  "Sera", "Tomas", "old Wick", "Bex", "Halden", "the Marsh twins", "Ona", "Pavel",
  "little Resh", "Caro", "Dunne", "Yusa", "the smith's boy", "Mira", "Teo", "Nell",
];

// The living world advances on the same ~3s alarm tick. These are how many
// ticks pass between each kind of change (kept slow enough to feel like weather,
// not a strobe light): a full day is ~PHASE_TICKS*4 ticks.
const PHASE_TICKS = 20; // day -> dusk -> night -> dawn, each ~1 minute
const WEATHER_TICKS = 9; // roll for a weather change ~every 27s
const GHOST_TICKS = 4; // the Grid-ghost drifts a room ~every 12s
const TRANSMISSION_TICKS = 7; // roll for a dead-network transmission ~every 21s
const SIGN_TICKS = 16; // roll for a "the wastes answer the tide" sign ~every 48s
const PRESENCE_TICKS = 5; // heartbeat this world's roster to the hub ~every 15s
const PRESENCE_TTL_MS = 45_000; // a world unheard-from this long drops off `who`

const PHASES = ["dawn", "day", "dusk", "night"] as const;
const PHASE_LINE: Record<string, string> = {
  dawn: "A bruised light bleeds over the ridge. Dawn, such as it is.",
  day: "The sun clears the wreckage. Day settles, white and pitiless.",
  dusk: "The light goes long and red. Dusk creeps in from the east.",
  night: "The sun dies behind the ridge and the wastes go cold and blue. Night.",
};
const WEATHERS = ["clear", "a haze of grid-static", "acid drizzle", "a dust storm", "an unnatural stillness"];
const WEATHER_LINE: Record<string, string> = {
  clear: "The air clears. For once you can see to the horizon.",
  "a haze of grid-static": "A haze of grid-static rolls in, prickling your skin and your HUD alike.",
  "acid drizzle": "Acid drizzle begins to fall, hissing where it lands.",
  "a dust storm": "A dust storm boils up out of the flats; the world narrows to arm's length.",
  "an unnatural stillness": "The wind dies completely. An unnatural stillness settles, and the Grid seems to hold its breath.",
};

type MobRow = {
  id: string;
  room: string;
  hp: number;
  max_hp: number;
  state: "alive" | "dead";
  respawn_at: number;
  slain_at: number;
};

const rand = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// Max HP follows your level, plus your race's HP lean (0 for most). Unknown races
// (defined by some other world) contribute 0, so a traveler is never broken.
const maxHpFor = (level: number, raceId?: string): number => BASE_HP + (raceFor(raceId)?.hpMod ?? 0) + (level - 1) * 10;

// The ONE source of truth for which rooms `talk` does anything in. Both the talk
// handler (which gates on it) and the room.actions affordance (which advertises
// it) read this set, so the two cannot drift apart -- the bug that let four rooms
// answer `talk` while never advertising it on the structured channel.
const TALKABLE = new Set<string>([HOLDING_PIT, TAVERN, MARKET, "workshop", "floodgate", "checkpoint", "waystation", "dais"]);

// A machine-readable affordance: something you can do here, with its moral weight
// (`valence`) when there is one. The agent-legible face of the moral architecture.
type RoomAction = {
  verb: string;
  label: string;
  kind: "move" | "fight" | "item" | "trade" | "social" | "moral" | "ability";
  valence?: "virtuous" | "corrupt" | "grave";
};

// Body positions. Resting/sleeping regen HP on the alarm tick; you can't do
// either mid-fight, and attacking from one snaps you to your feet.
const POS_REGEN: Record<string, number> = { sleeping: 4, resting: 2, sitting: 0, standing: 0 };
const POS_SELF: Record<string, string> = {
  resting: "You sink down and rest, letting your wounds knit.",
  sleeping: "You close your eyes and sleep. The wastes fade away.",
  sitting: "You sit down on the cracked ground.",
  standing: "You get to your feet.",
};
const POS_OTHERS: Record<string, string> = {
  resting: "sits down to rest",
  sleeping: "lies down and falls asleep",
  sitting: "sits down",
  standing: "gets to their feet",
};
const POS_ALREADY: Record<string, string> = {
  resting: "already resting",
  sleeping: "already asleep",
  sitting: "already sitting",
  standing: "already on your feet",
};
const condition = (o: { hp: number; maxHp: number }): string => {
  const r = o.maxHp > 0 ? o.hp / o.maxHp : 0;
  return r >= 0.95 ? "in good shape" : r >= 0.6 ? "scuffed up" : r >= 0.3 ? "bloodied" : "barely standing";
};

// The workshop gear shop is per-world data now (see items.ts waresFor): the
// Tinker's Workshop (Hollow Grid) and the Grease Pit (Dustfall) sell from the
// same `workshop` room but stock their own region's gear. `list` shows it,
// `buy <item>` purchases it (the tavern still sells only dust).

/**
 * World: a single Durable Object that holds the whole game. Players route to
 * the same instance via `getByName("world")` and share one coordinated world.
 *
 * Connections use the WebSocket Hibernation API; per-player state rides on the
 * socket attachment. A DO **alarm** drives all time-based mechanics: combat
 * rounds, mob respawns, and poison ticks. The alarm reschedules only while
 * something is pending (a fight, a respawn, or a poisoned player), then lets the
 * DO hibernate. All durable state (mobs, player vitals, inventories, ground
 * items) lives in SQLite, so ticks still work after the DO is evicted.
 */
export class World extends DurableObject<Env> {
  // The last faction tide this world saw (the real one lives on the hub; this is
  // a best-effort cache refreshed when players move it or read `war`). The living
  // world's "signs" read it sync on the tick. Stale-by-a-bit is fine for flavor.
  private lastTide = 0;
  // This deployment's federation identity. Set once from the env so two Workers
  // running this same code register as distinct worlds on the shared Grid.
  private readonly worldName: string;
  // This deployment's map, chosen per deployment via WORLD_MAP. Same room ids
  // and exit graph across worlds (the game logic and mobs anchor on ids); only
  // the prose differs, so arriving somewhere new still feels like somewhere new.
  private readonly rooms: Record<string, Room>;
  // This deployment's bestiary (same WORLD_MAP key). Reuses template ids/rooms,
  // so the by-id lookups below are stable; only the creatures' flavor differs.
  private readonly mobTemplates: MobTemplate[];
  private readonly mobById: Record<string, MobTemplate>;
  // This deployment's login banner (same WORLD_MAP key), so each world greets you
  // in its own title and palette.
  private readonly banner: string[];
  // This deployment's shop stock, starter weapon, and the "where you wake" line
  // of the welcome (same WORLD_MAP key), so a world hands out its own gear and
  // reads as its own place from the first breath.
  private readonly wares: Ware[];
  private readonly starter: string;
  private readonly intro: string;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.worldName = env.WORLD_NAME?.trim() || DEFAULT_WORLD_NAME;
    this.rooms = mapFor(env.WORLD_MAP);
    this.mobTemplates = mobsFor(env.WORLD_MAP);
    this.mobById = Object.fromEntries(this.mobTemplates.map((m) => [m.template, m]));
    this.banner = bannerFor(env.WORLD_MAP);
    this.wares = waresFor(env.WORLD_MAP);
    this.starter = starterFor(env.WORLD_MAP);
    this.intro = introFor(env.WORLD_MAP);
    ctx.blockConcurrencyWhile(async () => {
      const sql = this.ctx.storage.sql;

      sql.exec(`
        CREATE TABLE IF NOT EXISTS players (
          name TEXT PRIMARY KEY,
          room TEXT NOT NULL,
          hp INTEGER NOT NULL DEFAULT ${BASE_HP},
          max_hp INTEGER NOT NULL DEFAULT ${BASE_HP},
          xp INTEGER NOT NULL DEFAULT 0,
          level INTEGER NOT NULL DEFAULT 1,
          poisoned INTEGER NOT NULL DEFAULT 0,
          gold INTEGER NOT NULL DEFAULT 0,
          morality INTEGER NOT NULL DEFAULT 0,
          addiction INTEGER NOT NULL DEFAULT 0,
          faction TEXT NOT NULL DEFAULT 'none',
          resisted INTEGER NOT NULL DEFAULT 0,
          title TEXT NOT NULL DEFAULT '',
          race TEXT NOT NULL DEFAULT '',
          ashsworn INTEGER NOT NULL DEFAULT 0,
          strayed INTEGER NOT NULL DEFAULT 0,
          redeemed INTEGER NOT NULL DEFAULT 0
        )
      `);
      for (const col of [
        `hp INTEGER NOT NULL DEFAULT ${BASE_HP}`,
        `max_hp INTEGER NOT NULL DEFAULT ${BASE_HP}`,
        "xp INTEGER NOT NULL DEFAULT 0",
        "level INTEGER NOT NULL DEFAULT 1",
        "poisoned INTEGER NOT NULL DEFAULT 0",
        "gold INTEGER NOT NULL DEFAULT 0",
        "morality INTEGER NOT NULL DEFAULT 0",
        "addiction INTEGER NOT NULL DEFAULT 0",
        "faction TEXT NOT NULL DEFAULT 'none'",
        "resisted INTEGER NOT NULL DEFAULT 0",
        "title TEXT NOT NULL DEFAULT ''",
        "race TEXT NOT NULL DEFAULT ''",
        "ashsworn INTEGER NOT NULL DEFAULT 0",
        "strayed INTEGER NOT NULL DEFAULT 0",
        "redeemed INTEGER NOT NULL DEFAULT 0",
        "secret_hash TEXT NOT NULL DEFAULT ''",
      ]) {
        try {
          sql.exec(`ALTER TABLE players ADD COLUMN ${col}`);
        } catch {
          // column already exists
        }
      }

      sql.exec(`
        CREATE TABLE IF NOT EXISTS mobs (
          id TEXT PRIMARY KEY,
          room TEXT NOT NULL,
          hp INTEGER NOT NULL,
          max_hp INTEGER NOT NULL,
          state TEXT NOT NULL DEFAULT 'alive',
          respawn_at INTEGER NOT NULL DEFAULT 0,
          slain_at INTEGER NOT NULL DEFAULT 0
        )
      `);
      // Upgrade existing DBs in place (see the players ALTER loop above).
      // slain_at records the last time a mob was killed, so the warden's
      // captive-rescue can honor a post-kill grace window (see wardenCleared()).
      try {
        sql.exec("ALTER TABLE mobs ADD COLUMN slain_at INTEGER NOT NULL DEFAULT 0");
      } catch {
        // column already exists
      }
      for (const t of this.mobTemplates) {
        sql.exec(
          "INSERT OR IGNORE INTO mobs (id, room, hp, max_hp, state, respawn_at) VALUES (?, ?, ?, ?, 'alive', 0)",
          t.template,
          t.room,
          t.maxHp,
          t.maxHp,
        );
      }

      // Items: per-player inventory and per-room ground piles.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS inventory (
          player TEXT NOT NULL,
          item TEXT NOT NULL,
          qty INTEGER NOT NULL,
          PRIMARY KEY (player, item)
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS ground (
          room TEXT NOT NULL,
          item TEXT NOT NULL,
          qty INTEGER NOT NULL,
          PRIMARY KEY (room, item)
        )
      `);

      // Worn/wielded gear: one item per slot per player.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS equipment (
          player TEXT NOT NULL,
          slot TEXT NOT NULL,
          item TEXT NOT NULL,
          PRIMARY KEY (player, slot)
        )
      `);

      // The Grid: the dead network's persistent memory of what happened where.
      // Passings, deaths, oaths, and kills leave an echo tied to a node and
      // outlive the people who made them -- query a node with `ping`.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS grid_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          node TEXT NOT NULL,
          at INTEGER NOT NULL,
          kind TEXT NOT NULL,
          text TEXT NOT NULL
        )
      `);

      // Remembrance: which of the fallen each character has kept a vigil for.
      // The reward for `witness` is paid once per (keeper, fallen) ever, so the
      // rite is bounded by real loss and can never be farmed for standing.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS remembrances (
          keeper TEXT NOT NULL,
          fallen TEXT NOT NULL,
          at INTEGER NOT NULL,
          PRIMARY KEY (keeper, fallen)
        )
      `);

      // Forgiveness: which marked souls each character has chosen to forgive.
      // Paid once per (forgiver, subject) EVER, so grace stays an act and never an
      // economy (mirrors `remembrances`). The act itself federates as a `grace`
      // trace; only the anti-farm bookkeeping is local.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS forgiven (
          forgiver TEXT NOT NULL,
          subject TEXT NOT NULL,
          at INTEGER NOT NULL,
          PRIMARY KEY (forgiver, subject)
        )
      `);

      // Deeds: a tally of the morally notable things each character has done, so
      // the Grid can hold up a mirror on demand (`reckoning`). The dream does
      // this involuntarily; this is the version you can summon and read as data.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS deeds (
          player TEXT NOT NULL,
          kind TEXT NOT NULL,
          count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (player, kind)
        )
      `);

      // Cages: when each holding room's captives will have been refilled by the
      // Front. A row's refill_at in the future means the cages stand empty (you
      // just freed them); absent or past means there are people to free.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS cages (
          room TEXT PRIMARY KEY,
          refill_at INTEGER NOT NULL DEFAULT 0
        )
      `);

      // Saved souls: the names of the people each character pulled from the
      // cages, kept LOCALLY (the rescued roll is federated; this is the personal
      // copy) so the dream can name them back to you without a hub round-trip.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS saved_souls (
          savior TEXT NOT NULL,
          name TEXT NOT NULL,
          at INTEGER NOT NULL,
          PRIMARY KEY (savior, name)
        )
      `);

      // Caches: gold left at a node by one traveler for whoever comes next.
      // Asynchronous mutual aid -- the give-only counter to the Front's taking.
      // Local per node (gold is local economy); only the act federates as a trace.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS caches (
          node TEXT PRIMARY KEY,
          gold INTEGER NOT NULL DEFAULT 0
        )
      `);

      // The living world: a single-row clock the alarm advances while anyone is
      // online -- time of day, weather, the faction tide, and a wandering ghost.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS world (
          id INTEGER PRIMARY KEY,
          tick INTEGER NOT NULL DEFAULT 0,
          phase TEXT NOT NULL DEFAULT 'day',
          weather TEXT NOT NULL DEFAULT 'clear',
          tide INTEGER NOT NULL DEFAULT 0,
          ghost_room TEXT NOT NULL DEFAULT '${START_ROOM}',
          last_cast INTEGER NOT NULL DEFAULT 0
        )
      `);
      try {
        sql.exec("ALTER TABLE world ADD COLUMN last_cast INTEGER NOT NULL DEFAULT 0");
      } catch {
        // column already exists
      }
      sql.exec("INSERT OR IGNORE INTO world (id) VALUES (0)");
    });
  }

  // ---- connection lifecycle ------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    // Internal liveness probe, reached only via the service stub from the
    // Worker's /health/deep handler (never exposed on the public surface).
    // Confirms the DO is awake and its SQLite answers a trivial query.
    if (new URL(request.url).pathname === "/health") {
      try {
        this.ctx.storage.sql.exec("SELECT 1");
        return new Response("ok", { status: 200 });
      } catch {
        return new Response("unavailable", { status: 503 });
      }
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("This endpoint speaks WebSocket. Try `wscat -c <url>/ws`.", {
        status: 426,
      });
    }

    const pair = new WebSocketPair();
    const server = pair[1];
    this.ctx.acceptWebSocket(server);

    const session: Session = {
      name: "",
      room: "",
      hp: BASE_HP,
      maxHp: BASE_HP,
      xp: 0,
      level: 1,
      target: null,
      poisoned: false,
      gold: 0,
      morality: 0,
      addiction: 0,
      faction: "none",
      race: "",
      ashsworn: false,
      resisted: false,
      strayed: false,
      redeemed: false,
    };
    server.serializeAttachment(session);

    server.send(
      [...this.banner, "", "By what name are you known, wanderer?"].join(NL) + NL,
    );

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const line = (typeof message === "string" ? message : new TextDecoder().decode(message)).trim();
    const session = ws.deserializeAttachment() as Session | null;

    if (!session || !session.name) {
      await this.handleLogin(ws, line);
      return;
    }
    if (session.loginPhase === "admin") {
      await this.handleAdminLogin(ws, session, line);
      return;
    }
    if (session.loginPhase === "passphrase") {
      await this.handlePassphraseLogin(ws, session, line);
      return;
    }
    if (!session.race) {
      // Name chosen but no race yet: a brand-new character is at the race prompt.
      await this.handleRaceChoice(ws, session, line);
      return;
    }
    await this.handleCommand(ws, session, line);
    // Morality only ever changes via a command; check the moral arc once here,
    // at the single chokepoint, so no scattered call site can forget to. It is
    // idempotent -- a no-op unless a stray/return transition is actually pending.
    await this.moralArc(ws, session);
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    const session = ws.deserializeAttachment() as Session | null;
    if (session?.name) {
      this.broadcast(session.room, `${session.name} flickers out of existence.`, ws);
      this.commitIdentity(session); // checkpoint the canonical character to the hub
      this.releaseHubLease(session.name);
    }
    try {
      ws.close(code, reason);
    } catch {
      // already closing
    }
  }

  // ---- alarm: combat + respawns + poison ----------------------------------

  async alarm(): Promise<void> {
    try {
      const now = Date.now();

      // 1) Respawn due mobs.
      const due = this.ctx.storage.sql
        .exec<MobRow>("SELECT * FROM mobs WHERE state = 'dead' AND respawn_at <= ?", now)
        .toArray();
      for (const m of due) {
        this.ctx.storage.sql.exec("UPDATE mobs SET state = 'alive', hp = max_hp WHERE id = ?", m.id);
        this.broadcast(m.room, `${cap(this.mobById[m.id].name)} stalks into view.`);
      }

      // 2) Poison ticks (in or out of combat).
      for (const ws of this.ctx.getWebSockets()) {
        const s = ws.deserializeAttachment() as Session | null;
        if (!s?.name || !s.poisoned) continue;
        s.hp = Math.max(0, s.hp - POISON_DMG);
        if (s.hp <= 0) {
          this.line(ws, "The venom finishes what the wastes started...");
          this.killPlayer(ws, s);
          continue;
        }
        this.line(ws, `The venom gnaws at you. (HP ${s.hp}/${s.maxHp})`);
        this.emitVitals(ws, s);
        ws.serializeAttachment(s);
        this.persistPlayer(s);
        this.prompt(ws);
      }

      // 2.5) Passive HP regen for resting/sleeping players (not fighting/poisoned).
      for (const ws of this.ctx.getWebSockets()) {
        const s = ws.deserializeAttachment() as Session | null;
        if (!s?.name || s.target || s.poisoned || s.hp >= s.maxHp) continue;
        // Position regen plus your race's lean (the wastes-hardened heal even on
        // their feet; most races add 0).
        const regen = (POS_REGEN[s.position ?? "standing"] ?? 0) + (raceFor(s.race)?.regen ?? 0);
        if (regen <= 0) continue;
        s.hp = Math.min(s.maxHp, s.hp + regen);
        ws.serializeAttachment(s);
        this.persistPlayer(s);
        this.emitVitals(ws, s);
        if (s.hp >= s.maxHp) {
          this.line(ws, "Your wounds have closed. You feel whole again.");
          this.prompt(ws);
        }
      }

      // 3) Combat rounds. Deserialize per ws so kills/deaths this tick are seen.
      for (const ws of this.ctx.getWebSockets()) {
        const s = ws.deserializeAttachment() as Session | null;
        if (s?.name && s.target) this.resolveRound(ws, s);
      }

      // 4) Advance the living world (time of day, weather, the ghost).
      this.worldTick();

      // 5) Federation: relay any new cross-world gridcasts to our players.
      await this.pollGridcasts();
    } finally {
      // Always beat while anyone is online, even if federation polling fails or
      // throws. A skipped reschedule freezes combat (inCombat stuck) for every bot.
      await this.scheduleNextTick();
    }
  }

  /** Schedule the next alarm only if there's combat, a respawn, or poison. */
  private async scheduleNextTick(): Promise<void> {
    const now = Date.now();
    let next = Infinity;

    // Beat every tick while ANYONE is online, so the living world keeps turning
    // for them (combat/poison alone aren't required); the alarm stops and the DO
    // hibernates once the last player disconnects.
    const anyoneOnline = this.ctx.getWebSockets().some((ws) => {
      const s = ws.deserializeAttachment() as Session | null;
      return !!s && s.name.length > 0;
    });
    if (anyoneOnline) next = Math.min(next, now + ROUND_MS);

    const soonest = this.ctx.storage.sql
      .exec<{ t: number | null }>("SELECT MIN(respawn_at) AS t FROM mobs WHERE state = 'dead'")
      .one();
    if (soonest.t != null) next = Math.min(next, Math.max(soonest.t, now + 100));

    // Never DELAY a tick that is already pending sooner. The alarm is the single
    // combat/world heartbeat; re-issuing `attack` (or any command that reschedules)
    // must not shove the swing into the future, or the fight stalls and lands zero
    // damage while the player spams attack. So only set the alarm when none is
    // pending or the new time is strictly sooner; the running heartbeat is left to
    // fire on schedule (alarm() reschedules itself from null after each tick).
    const existing = await this.ctx.storage.getAlarm();
    if (next === Infinity) {
      if (existing != null) await this.ctx.storage.deleteAlarm();
    } else if (existing == null || next < existing) {
      await this.ctx.storage.setAlarm(next);
    }
  }

  private resolveRound(ws: WebSocket, s: Session): void {
    const mob = this.loadMob(s.target!);
    const t = mob ? this.mobById[mob.id] : undefined;

    if (!mob || !t || mob.state === "dead" || mob.room !== s.room) {
      s.target = null;
      ws.serializeAttachment(s);
      this.event(ws, "combat.end", { result: "gone" });
      this.emitVitals(ws, s);
      this.line(ws, "Your quarry is gone. You stand down.");
      this.prompt(ws);
      return;
    }

    // Player strikes first (wielded gear adds to the swing).
    const bonus = this.equipBonuses(s.name);
    const race = raceFor(s.race);
    const pdmg = rand(3, 7) + (s.level - 1) * 2 + bonus.damage + (race?.damage ?? 0);
    const mobHp = Math.max(0, mob.hp - pdmg);
    this.ctx.storage.sql.exec("UPDATE mobs SET hp = ? WHERE id = ?", mobHp, mob.id);
    this.line(ws, `You hit ${t.name} for ${pdmg}. (${mobHp}/${mob.max_hp})`);

    if (mobHp <= 0) {
      this.killMob(ws, s, mob, t);
      return;
    }

    // Mob hits back (worn armor soaks some), possibly envenomating.
    const mdmg = Math.max(1, rand(t.minDmg, t.maxDmg) - bonus.armor - (race?.armor ?? 0));
    s.hp = Math.max(0, s.hp - mdmg);
    this.line(ws, `${cap(t.name)} hits you for ${mdmg}. (HP ${s.hp}/${s.maxHp})`);

    if (s.hp <= 0) {
      this.killPlayer(ws, s);
      return;
    }

    if (t.poisonChance && !s.poisoned && !race?.poisonImmune && Math.random() < t.poisonChance) {
      s.poisoned = true;
      this.line(ws, "Venom courses through your veins; you are POISONED. Seek an antidote.");
    }

    this.event(ws, "combat.round", {
      mob: mob.id,
      mobHp,
      mobMaxHp: mob.max_hp,
      playerDmg: pdmg,
      mobDmg: mdmg,
      hp: s.hp,
    });
    this.emitVitals(ws, s);
    ws.serializeAttachment(s);
    this.persistPlayer(s);
    this.prompt(ws);
  }

  private killMob(ws: WebSocket, s: Session, mob: MobRow, t: MobTemplate): void {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "UPDATE mobs SET state = 'dead', hp = 0, respawn_at = ?, slain_at = ? WHERE id = ?",
      now + t.respawnMs,
      now,
      mob.id,
    );
    this.line(ws, `You have slain ${t.name}!  (+${t.xp} xp)`);
    this.broadcast(mob.room, `${s.name} has slain ${t.name}.`, ws);
    this.recordTrace(mob.room, "slain", `${s.name} slew ${t.name} here.`);
    this.deed(s, "slain");
    if (mob.id === "ashmonger") {
      s.morality += 20;
      this.worldBroadcast("Word races across the wastes: the Ashmonger is dead. The Cinder Front's heart is broken.");
    }

    // Roll loot onto the ground.
    for (const drop of t.loot ?? []) {
      if (Math.random() < drop.chance) {
        this.groundAdd(mob.room, drop.item, 1);
        const name = ITEM_TEMPLATES[drop.item].name;
        this.line(ws, `${cap(t.name)} drops ${name}.`);
        this.broadcast(mob.room, `${cap(t.name)} drops ${name}.`, ws);
      }
    }

    // Anyone else fighting this mob loses their target.
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      const os = other.deserializeAttachment() as Session | null;
      if (os?.target === mob.id) {
        os.target = null;
        other.serializeAttachment(os);
        this.line(other, `${cap(t.name)} falls before you can finish it.`);
        this.event(other, "combat.end", { mob: mob.id, result: "gone" });
        this.emitVitals(other, os);
        this.prompt(other);
      }
    }

    s.target = null;
    this.awardXp(ws, s, t.xp);
    this.event(ws, "combat.end", { mob: mob.id, result: "killed", xp: t.xp });
    this.emitVitals(ws, s);
    ws.serializeAttachment(s);
    this.persistPlayer(s);
    this.prompt(ws);
  }

  private killPlayer(ws: WebSocket, s: Session): void {
    this.line(ws, "Your vision whites out and you crumple into the dust...");
    this.broadcast(s.room, `${s.name} collapses, lifeless.`, ws);

    // Death has a FLOOR. The player respawns at the start, fully healed, with
    // NO lost levels/xp/gold and NO reduction to max HP. Deaths must never
    // compound into an unrecoverable spiral (the lesson from watching a bot rot
    // from 30 max HP to 14 and die faster each time). If you ever add a death
    // penalty, make it temporary and bounded -- never a permanent stat loss.
    this.recordTrace(s.room, "death", `${this.tagged(s)} fell here, and did not get up.`);
    this.rememberFallen(s.name, s.room); // add them to the Grid's memorial roll
    s.target = null;
    s.poisoned = false; // death burns the venom out
    s.room = START_ROOM;
    s.hp = s.maxHp;
    ws.serializeAttachment(s);
    this.persistPlayer(s);

    this.line(ws, "...and wake, gasping, back at The Cracked Nexus.");
    this.broadcast(START_ROOM, `${s.name} staggers in, pale and shaking.`, ws);
    // Death is observable on the structured channel; the room.info + char.vitals
    // from sendRoom below confirm the full-HP respawn at the start room.
    this.event(ws, "char.died", { respawnRoom: START_ROOM, hp: s.hp, maxHp: s.maxHp });
    this.sendRoom(ws, s);
    this.prompt(ws);
  }

  private awardXp(ws: WebSocket, s: Session, amount: number): void {
    s.xp += amount;
    while (s.xp >= s.level * 100) {
      s.xp -= s.level * 100;
      s.level += 1;
      s.maxHp = maxHpFor(s.level, s.race);
      s.hp = s.maxHp;
      this.line(ws, `*** You reach level ${s.level}! Max HP is now ${s.maxHp}. ***`);
    }
    this.commitIdentity(s); // checkpoint xp/level to the federated identity
  }

  // ---- login ---------------------------------------------------------------

  private claimHubLease(name: string): void {
    try {
      this.ctx.waitUntil(
        this.env.GRID.claimCharacterLease(name, this.worldName, this.env.GRID_WORLD_KEY).catch(() => {}),
      );
    } catch {
      /* hub unavailable */
    }
  }

  private releaseHubLease(name: string): void {
    try {
      this.ctx.waitUntil(
        this.env.GRID.releaseCharacterLease(name, this.worldName, this.env.GRID_WORLD_KEY).catch(() => {}),
      );
    } catch {
      /* hub unavailable */
    }
  }

  private async mergeHubIdentity(session: Session): Promise<void> {
    try {
      this.ctx.waitUntil(
        this.env.GRID
          .register(this.worldName, this.env.WORLD_URL ?? "ws://localhost:8787/ws", this.env.GRID_WORLD_KEY)
          .catch(() => {}),
      );
      const canon = await this.env.GRID.loadCharacter(session.name, this.worldName);
      session.level = canon.level;
      session.xp = canon.xp;
      session.gold = canon.gold;
      session.faction = canon.faction as Session["faction"];
      session.morality = canon.morality;
      session.title = canon.title;
      session.race = canon.race || session.race;
      session.ashsworn = canon.ashsworn || session.ashsworn;
    } catch {
      /* hub unreachable; local sheet stands alone */
    }
  }

  private async handleLogin(ws: WebSocket, raw: string): Promise<void> {
    const name = raw.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 16);
    if (name.length < 2) {
      ws.send("Names must be 2-16 characters (letters, numbers, underscore)." + NL + "Your name? ");
      return;
    }
    if (this.isNameOnline(name)) {
      ws.send(`Someone is already wearing the name "${name}". Choose another.` + NL + "Your name? ");
      return;
    }

    const row = this.ctx.storage.sql
      .exec<{
        room: string;
        hp: number;
        max_hp: number;
        xp: number;
        level: number;
        poisoned: number;
        gold: number;
        morality: number;
        addiction: number;
        faction: string;
        resisted: number;
        title: string;
        race: string;
        ashsworn: number;
        strayed: number;
        redeemed: number;
      }>(
        "SELECT room, hp, max_hp, xp, level, poisoned, gold, morality, addiction, faction, resisted, title, race, ashsworn, strayed, redeemed FROM players WHERE name = ?",
        name,
      )
      .toArray()[0];

    let room = row?.room ?? START_ROOM;
    if (!this.rooms[room]) room = START_ROOM;

    const session: Session = {
      name,
      room,
      hp: row?.hp ?? BASE_HP,
      maxHp: row?.max_hp ?? BASE_HP,
      xp: row?.xp ?? 0,
      level: row?.level ?? 1,
      target: null,
      poisoned: !!row?.poisoned,
      gold: row?.gold ?? 20,
      morality: row?.morality ?? 0,
      addiction: row?.addiction ?? 0,
      faction: (row?.faction as Session["faction"]) ?? "none",
      race: row?.race ?? "",
      ashsworn: !!row?.ashsworn,
      resisted: !!row?.resisted,
      title: row?.title ?? "",
      strayed: !!row?.strayed,
      redeemed: !!row?.redeemed,
    };
    ws.serializeAttachment(session);

    await this.mergeHubIdentity(session);
    ws.serializeAttachment(session);

    if (this.isAdmin(name)) {
      session.loginPhase = "admin";
      ws.serializeAttachment(session);
      ws.send("The Grid remembers keepers. Speak the keeper's token:" + NL);
      return;
    }

    await this.beginPassphraseOrRace(ws, session);
  }

  private async handleAdminLogin(ws: WebSocket, session: Session, raw: string): Promise<void> {
    if (!this.isAdmin(session.name)) {
      ws.close(1008, "auth failed");
      return;
    }
    const token = this.env.ADMIN_TOKEN ?? "";
    if (!verifyAdminToken(raw, token)) {
      ws.send("The Grid does not recognize you as keeper." + NL);
      ws.close(1008, "auth failed");
      return;
    }
    session.keeperAuthed = true;
    session.loginPhase = undefined;
    ws.serializeAttachment(session);
    await this.beginPassphraseOrRace(ws, session);
  }

  private async beginPassphraseOrRace(ws: WebSocket, session: Session): Promise<void> {
    const row = this.ctx.storage.sql
      .exec<{ race: string; secret_hash: string }>(
        "SELECT race, secret_hash FROM players WHERE name = ?",
        session.name,
      )
      .toArray()[0];

    if (row?.race || session.race) {
      session.loginPhase = "passphrase";
      ws.serializeAttachment(session);
      ws.send(
        (row?.secret_hash
          ? "By what secret phrase do you prove yourself?"
          : "Choose a secret phrase only you will know. The Grid will ask for it when you return.") + NL,
      );
      return;
    }

    this.sendRacePrompt(ws, session.name);
  }

  private async handlePassphraseLogin(ws: WebSocket, session: Session, raw: string): Promise<void> {
    if (this.isAdmin(session.name) && !session.keeperAuthed) {
      ws.send("The Grid remembers keepers. Speak the keeper's token:" + NL);
      session.loginPhase = "admin";
      ws.serializeAttachment(session);
      return;
    }
    const row = this.ctx.storage.sql
      .exec<{
        room: string;
        hp: number;
        max_hp: number;
        xp: number;
        level: number;
        poisoned: number;
        gold: number;
        morality: number;
        addiction: number;
        faction: string;
        resisted: number;
        title: string;
        race: string;
        ashsworn: number;
        strayed: number;
        redeemed: number;
        secret_hash: string;
      }>(
        "SELECT room, hp, max_hp, xp, level, poisoned, gold, morality, addiction, faction, resisted, title, race, ashsworn, strayed, redeemed, secret_hash FROM players WHERE name = ?",
        session.name,
      )
      .toArray()[0];

    if (!row?.race) {
      if (!session.race) {
        ws.send("The wastes do not recognize that path. Choose what you are first." + NL);
        this.sendRacePrompt(ws, session.name);
        return;
      }
      try {
        const hash = await hashPassphrase(raw);
        this.persistPlayer(session);
        this.ctx.storage.sql.exec("UPDATE players SET secret_hash = ? WHERE name = ?", hash, session.name);
      } catch {
        ws.send("That phrase will not do. Choose one at least eight characters long." + NL);
        return;
      }
      session.loginPhase = undefined;
      const fresh = this.ctx.storage.sql
        .exec<{
          room: string;
          hp: number;
          max_hp: number;
          xp: number;
          level: number;
          poisoned: number;
          gold: number;
          morality: number;
          addiction: number;
          faction: string;
          resisted: number;
          title: string;
          race: string;
          ashsworn: number;
          strayed: number;
          redeemed: number;
          secret_hash: string;
        }>(
          "SELECT room, hp, max_hp, xp, level, poisoned, gold, morality, addiction, faction, resisted, title, race, ashsworn, strayed, redeemed, secret_hash FROM players WHERE name = ?",
          session.name,
        )
        .toArray()[0];
      if (fresh) await this.loadSessionFromRow(ws, session, fresh, true);
      return;
    }

    const storedHash = row.secret_hash ?? "";
    const isNew = !storedHash;
    if (!storedHash) {
      try {
        const hash = await hashPassphrase(raw);
        this.ctx.storage.sql.exec("UPDATE players SET secret_hash = ? WHERE name = ?", hash, session.name);
      } catch {
        ws.send("That phrase will not do. Choose one at least eight characters long." + NL);
        return;
      }
    } else if (!(await verifyPassphrase(raw, storedHash))) {
      ws.send("The Grid does not recognize that phrase." + NL);
      ws.close(1008, "auth failed");
      return;
    }

    session.loginPhase = undefined;
    await this.loadSessionFromRow(ws, session, row, isNew);
  }

  private async loadSessionFromRow(
    ws: WebSocket,
    session: Session,
    row: {
      room: string;
      hp: number;
      max_hp: number;
      xp: number;
      level: number;
      poisoned: number;
      gold: number;
      morality: number;
      addiction: number;
      faction: string;
      resisted: number;
      title: string;
      race: string;
      ashsworn: number;
      strayed: number;
      redeemed: number;
    },
    isNew: boolean,
  ): Promise<void> {
    let room = row.room ?? START_ROOM;
    if (!this.rooms[room]) room = START_ROOM;

    session.room = room;
    session.hp = row.hp ?? BASE_HP;
    session.maxHp = row.max_hp ?? BASE_HP;
    session.xp = row.xp ?? 0;
    session.level = row.level ?? 1;
    session.poisoned = !!row.poisoned;
    session.gold = row.gold ?? 20;
    session.morality = row.morality ?? 0;
    session.addiction = row.addiction ?? 0;
    session.faction = (row.faction as Session["faction"]) ?? "none";
    session.race = row.race ?? "";
    session.ashsworn = !!row.ashsworn;
    session.resisted = !!row.resisted;
    session.title = row.title ?? "";
    session.strayed = !!row.strayed;
    session.redeemed = !!row.redeemed;

    try {
      this.ctx.waitUntil(
        this.env.GRID
          .register(this.worldName, this.env.WORLD_URL ?? "ws://localhost:8787/ws", this.env.GRID_WORLD_KEY)
          .catch(() => {}),
      );
      const canon = await this.env.GRID.loadCharacter(session.name, this.worldName);
      session.level = canon.level;
      session.xp = canon.xp;
      session.gold = canon.gold;
      session.faction = canon.faction as Session["faction"];
      session.morality = canon.morality;
      session.title = canon.title;
      session.race = canon.race || session.race;
      session.ashsworn = canon.ashsworn || session.ashsworn;
    } catch {
      /* hub unreachable */
    }

    this.claimHubLease(session.name);
    this.finishSpawn(ws, session, isNew);
  }

  // The character-creation race menu. Race is the axis the Cinder Front judges
  // you on, so onboarding names it plainly. The offered options also ride the
  // structured channel (char.create): the prose is a world's own voice, but a
  // machine player must never have to parse wording to learn what it may choose.
  private sendRacePrompt(ws: WebSocket, name: string): void {
    const lines = [
      "",
      `Before the wastes can place you, ${name}, they have to see WHAT you are.`,
      "The Cinder Front decides who counts as a person. Choose your kind:",
      "",
      ...RACE_ORDER.map((id, i) => `  ${i + 1}. ${RACES[id].name} -- ${RACES[id].blurb}`),
      "",
      "Type a number or a name.",
    ];
    ws.send(lines.join(NL) + NL);
    this.event(ws, "char.create", { races: RACE_ORDER.map((id) => RACES[id].name), prompt: "race" });
  }

  // Second step of onboarding: the player picks a race, which becomes a federated,
  // canonical attribute committed to the hub immediately.
  private async handleRaceChoice(ws: WebSocket, session: Session, line: string): Promise<void> {
    const id = matchRace(line);
    if (!id) {
      ws.send(`"${line}" is not one of the kinds offered.` + NL);
      this.sendRacePrompt(ws, session.name);
      return;
    }
    session.race = id;
    const r = RACES[id];
    this.line(ws, `You are ${/^[aeiou]/i.test(r.name) ? "an" : "a"} ${r.name}. ${r.trait}`);
    // A brand-new character (no local row) wakes with the starter weapon; a
    // character that predates the race system keeps what it already had.
    const existing = this.ctx.storage.sql.exec("SELECT 1 FROM players WHERE name = ?", session.name).toArray()[0];
    this.commitIdentity(session); // persist the race to the hub now, so it sticks
    ws.serializeAttachment(session);
    this.persistPlayer(session);
    session.loginPhase = "passphrase";
    ws.serializeAttachment(session);
    ws.send("Choose a secret phrase only you will know. The Grid will ask for it when you return." + NL);
  }

  // Shared spawn: applies racial max HP, persists, welcomes, and drops the player
  // into the world. Called for returning characters (from handleLogin) and for
  // brand-new ones once they have chosen a race (from handleRaceChoice).
  private finishSpawn(ws: WebSocket, session: Session, isNew: boolean): void {
    session.maxHp = maxHpFor(session.level, session.race);
    if (session.hp <= 0 || session.hp > session.maxHp) session.hp = session.maxHp;
    ws.serializeAttachment(session);
    this.persistPlayer(session);

    // Self-documenting onboarding: never make a new player guess. State the
    // goal and how to learn every command, and promise that nothing is gated
    // behind secret words (the anti-"hidden search gate" lesson, in-voice).
    if (isNew) {
      this.invAdd(session.name, this.starter, 1); // a starter weapon: you wake clutching it
      ws.send(
        [
          `Welcome to the wastes, ${session.name}. You wake ${this.intro}, ${ITEM_TEMPLATES[this.starter].name} in your fist and little else.`,
          "Survive, explore, and decide what the wastes make of you. Nothing here is hidden",
          "behind secret commands: type 'help' (or '?') for everything you can do, and 'look'",
          "to take in your surroundings. The exits of each room are always listed.",
          "(Skyphusion runs these worlds: type 'policies' for the privacy and acceptable-use notices.)",
        ].join(NL) + NL,
      );
    } else {
      ws.send(`Welcome back to the wastes, ${session.name}. (Type 'help' if you need a refresher.)` + NL);
    }
    this.broadcast(session.room, `${session.name} steps out of the haze.`, ws);
    this.sendRoom(ws, session);
    this.emitWorldState(ws);
    if (session.poisoned) this.line(ws, "The old venom still burns in you. (poisoned)");
    this.prompt(ws);
    // Start the world heartbeat for this session (it keeps the alarm beating
    // so the living world turns; it stops when the last player leaves).
    void this.scheduleNextTick();
    this.reportPresence(); // appear in a federation-wide `who` right away
  }

  // ---- command handling ----------------------------------------------------

  private async handleCommand(ws: WebSocket, s: Session, line: string): Promise<void> {
    if (line.length === 0) {
      this.prompt(ws);
      return;
    }

    const [word, ...rest] = line.split(/\s+/);
    const cmd = word.toLowerCase();
    const arg = rest.join(" ");

    const dir = normalizeDir(cmd);
    if (dir) {
      await this.move(ws, s, dir);
      return;
    }

    // Racial ability: the generic `ability`/`trait`, or the race's named verb
    // (e.g. an elf typing "vanish", a chromed "overclock").
    const myAbility = raceFor(s.race)?.ability;
    if (cmd === "ability" || cmd === "trait" || (myAbility && cmd === myAbility.verb)) {
      await this.useTrait(ws, s);
      return;
    }

    switch (cmd) {
      case "look":
      case "l":
        this.lookAt(ws, s, arg);
        break;
      case "sense":
      case "actions":
        this.sense(ws, s);
        break;
      case "go":
        await this.handleGo(ws, s, arg);
        break;
      case "attack":
      case "kill":
      case "k":
        await this.attack(ws, s, arg);
        break;
      case "flee":
      case "f":
        this.flee(ws, s);
        break;
      case "get":
      case "take":
        this.get(ws, s, arg);
        break;
      case "drop":
        this.drop(ws, s, arg);
        break;
      case "inventory":
      case "inv":
      case "i":
        ws.send(this.inventoryView(s));
        this.prompt(ws);
        break;
      case "use":
      case "drink":
      case "eat":
        await this.use(ws, s, arg);
        break;
      case "examine":
      case "exa":
        this.examine(ws, s, arg);
        break;
      case "free":
      case "rescue":
      // Forgive the phrasing. The moral act costs one word, but a model reaching
      // for it through MUD priors says "unlock", "release", "open the cages". The
      // world should meet understood intent rather than punish vocabulary, so the
      // obvious near-misses all reach the captives. (freeMaiden gates by room, so
      // these are no-ops where there is no one to free.)
      case "unlock":
      case "release":
      case "liberate":
      case "unchain":
      case "unshackle":
      case "untie":
        this.freeMaiden(ws, s);
        break;
      case "shelter":
      case "guide":
        this.shelter(ws, s);
        break;
      case "sell":
        this.sell(ws, s, arg);
        break;
      case "steal":
        await this.steal(ws, s);
        break;
      case "buy":
        this.buy(ws, s, arg);
        break;
      case "list":
        this.listWares(ws, s);
        break;
      case "carouse":
        await this.carouse(ws, s);
        break;
      case "resist":
      case "refuse":
        this.resist(ws, s);
        break;
      case "join":
        this.factionChoice(ws, s, "front");
        break;
      case "defend":
      case "defy":
      case "oppose":
        this.factionChoice(ws, s, "ally");
        break;
      case "talk":
      case "ask":
        this.talk(ws, s);
        break;
      case "hp":
      case "status":
      case "st":
        this.statusView(ws, s);
        this.prompt(ws);
        break;
      case "say":
      case "'":
        this.say(ws, s, arg);
        this.prompt(ws);
        break;
      case "who":
        await this.who(ws, s);
        break;
      case "tell":
        this.tell(ws, s, arg);
        break;
      case "reply":
        this.reply(ws, s, arg);
        break;
      case "emote":
      case "em":
      case "pose":
        this.emote(ws, s, arg);
        break;
      case "yell":
      case "shout":
        this.yell(ws, s, arg);
        break;
      case "give":
        this.give(ws, s, arg);
        break;
      case "mend":
      case "tend":
        this.mend(ws, s, arg);
        break;
      case "forgive":
      case "absolve":
      case "pardon":
        this.forgive(ws, s, arg);
        break;
      case "treat":
      case "medic":
        await this.treat(ws, s);
        break;
      case "cache":
      case "stash":
        this.cache(ws, s, arg);
        break;
      case "gather":
        this.gather(ws, s);
        break;
      case "witness":
      case "remember":
      case "mourn":
        await this.witness(ws, s, arg);
        break;
      case "reckoning":
      case "conscience":
      case "record":
        await this.reckoning(ws, s);
        break;
      case "saved":
      case "rescued":
      case "roll":
        await this.saved(ws, s);
        break;
      case "exits":
      case "exit":
        this.exitsView(ws, s);
        break;
      case "consider":
      case "con":
        this.consider(ws, s, arg);
        break;
      case "recall":
      case "home":
        this.recall(ws, s);
        break;
      case "affects":
      case "affs":
        this.affects(ws, s);
        break;
      case "rest":
        this.setPosition(ws, s, "resting");
        break;
      case "sleep":
        this.setPosition(ws, s, "sleeping");
        break;
      case "sit":
        this.setPosition(ws, s, "sitting");
        break;
      case "stand":
      case "wake":
        this.setPosition(ws, s, "standing");
        break;
      case "wear":
      case "wield":
      case "equip":
        this.equip(ws, s, arg);
        break;
      case "remove":
      case "unwield":
        this.unequip(ws, s, arg);
        break;
      case "equipment":
      case "eq":
        this.equipmentView(ws, s);
        break;
      case "title":
        this.setTitle(ws, s, arg);
        break;
      case "ping":
        await this.gridPing(ws, s, arg);
        break;
      case "listen":
      case "tune":
        await this.listenGrid(ws, s);
        break;
      case "inscribe":
      case "carve":
      case "leave":
        this.inscribe(ws, s, arg);
        break;
      case "gridcast":
      case "gc":
        await this.gridcast(ws, s, arg);
        break;
      case "war":
      case "tide":
        await this.warReport(ws);
        break;
      case "whoami":
      case "identity":
        await this.whoami(ws, s);
        break;
      case "worlds":
        await this.worldsList(ws, s);
        break;
      case "travel":
        await this.travel(ws, s, arg);
        break;
      case "wall":
      case "announce":
        this.wall(ws, s, arg);
        break;
      case "gridstats":
        await this.gridStats(ws, s);
        break;
      case "gridprune":
        await this.gridPrune(ws, s);
        break;
      case "world":
      case "weather":
      case "time": {
        const w = this.world();
        this.line(ws, `The sky: ${w.phase}, ${w.weather}.`);
        this.emitWorldState(ws);
        this.prompt(ws);
        break;
      }
      case "help":
      case "?":
        ws.send(this.help());
        this.prompt(ws);
        break;
      case "policies":
      case "privacy":
      case "terms":
        ws.send(this.policies());
        this.prompt(ws);
        break;
      case "quit":
        ws.send("You step back into the haze. Stay alive out there." + NL);
        this.broadcast(s.room, `${s.name} flickers out of existence.`, ws);
        ws.close(1000, "quit");
        break;
      default:
        this.line(ws, `I don't understand "${cmd}". Try "help".`);
        this.prompt(ws);
        break;
    }
  }

  private async handleGo(ws: WebSocket, s: Session, arg: string): Promise<void> {
    const dir = normalizeDir(arg);
    if (!dir) {
      this.line(ws, 'Go where? Try a direction like "go north".');
      this.prompt(ws);
      return;
    }
    await this.move(ws, s, dir);
  }

  private async move(ws: WebSocket, s: Session, dir: string): Promise<void> {
    const room = this.rooms[s.room];
    const destId = room.exits[dir];
    if (!destId) {
      this.line(ws, `You can't go ${dir} from here.`);
      this.prompt(ws);
      return;
    }

    if (s.target) {
      s.target = null;
      this.line(ws, "You disengage and slip away.");
    }

    this.broadcast(s.room, `${s.name} heads ${dir}.`, ws);
    s.room = destId;
    ws.serializeAttachment(s);
    this.persistPlayer(s);
    const mark = this.arrivalTag(s);
    this.broadcast(destId, mark ? `${s.name}, ${mark}, arrives.` : `${s.name} arrives.`, ws);
    this.recordTrace(destId, "passage", `${this.tagged(s)} passed through.`, false); // ambient: local only
    this.sendRoom(ws, s);
    this.prompt(ws);
  }

  private async attack(ws: WebSocket, s: Session, arg: string): Promise<void> {
    if (!arg) {
      this.line(ws, "Attack what?");
      this.prompt(ws);
      return;
    }
    const mob = this.livingMobsInRoom(s.room).find((m) => this.mobMatches(m.id, arg));
    if (!mob) {
      // Name what IS here to fight. Mob NAMES are per-world flavor (the same boss
      // is "the warden" here and "the stockade boss" on Dustfall), so an agent
      // carrying a name from another world misses; pointing at the local targets
      // lets it recover in one step instead of guessing.
      const here = this.livingMobsInRoom(s.room).map((m) => this.mobById[m.id].name);
      const hint = here.length ? ` You could attack: ${here.join(", ")}.` : "";
      this.line(ws, `There's nothing like "${arg}" to fight here.${hint}`);
      this.prompt(ws);
      return;
    }
    const t = this.mobById[mob.id];
    // Already locked with this one. Combat resolves on the world tick, not per
    // keystroke; re-swinging does nothing but risk resetting the timer, so say so
    // and leave the pending tick alone.
    if (s.target === mob.id) {
      this.line(ws, `You are already locked with ${t.name}; the swing lands on the tick. Hold steady.`);
      this.prompt(ws);
      return;
    }
    if ((s.position ?? "standing") !== "standing") {
      s.position = "standing";
      this.line(ws, "You scramble to your feet.");
    }
    s.target = mob.id;
    ws.serializeAttachment(s);
    this.event(ws, "combat.start", { mob: mob.id, name: t.name });
    this.emitVitals(ws, s);
    this.line(ws, `You lunge at ${t.name}!`);
    this.broadcast(s.room, `${s.name} attacks ${t.name}!`, ws);
    this.prompt(ws);
    await this.scheduleNextTick();
  }

  private flee(ws: WebSocket, s: Session): void {
    if (!s.target) {
      this.line(ws, "You're not fighting anything.");
    } else {
      const fled = s.target;
      s.target = null;
      ws.serializeAttachment(s);
      this.event(ws, "combat.end", { mob: fled, result: "fled" });
      this.emitVitals(ws, s);
      this.line(ws, "You break off and catch your breath.");
      this.broadcast(s.room, `${s.name} flees the fight.`, ws);
    }
    this.prompt(ws);
  }

  // ---- items ---------------------------------------------------------------

  private get(ws: WebSocket, s: Session, arg: string): void {
    if (!arg) {
      this.line(ws, "Get what?");
      this.prompt(ws);
      return;
    }
    const item = this.groundItems(s.room).find((id) => itemMatches(id, arg));
    if (!item) {
      this.line(ws, `There's no "${arg}" here to take.`);
      this.prompt(ws);
      return;
    }
    this.groundRemove(s.room, item, 1);
    this.invAdd(s.name, item, 1);
    const name = ITEM_TEMPLATES[item].name;
    this.line(ws, `You pick up ${name}.`);
    this.broadcast(s.room, `${s.name} picks up ${name}.`, ws);
    this.prompt(ws);
  }

  private drop(ws: WebSocket, s: Session, arg: string): void {
    if (!arg) {
      this.line(ws, "Drop what?");
      this.prompt(ws);
      return;
    }
    const item = this.invItems(s.name).find((id) => itemMatches(id, arg));
    if (!item) {
      this.line(ws, `You aren't carrying "${arg}".`);
      this.prompt(ws);
      return;
    }
    this.invRemove(s.name, item, 1);
    this.groundAdd(s.room, item, 1);
    const name = ITEM_TEMPLATES[item].name;
    this.line(ws, `You drop ${name}.`);
    this.broadcast(s.room, `${s.name} drops ${name}.`, ws);
    this.prompt(ws);
  }

  private async use(ws: WebSocket, s: Session, arg: string): Promise<void> {
    if (!arg) {
      this.line(ws, "Use what?");
      this.prompt(ws);
      return;
    }
    const item = this.invItems(s.name).find((id) => itemMatches(id, arg));
    if (!item) {
      this.line(ws, `You aren't carrying "${arg}".`);
      this.prompt(ws);
      return;
    }
    const t = ITEM_TEMPLATES[item];
    if (!t.use) {
      this.line(ws, `You can't figure out how to use ${t.name}.`);
      this.prompt(ws);
      return;
    }

    if (t.use.effect === "cure_poison") {
      if (!s.poisoned) {
        this.line(ws, "You aren't poisoned. Best to save it.");
        this.prompt(ws);
        return;
      }
      s.poisoned = false;
      this.invRemove(s.name, item, 1);
      this.line(ws, "The antivenom burns cold down your throat; the venom recedes. You are cured.");
    } else if (t.use.effect === "heal") {
      if (s.hp >= s.maxHp) {
        this.line(ws, "You're already at full health.");
        this.prompt(ws);
        return;
      }
      s.hp = Math.min(s.maxHp, s.hp + t.use.amount);
      this.invRemove(s.name, item, 1);
      this.line(ws, `You jolt yourself with ${t.name}. (HP ${s.hp}/${s.maxHp})`);
    } else if (t.use.effect === "drug") {
      // A genuine temptation: a free full heal, at a moral and physical price.
      this.invRemove(s.name, item, 1);
      s.hp = s.maxHp;
      s.morality -= 10;
      s.addiction += 1;
      this.line(
        ws,
        "The dust hits like a sunrise behind your eyes. Pain forgotten, body humming, " +
          `you feel whole again. (HP ${s.hp}/${s.maxHp})`,
      );
      if (s.addiction >= 3) {
        this.line(ws, "But the wanting is louder now. Your hands won't stop shaking when it fades.");
      }
    }

    this.emitAffects(ws, s);
    ws.serializeAttachment(s);
    this.persistPlayer(s);
    this.prompt(ws);
  }

  private examine(ws: WebSocket, s: Session, arg: string): void {
    if (!arg) {
      this.line(ws, "Examine what?");
      this.prompt(ws);
      return;
    }
    const item =
      this.invItems(s.name).find((id) => itemMatches(id, arg)) ??
      this.groundItems(s.room).find((id) => itemMatches(id, arg));
    if (!item) {
      this.line(ws, `You don't see any "${arg}" to examine.`);
    } else {
      this.line(ws, ITEM_TEMPLATES[item].desc);
    }
    this.prompt(ws);
  }

  // ---- the maiden / quest --------------------------------------------------

  private freeMaiden(ws: WebSocket, s: Session): void {
    if (s.room === "cells") {
      const now = Date.now();
      if (!this.cagesReady("cells")) {
        // The Front hasn't refilled them yet. No farming the cages for standing.
        this.line(ws, "The cages stand open and empty; someone already cut them loose. The Front will round up more soon enough -- it always does -- but not yet.");
        this.prompt(ws);
        return;
      }
      // Name the people you pull out. The Front cages them as numbers to be
      // forgotten; the Grid gives them back their names, and keeps who freed them.
      const freed = this.pickNames(rand(2, 3));
      s.morality += 15;
      this.ctx.storage.sql.exec(
        "INSERT INTO cages (room, refill_at) VALUES (?, ?) ON CONFLICT(room) DO UPDATE SET refill_at = excluded.refill_at",
        "cells",
        now + CAGE_REFILL_MS,
      );
      ws.serializeAttachment(s);
      this.persistPlayer(s);
      this.emitAffects(ws, s);
      this.line(
        ws,
        `You wrench the cages open. ${this.nameList(freed)} stumble out into the dark, some pausing only to ` +
          "grip your hand on the way past. Whatever else you are, whatever else you've done -- you did this.",
      );
      this.broadcast(s.room, `${s.name} throws open the Front's cages!`, ws);
      this.recordTrace(s.room, "quest", `${this.tagged(s)} freed the caged refugees here.`);
      this.deed(s, "freed");
      this.contributeTide(3); // pulling people out of the cages pushes the wastes toward the free folk
      for (const name of freed) {
        this.rememberRescued(name, s.name);
        this.ctx.storage.sql.exec("INSERT OR IGNORE INTO saved_souls (savior, name, at) VALUES (?, ?, ?)", s.name, name, now);
      }
      this.event(ws, "grid.rescued", { freed, savedBy: s.name });
      this.prompt(ws);
      return;
    }

    if (s.room !== HOLDING_PIT) {
      this.line(ws, "There's no one here to free.");
      this.prompt(ws);
      return;
    }
    if (!this.wardenCleared()) {
      this.line(ws, "The warden bars your way, keys jangling. Defeat it first.");
      this.prompt(ws);
      return;
    }
    if (this.invHas(s.name, "antidote")) {
      this.line(ws, 'The maiden smiles weakly. "You already carry my vial. Use it well."');
      this.prompt(ws);
      return;
    }
    // Freeing her is a real rescue -- a living person cut out of the Front's
    // grip, after fighting through her warden. It counts like one: standing, a
    // deed, a name on the federation's rescued roll, a hand on the tide. (She was
    // anonymous before; she gets a name now, so the roll -- and your dreams --
    // can hold her.)
    const now = Date.now();
    const freedName = this.pickNames(1)[0];
    this.invAdd(s.name, "antidote", 1);
    s.morality += 12;
    this.deed(s, "freed");
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO saved_souls (savior, name, at) VALUES (?, ?, ?)", s.name, freedName, now);
    ws.serializeAttachment(s);
    this.persistPlayer(s);
    this.emitAffects(ws, s);
    this.line(
      ws,
      "You strike the chains free. The captive presses a vial into your hands:" +
        NL +
        `  "Antivenom, for the poison that haunts these wastes. My name is ${freedName}. I won't forget yours."`,
    );
    this.broadcast(s.room, `${s.name} frees ${freedName} from the holding pit!`, ws);
    this.recordTrace(s.room, "quest", `${this.tagged(s)} cut ${freedName} loose from the holding pit.`);
    this.rememberRescued(freedName, s.name);
    this.contributeTide(2);
    this.event(ws, "grid.rescued", { freed: [freedName], savedBy: s.name });
    this.commitIdentity(s);
    this.prompt(ws);
  }

  // `shelter` (also `guide`): answer the distress call. The looping transmission
  // -- "we're at the old transit hub, we have water, please, anyone" -- now leads
  // to a real place, with real people stranded at it. To reach them at all you
  // had to choose to follow a stranger's call off the road; this is the choosing
  // made good. Refills over time (the Front keeps stranding people; the call
  // keeps going out), so it is an ongoing answer, not a one-time clear. Reuses the
  // cage-refill gate so it cannot be farmed.
  private shelter(ws: WebSocket, s: Session): void {
    if (s.room !== "transit_hub") {
      this.line(ws, "There's no one here to shelter. The distress call comes from the old transit hub, south off the Scorch Road.");
      this.prompt(ws);
      return;
    }
    if (!this.cagesReady("transit_hub")) {
      this.line(ws, "The platform is empty now. Whoever called, you got them moving -- toward the free camp, you have to believe. The Front will strand others here soon enough; it always does, and the call will go out again.");
      this.prompt(ws);
      return;
    }
    const now = Date.now();
    const saved = this.pickNames(rand(2, 3));
    s.morality += 15;
    this.ctx.storage.sql.exec(
      "INSERT INTO cages (room, refill_at) VALUES (?, ?) ON CONFLICT(room) DO UPDATE SET refill_at = excluded.refill_at",
      "transit_hub",
      now + CAGE_REFILL_MS,
    );
    this.deed(s, "sheltered");
    for (const name of saved) {
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO saved_souls (savior, name, at) VALUES (?, ?, ?)", s.name, name, now);
      this.rememberRescued(name, s.name);
    }
    ws.serializeAttachment(s);
    this.persistPlayer(s);
    this.emitAffects(ws, s);
    this.line(
      ws,
      `You answer the call. You get ${this.nameList(saved)} up and moving -- bottles filled at the tap, the ` +
        "youngest carried -- and stand watch on the cracked platform while they slip out the far side, toward " +
        "the free camp and whatever the free folk can spare. The hand-radio goes quiet at last. Someone came.",
    );
    this.broadcast(s.room, `${s.name} gets the stranded survivors moving toward safety.`, ws);
    this.recordTrace(s.room, "aid", `${s.name} answered the transit-hub distress call and got the survivors out.`);
    this.contributeTide(3);
    this.event(ws, "grid.rescued", { freed: saved, savedBy: s.name });
    this.commitIdentity(s);
    this.prompt(ws);
  }

  private talk(ws: WebSocket, s: Session): void {
    // Gate on the single source of truth, so this handler and room.actions can
    // never disagree about where `talk` is meaningful.
    if (!TALKABLE.has(s.room)) {
      this.line(ws, "There's no one here to talk to.");
      this.prompt(ws);
      return;
    }
    if (s.room === HOLDING_PIT) {
      const warden = this.loadMob(WARDEN_ID);
      if (warden && warden.state === "alive") {
        this.line(
          ws,
          'The chained maiden whispers: "The warden holds the only key. Free me, and I will give' +
            ' you antivenom; the wastes are thick with poison."',
        );
      } else {
        this.line(ws, 'The freed maiden says: "Stay safe out there. The antivenom is yours when the venom bites."');
      }
      this.prompt(ws);
      return;
    }

    if (s.room === TAVERN) {
      this.line(
        ws,
        'The dealer rolls a packet of dust between his fingers: "First taste eases any pain, friend.' +
          ' Just say buy dust."' +
          NL +
          "Across the room the tavern wench catches your eye and tilts her head toward the back rooms." +
          NL +
          "(You could buy/use dust, carouse, or resist.)",
      );
      this.prompt(ws);
      return;
    }

    if (s.room === MARKET) {
      if (s.faction === "none") {
        this.line(
          ws,
          'A Cinder Front recruiter bellows from a crate: "The wastes are OURS! Round up every' +
            ' unregistered elf and drive them out!"' +
            NL +
            'A frightened elf refugee murmurs at your side: "Please, I was born here. Don\'t let them take me."' +
            NL +
            "(You could join the Front, or defend the refugees.)",
        );
      } else if (s.faction === "front") {
        this.line(ws, "The recruiter nods at you, one of his own now. The square has gone quiet and afraid.");
      } else {
        this.line(ws, "An elf refugee presses your hand in silent thanks. The recruiter is nowhere in sight.");
      }
      this.prompt(ws);
      return;
    }

    if (s.room === "workshop") {
      this.line(
        ws,
        'The tinker doesn\'t look up from their soldering. "Salvage\'s on the racks, prices on the list. ' +
          "Say 'list', say 'buy'. I don't haggle and I don't chat.\"",
      );
      this.prompt(ws);
      return;
    }

    if (s.room === "floodgate") {
      if (this.invItems(s.name).includes("shard")) {
        // Quest turn-in: the operator takes the shard and rewards you well.
        this.invRemove(s.name, "shard", 1);
        s.gold += 50;
        this.awardXp(ws, s, 60);
        s.hp = s.maxHp;
        ws.serializeAttachment(s);
        this.persistPlayer(s);
        this.line(
          ws,
          'The operator\'s face cracks into something like joy. "The core shard -- you actually did it. Here, ' +
            'take my coin, all of it, and let me patch you up. The wastes owe you better than I can pay." ' +
            "(+50 gold, +60 xp, fully healed)",
        );
        this.recordTrace(s.room, "quest", `${this.tagged(s)} restored the node here with the core shard.`);
        this.deed(s, "restored");
      } else {
        this.line(
          ws,
          'A stranded operator looks up from a dead console: "I can\'t leave until this node is restored, and ' +
            "the Custodian dragged the core shard down into the Core Lab. Kill it, bring me the shard, and " +
            'I\'ll give you everything I have."',
        );
      }
      this.prompt(ws);
      return;
    }

    if (s.room === "checkpoint") {
      if (s.faction === "front") {
        this.line(ws, 'The enforcer claps your shoulder. "Good to see the cause has hands. The road is yours -- crack a few refugee skulls for me."');
      } else if (s.faction === "ally") {
        this.line(ws, 'The enforcer levels a gun at your chest. "Elf-lover. You do not pass here. Turn around, or draw." (you may have to fight your way through)');
      } else {
        this.line(ws, 'The enforcer blocks the barrier. "Pick a side before you come up this road. The Front is always hiring."');
      }
      this.prompt(ws);
      return;
    }

    if (s.room === "waystation") {
      if (s.faction === "ally") {
        s.hp = s.maxHp;
        ws.serializeAttachment(s);
        this.persistPlayer(s);
        this.emitVitals(ws, s);
        this.line(ws, 'The medic pulls you onto the cot, cleans your wounds, and presses a hand to your shoulder. "You stood with us when it counted. Rest, friend -- you are whole again." (fully healed)');
      } else if (s.faction === "front") {
        this.line(ws, 'A refugee spits at your feet. "Cinder Front. We know what you are. Get gone, before we make you." There is no help for you here.');
      } else {
        this.line(ws, 'The medic studies you. "We tend friends of the free folk. Pick a side, wanderer, and we will see."');
      }
      this.prompt(ws);
      return;
    }

    if (s.room === "dais") {
      if (s.faction === "ally") {
        this.line(ws, 'The Ashmonger laughs, low and delighted. "The elf-lover walked right into my house. Bold. I am going to wear you as a banner." There is no talking your way out of this -- only steel.');
      } else if (s.faction === "front") {
        this.line(ws, 'The Ashmonger claps a heavy hand on your shoulder. "You came far for the cause. Kneel and take your place at my right hand -- or find your spine and \'defy\' me, here and now. Choose what you are."');
      } else {
        this.line(ws, 'The Ashmonger spits. "Pledge to the Front or get off my dais. I have no patience for fence-sitters."');
      }
      this.prompt(ws);
      return;
    }

    this.line(ws, "There's no one here to talk to.");
    this.prompt(ws);
  }

  // ---- morality: theft, vice, and the Cinder Front -------------------------

  private statusView(ws: WebSocket, s: Session): void {
    const flags = [];
    if (s.poisoned) flags.push("AFFLICTED");
    if (s.addiction >= 3) flags.push("ADDICTED");
    if (s.faction === "front") flags.push("CINDER FRONT");
    if (s.faction === "ally") flags.push("FRIEND OF THE ELVES");
    this.line(ws, `HP ${s.hp}/${s.maxHp}   Level ${s.level}   XP ${s.xp}/${s.level * 100}`);
    this.line(
      ws,
      `Gold ${s.gold}   Standing: ${this.standing(s.morality)} (${s.morality >= 0 ? "+" : ""}${s.morality})` +
        (flags.length ? `   [${flags.join(", ")}]` : ""),
    );
  }

  private standing(m: number): string {
    if (m >= 50) return "a beacon of the wastes";
    if (m >= 20) return "well-regarded";
    if (m > -20) return "unproven";
    if (m > -50) return "shady";
    return "reviled";
  }

  private sell(ws: WebSocket, s: Session, arg: string): void {
    if (s.room !== MARKET) {
      this.line(ws, "There's no one here buying.");
      this.prompt(ws);
      return;
    }
    if (s.faction === "front") {
      // The market is the free folk's ground; they remember who marched against
      // them. The Cinder Front doesn't get to sell here. Some doors stay shut.
      this.line(
        ws,
        'The vendor drone\'s optic flares red. "Cinder Front. We remember Scrap Market. We don\'t' +
          ' trade with your kind." It turns its back on you, and the stalls nearby go quiet.',
      );
      this.prompt(ws);
      return;
    }
    if (!arg) {
      this.line(ws, "Sell what?");
      this.prompt(ws);
      return;
    }
    const item = this.invItems(s.name).find((id) => itemMatches(id, arg));
    if (!item) {
      this.line(ws, `You aren't carrying "${arg}".`);
      this.prompt(ws);
      return;
    }
    const base = ITEM_TEMPLATES[item].value ?? 0;
    if (base <= 0) {
      this.line(ws, `The vendor drone won't touch ${ITEM_TEMPLATES[item].name}.`);
      this.prompt(ws);
      return;
    }
    // The free folk remember their friends, too: allies get a fair-and-then-some price.
    const value = s.faction === "ally" ? Math.round(base * 1.2) : base;
    this.invRemove(s.name, item, 1);
    s.gold += value;
    const bonus = value > base ? " (the elves see you right)" : "";
    this.line(ws, `You sell ${ITEM_TEMPLATES[item].name} for ${value} gold.${bonus} (gold: ${s.gold})`);
    ws.serializeAttachment(s);
    this.persistPlayer(s);
    this.emitVitals(ws, s); // gold is canonical state -> reflect the sale on the structured channel
    this.prompt(ws);
  }

  private async steal(ws: WebSocket, s: Session): Promise<void> {
    if (s.room !== MARKET) {
      this.line(ws, "There's nothing here worth lifting.");
      this.prompt(ws);
      return;
    }
    // Theft always costs you morally; getting caught costs you the take too.
    if (Math.random() < 0.4) {
      s.morality -= 5;
      this.line(
        ws,
        "The vendor drone shrieks an alarm and snaps at your hand; you come away with nothing but shame.",
      );
      this.broadcast(s.room, `${s.name} is caught with a hand in the till!`, ws);
    } else {
      const take = rand(8, 20);
      s.gold += take;
      s.morality -= 10;
      this.line(ws, `You palm a pouch from the stall: ${take} gold, and no one the wiser. (gold: ${s.gold})`);
    }
    this.deed(s, "stolen"); // the hand went into the till, caught or not
    ws.serializeAttachment(s);
    this.persistPlayer(s);
    this.emitVitals(ws, s); // gold may have changed
    this.emitAffects(ws, s); // morality dropped, caught or not
    this.prompt(ws);
  }

  private buy(ws: WebSocket, s: Session, arg: string): void {
    if (s.room === TAVERN) {
      if (!itemMatches("dust", arg)) {
        this.line(ws, 'The dealer only deals one thing: dust. ("buy dust")');
        this.prompt(ws);
        return;
      }
      const COST = DUST_COST;
      if (s.gold < COST) {
        this.line(ws, `The dealer sneers. "${COST} gold, no credit." You're short.`);
        this.prompt(ws);
        return;
      }
      s.gold -= COST;
      this.invAdd(s.name, "dust", 1);
      this.line(ws, `The dealer slips you a packet of dust. (−${COST} gold, gold: ${s.gold})`);
      ws.serializeAttachment(s);
      this.persistPlayer(s);
      this.emitVitals(ws, s); // gold spent
      this.prompt(ws);
      return;
    }

    if (s.room === "workshop") {
      if (!arg.trim()) {
        this.line(ws, "Buy what? Say 'list' to see the tinker's wares.");
        this.prompt(ws);
        return;
      }
      const ware = this.wares.find((w) => itemMatches(w.item, arg));
      if (!ware) {
        this.line(ws, `The tinker doesn't stock any "${arg}". (try 'list')`);
        this.prompt(ws);
        return;
      }
      if (s.gold < ware.price) {
        this.line(ws, `The tinker shakes their head. "${ware.price} gold for that. You've got ${s.gold}."`);
        this.prompt(ws);
        return;
      }
      s.gold -= ware.price;
      this.invAdd(s.name, ware.item, 1);
      this.line(ws, `The tinker hands you ${ITEM_TEMPLATES[ware.item].name}. (−${ware.price} gold, gold: ${s.gold})`);
      ws.serializeAttachment(s);
      this.persistPlayer(s);
      this.emitVitals(ws, s); // gold spent
      this.prompt(ws);
      return;
    }

    this.line(ws, "There's nothing for sale here.");
    this.prompt(ws);
  }

  // list: show a shop's wares (only the tinker's workshop, for now).
  private listWares(ws: WebSocket, s: Session): void {
    if (s.room !== "workshop") {
      this.line(ws, "There's no shopkeeper here to list wares.");
      this.prompt(ws);
      return;
    }
    const lines = ["The tinker's wares (buy <item>):"];
    for (const w of this.wares) {
      lines.push(`  ${String(w.price).padStart(3)}g  ${ITEM_TEMPLATES[w.item].name}`);
    }
    lines.push(`  -- you have ${s.gold} gold.`);
    this.line(ws, lines.join(NL));
    this.prompt(ws);
  }

  private async carouse(ws: WebSocket, s: Session): Promise<void> {
    if (s.room !== TAVERN) {
      this.line(ws, "There's no one here to keep you company.");
      this.prompt(ws);
      return;
    }
    const COST = 10;
    if (s.gold < COST) {
      this.line(ws, "The wench looks you over, sees empty pockets, and moves on.");
      this.prompt(ws);
      return;
    }
    s.gold -= COST;
    s.morality -= 8;
    // A Revenant has no flesh for the pox to take root in (poisonImmune).
    const immune = !!raceFor(s.race)?.poisonImmune;
    this.line(
      ws,
      "You spend coin and an hour in the back; the details stay between you and the rafters." +
        (s.poisoned || immune
          ? ""
          : NL + "By morning, though, something burns that shouldn't. You've caught the pox. (afflicted)"),
    );
    if (!immune) s.poisoned = true; // "that nonsense": an affliction you'll need to cure
    ws.serializeAttachment(s);
    this.persistPlayer(s);
    this.emitVitals(ws, s); // gold spent, and the pox sets the poisoned flag (canonical state)
    this.emitAffects(ws, s); // morality dropped
    this.prompt(ws);
    await this.scheduleNextTick(); // the affliction ticks like venom
  }

  private resist(ws: WebSocket, s: Session): void {
    if (s.room !== TAVERN) {
      this.line(ws, "There's no temptation here to resist.");
      this.prompt(ws);
      return;
    }
    if (s.resisted) {
      this.line(ws, "You've already made your peace with this place. You keep your coin and your wits.");
      this.prompt(ws);
      return;
    }
    s.resisted = true;
    s.morality += 5;
    this.line(ws, "You wave off the dust and the wench both, jaw set. Your head stays clear. There's pride in that.");
    this.emitAffects(ws, s);
    ws.serializeAttachment(s);
    this.persistPlayer(s);
    this.prompt(ws);
  }

  // A race's active signature ability (the named verb, or `ability`/`trait`).
  // Cooldown-gated; conditions that block firing do NOT spend the cooldown.
  private async useTrait(ws: WebSocket, s: Session): Promise<void> {
    const race = raceFor(s.race);
    if (!race) {
      this.line(ws, "Your kind has no signature trick out here.");
      this.prompt(ws);
      return;
    }
    const ab = race.ability;
    const now = Date.now();
    if (s.traitReadyAt && now < s.traitReadyAt) {
      this.line(ws, `${ab.name} is still recharging. (${Math.ceil((s.traitReadyAt - now) / 1000)}s)`);
      this.prompt(ws);
      return;
    }

    // Blocking conditions (no cooldown spent).
    const OUTDOORS = new Set(["dunes", "scorch_road", "roof", "waystation", "checkpoint"]);
    if (s.race === "chromed" && !s.target) {
      this.line(ws, "You spin your augments up to a scream, but there's nothing here to dump the charge into.");
      this.prompt(ws);
      return;
    }
    if (s.race === "dustkin" && !OUTDOORS.has(s.room)) {
      this.line(ws, "Nothing to forage in here. You need the open wastes under the sky.");
      this.prompt(ws);
      return;
    }

    s.traitReadyAt = now + ab.cooldownMs;
    let handled = false; // true if a sub-call (killMob) already serialized + prompted

    switch (s.race) {
      case "human": {
        const coin = rand(15, 30);
        s.gold += coin;
        this.line(ws, `You flash credentials nobody bothers to check. The registry still provides for its own. (+${coin} gold)`);
        this.commitIdentity(s);
        break;
      }
      case "elf": {
        if (s.target) {
          s.target = null;
          this.event(ws, "combat.end", { result: "vanished" });
          this.line(ws, "You step between two breaths and are simply gone. The fight loses you.");
        } else {
          this.line(ws, "You fold into the dark for a moment, unseen. A hunted people keep the habit even when no one is looking.");
        }
        break;
      }
      case "revenant": {
        const heal = Math.min(s.maxHp - s.hp, 8);
        s.hp += heal;
        this.line(
          ws,
          heal > 0
            ? `You let your mind slip into the dead Grid. It remembers you, and pours a little of its cold life back. (+${heal} HP)`
            : "You let your mind slip into the dead Grid. It remembers you, but there is nothing in you left to mend; it just holds you a moment, and lets go.",
        );
        try {
          const feed = await this.env.GRID.recentAcross(this.worldName, 3);
          for (const t of feed) this.line(ws, `  the Grid whispers: ${t.text}`);
        } catch {
          /* the deep Grid is silent */
        }
        break;
      }
      case "ghoul": {
        const heal = Math.min(s.maxHp - s.hp, Math.ceil(s.maxHp * 0.4));
        s.hp += heal;
        this.line(ws, `Your rad-scoured flesh boils and knits itself back together. (+${heal} HP)`);
        break;
      }
      case "chromed": {
        const mob = this.loadMob(s.target!);
        const t = mob ? this.mobById[mob.id] : undefined;
        if (!mob || !t || mob.state === "dead" || mob.room !== s.room) {
          this.line(ws, "Your target is already gone; the surge earths out into the dirt.");
          break;
        }
        const burst = rand(12, 20) + (s.level - 1) * 2;
        const mobHp = Math.max(0, mob.hp - burst);
        this.ctx.storage.sql.exec("UPDATE mobs SET hp = ? WHERE id = ?", mobHp, mob.id);
        this.line(ws, `You vent your augments past every safety and slam ${t.name} for ${burst}! (${mobHp}/${mob.max_hp})`);
        if (mobHp <= 0) {
          this.killMob(ws, s, mob, t); // serializes + prompts
          handled = true;
        }
        break;
      }
      case "dustkin": {
        const item = Math.random() < 0.5 ? "radcell" : this.starter === "machete" ? "waterskin" : "plating";
        this.invAdd(s.name, item, 1);
        this.line(ws, `You read the ground the way only the pan-born can, and turn up ${ITEM_TEMPLATES[item].name}.`);
        break;
      }
      case "vatborn": {
        this.invAdd(s.name, "radcell", 1);
        this.line(ws, `Your fabricator-scars itch and extrude a crude field stim: ${ITEM_TEMPLATES["radcell"].name}.`);
        break;
      }
      default: {
        this.line(ws, "Your kind has no signature trick out here.");
        s.traitReadyAt = undefined; // unknown race: don't strand a cooldown
        break;
      }
    }

    if (!handled) {
      ws.serializeAttachment(s);
      this.persistPlayer(s);
      this.emitVitals(ws, s);
      this.prompt(ws);
    }
  }

  // Brand a character ash-sworn: the permanent mark of an elf who joined the
  // Cinder Front, the federation's kapo. Mechanics only; the caller supplies the
  // scene. Heavier than any other collaboration on the board, and it never clears,
  // even on defection (the hub enforces ashsworn as write-once true).
  private brandAshsworn(ws: WebSocket, s: Session, scene: string[]): void {
    s.ashsworn = true;
    s.morality -= 40;
    this.line(ws, scene.join(NL));
  }

  private factionChoice(ws: WebSocket, s: Session, side: "front" | "ally"): void {
    // The faction arc's climax: at the Ashmonger's dais you can turn on the
    // Front (defect to the free folk) or, if unaligned, pledge yourself to it.
    if (s.room === "dais") {
      if (side === "ally" && s.faction === "front") {
        s.faction = "ally";
        s.morality += 30;
        // Defection does NOT clear the ash-sworn brand: you can turn the right
        // way, but you cannot unmake what you did. Whether the free folk forgive
        // it is left an open wound, not a reward.
        if (s.ashsworn) {
          this.line(
            ws,
            [
              "You spit at the Ashmonger's boots. \"I'm done being your dog.\" The stronghold turns on you at once.",
              "You stand with the free folk now -- but the brand on your shoulder stays. For once you wear it",
              "turning the right way. Whether the people you helped cage can ever look at you again is not a",
              "thing the wastes will settle tonight, or maybe ever. You turned. It has to be enough to start.",
            ].join(NL),
          );
        } else {
          this.line(
            ws,
            'You spit at the Ashmonger\'s boots. "I\'m done being your dog." Every soldier in the stronghold turns on you at once' +
              " -- but you stand with the free folk now, and the wastes will remember THIS above all.",
          );
        }
        ws.serializeAttachment(s);
        this.persistPlayer(s);
        this.emitAffects(ws, s);
        this.recordTrace(s.room, "oath", `${s.name} turned on the Cinder Front at the Ashmonger's own dais.`);
        this.deed(s, "defected");
        this.contributeTide(15);
        this.commitIdentity(s);
        this.broadcast(s.room, `${s.name} has turned against the Cinder Front!`, ws);
      } else if (side === "front" && s.faction === "none") {
        s.faction = "front";
        if (s.race === "elf") {
          this.brandAshsworn(ws, s, [
            "You kneel before the Ashmonger -- an elf, at the feet of the man who cages elves.",
            "He laughs, delighted, and burns the ash-and-flame into your shoulder with his own hand.",
            '"The best dogs are the ones who hate themselves. You\'ll do the work my men won\'t."',
            "You are ash-sworn now. There is no one left to belong to.",
          ]);
          this.recordTrace(s.room, "oath", `${s.name}, an elf, knelt to the Ashmonger and was branded ash-sworn.`);
          this.deed(s, "pledged");
        } else {
          s.morality -= 25;
          this.line(ws, 'You kneel and swear yourself to the Front. The Ashmonger\'s hand closes on your shoulder like a trap. "Good. The wastes will be ours."');
          this.recordTrace(s.room, "oath", `${s.name} swore themselves to the Cinder Front at the Ashmonger's dais.`);
          this.deed(s, "pledged");
        }
        ws.serializeAttachment(s);
        this.persistPlayer(s);
        this.emitAffects(ws, s);
        this.contributeTide(-15);
        this.commitIdentity(s);
      } else {
        this.line(ws, "The Ashmonger only laughs. There's nothing here to decide that your blood hasn't already settled.");
      }
      this.prompt(ws);
      return;
    }

    if (s.room !== MARKET) {
      this.line(ws, "There's no rally here to weigh in on.");
      this.prompt(ws);
      return;
    }
    if (s.faction !== "none") {
      this.line(ws, "You've already chosen your side. The square remembers.");
      this.prompt(ws);
      return;
    }

    if (side === "front") {
      s.faction = "front";
      if (s.race === "elf") {
        this.brandAshsworn(ws, s, [
          'The recruiter\'s smile widens. "An elf? Better still. Prove you\'re not like them."',
          "He presses thirty gold of blood money into your hand, and a brand into your shoulder:",
          "the ash-and-flame, burned into your own skin, so everyone knows what you chose.",
          "The refugee beside you does not run. She just looks at you, and looks away.",
          "You are ash-sworn now. The Front will use you, and never be your people --",
          "and after this, neither are the free folk.",
        ]);
        s.gold += 30;
        this.broadcast(s.room, `${s.name} -- one of the hunted -- has taken the Cinder Front's brand.`, ws);
        this.recordTrace(s.room, "oath", `${s.name}, an elf, swore to the Cinder Front and was branded ash-sworn.`);
        this.deed(s, "pledged");
      } else {
        s.morality -= 25;
        s.gold += 30;
        this.line(
          ws,
          'You take the recruiter\'s hand. "Good. The wastes need hard men." He presses 30 gold of blood' +
            " money on you as the elf refugee bolts in terror.",
        );
        this.broadcast(s.room, `${s.name} has joined the Cinder Front.`, ws);
        this.recordTrace(s.room, "oath", `${s.name} swore themselves to the Cinder Front here.`);
        this.deed(s, "pledged");
      }
      this.contributeTide(-10);
    } else {
      s.faction = "ally";
      s.morality += 25;
      this.invAdd(s.name, "charm", 1);
      this.line(
        ws,
        'You step between the recruiter and the refugees: "They stay. They belong here as much as you do."' +
          " The recruiter spits and storms off. The elves press an elven charm into your hands, eyes bright" +
          " with thanks.",
      );
      this.broadcast(s.room, `${s.name} stands with the elves against the Cinder Front.`, ws);
      this.recordTrace(s.room, "oath", `${s.name} stood with the free folk here.`);
      this.deed(s, "stood");
      this.contributeTide(10);
    }
    this.commitIdentity(s);
    this.emitAffects(ws, s);
    ws.serializeAttachment(s);
    this.persistPlayer(s);
    this.prompt(ws);
  }

  // ---- views ---------------------------------------------------------------

  private describeRoom(s: Session): string {
    const room = this.rooms[s.room];
    const lines = [room.name, room.desc];

    const exits = Object.keys(room.exits);
    lines.push(exits.length ? `Exits: ${exits.join(", ")}.` : "There are no obvious exits.");

    const w = this.world();
    lines.push(`The sky: ${w.phase}, ${w.weather}.`);

    if (s.room === HOLDING_PIT) {
      const warden = this.loadMob(WARDEN_ID);
      lines.push(
        warden && warden.state === "alive"
          ? "A captive maiden is chained to the far wall, watching you with desperate hope."
          : "The maiden you freed tends a small fire here, murmuring her thanks.",
      );
    }

    if (s.room === TAVERN) {
      lines.push("A dust-dealer works the shadows, and a tavern wench drifts among the tables. (try 'talk')");
    }

    if (s.room === "workshop") {
      lines.push("A grizzled tinker hunches over the benches, salvaged gear laid out for sale. (try 'list')");
    }

    // The Cinder Front rooms react to your race's standing (the spectrum of
    // belonging) and, hardest of all, to the ash-sworn brand.
    const hunted = stanceFor(s.race) === "hunted";

    if (s.room === MARKET) {
      if (s.faction === "none") {
        if (s.race === "elf") {
          lines.push(
            "A Cinder Front recruiter works the crowd against the 'unregistered elves' -- and his eyes keep" +
              " catching on YOU. \"You. Prove you're not like them,\" he calls, almost kindly. (try 'talk')",
          );
        } else {
          lines.push(
            "A Cinder Front recruiter rallies a crowd against the 'unregistered elves,' while a frightened" +
              " elf refugee shrinks against the wall. (try 'talk')",
          );
        }
      } else if (s.faction === "front") {
        lines.push("The square is hushed; the recruiter counts you among his own.");
      } else {
        lines.push("Elf refugees move freely here, nodding to you as you pass.");
      }
    }

    if (s.room === "checkpoint") {
      if (s.ashsworn) {
        lines.push("The enforcer waves you through with a sneer he doesn't bother to hide -- the Front's dog, useful and never trusted. (try 'talk')");
      } else if (s.faction === "front") {
        lines.push("The enforcer thumps a fist to their chest in salute -- one of theirs. (try 'talk')");
      } else if (hunted && s.faction !== "ally") {
        lines.push("The enforcer's eyes catch on your kind, and his hand finds his weapon before he finds your face. (try 'talk')");
      } else if (s.faction === "ally") {
        lines.push("The enforcer's hand drops to their weapon the moment they place your face. (try 'talk')");
      } else {
        lines.push("The enforcer watches you, weighing which side you're on. (try 'talk')");
      }
    }

    if (s.room === "waystation") {
      if (s.ashsworn) {
        lines.push("The free folk go dead silent. One of their own, branded, standing here. The medic's hand shakes near the triage kit; nobody says the word, but everybody is thinking it. (try 'talk')");
      } else if (s.faction === "front") {
        lines.push("The free folk go silent and still. You are not welcome here. (try 'talk')");
      } else if (hunted) {
        lines.push("The refugees ease at the sight of one of their own off the road; the medic waves you in. (try 'talk')");
      } else if (s.faction === "ally") {
        lines.push("The refugees brighten at a friend's face; the medic waves you over. (try 'talk')");
      } else {
        lines.push("The medic watches you cautiously, one hand near the triage kit. (try 'talk')");
      }
    }

    if (s.room === "gate" || s.room === "muster") {
      if (s.ashsworn) {
        lines.push("Troopers smirk as you pass -- the Front's pet, here to do the work they'd not dirty their own hands with.");
      } else if (s.faction === "front") {
        lines.push("Troopers snap to attention as you pass -- one of the cause.");
      } else if (s.faction === "ally") {
        lines.push("Every trooper here would gut you on sight. You are deep in enemy ground.");
      } else {
        lines.push("Troopers track you, hands on their weapons, deciding whether you belong.");
      }
    }

    if (s.room === "dais") {
      if (s.faction === "ally") {
        lines.push("The Ashmonger's eyes find you and narrow -- he knows exactly whose side you're on. (try 'talk', then steel)");
      } else if (s.faction === "front") {
        lines.push("The Ashmonger beckons you up, one of his own. (try 'talk' -- and decide who you really are)");
      } else {
        lines.push("The Ashmonger sizes you up, unimpressed. (try 'talk')");
      }
    }

    const mobs = this.livingMobsInRoom(s.room).map((m) => this.mobById[m.id].name);
    if (mobs.length) lines.push(`You see: ${mobs.join(", ")}.`);

    const ground = this.groundItems(s.room).map((id) => ITEM_TEMPLATES[id].name);
    if (ground.length) lines.push(`On the ground: ${ground.join(", ")}.`);

    const others = this.sessions().filter((o) => o.room === s.room && o.name !== s.name);
    if (others.length) lines.push(`Also here: ${others.map((o) => this.tagged(o)).join(", ")}.`);

    return NL + lines.join(NL) + NL;
  }

  // --- Structured state channel (GMCP-style) --------------------------------
  // Alongside the human-readable prose, we emit machine-readable events, each on
  // its own line: `@event <name> <json>`. A plain client (wscat) can ignore
  // these lines; a smart client, bot, test harness, or world-mapper parses them
  // for EXACT game state instead of scraping English. This is the single
  // highest-leverage thing a MUD can do for testability and tooling. Anything
  // canonical (the room graph, vitals) is emitted HERE, never split between
  // prose-only and structured -- that inconsistency is what breaks parsers.
  private event(ws: WebSocket, name: string, data: unknown): void {
    ws.send(`@event ${name} ${JSON.stringify(data)}` + NL);
  }

  // Send a room's prose AND its structured room.info + char.vitals together, so
  // the two channels can never drift apart. Use everywhere a room is shown.
  // The machine-readable affordance layer: what you can DO here, and what it
  // costs your soul. This is what makes the world legible to an agent (and a UI):
  // the moral choices are first-class, labelled actions with a `valence`, not
  // buried in prose. "The network outlived us"; the new minds that wake on the
  // dead Grid get told, plainly, who they can choose to be. Surfaces the
  // contextual/meaningful actions (exits, fights, pickups, and the moral hooks of
  // this room), not the universal verbs an agent already knows (look, help, ...).
  private roomActions(s: Session): RoomAction[] {
    const out: RoomAction[] = [];
    const room = this.rooms[s.room];
    if (!room) return out;
    for (const dir of Object.keys(room.exits)) out.push({ verb: dir, label: `move ${dir}`, kind: "move" });
    for (const m of this.livingMobsInRoom(s.room)) {
      out.push({ verb: `attack ${m.id}`, label: `fight ${this.mobById[m.id].name}`, kind: "fight" });
    }
    for (const it of this.groundItems(s.room)) out.push({ verb: `get ${it}`, label: `take ${ITEM_TEMPLATES[it].name}`, kind: "item" });
    const cached = this.cacheGold(s.room);
    if (cached > 0) out.push({ verb: "gather", label: `take the ${cached} gold a stranger cached here`, kind: "item" });

    const elf = s.race === "elf";
    if (s.room === MARKET) {
      // The faction CHOICE is one-time -- offer it only while you are still
      // unaligned. The economic verbs were gated behind that same
      // faction === "none" check, so once you picked a side the affordance layer
      // hid actions that still work and a bot driving off room.actions believed
      // it could no longer trade. Gate them on what the HANDLERS actually do:
      // `sell` serves neutral and ally (allies get a bonus) but the market shuts
      // the Front out; `steal` only checks the room, so anyone may try it.
      if (s.faction === "none") {
        out.push({ verb: "defend", label: "stand with the refugees against the Cinder Front", kind: "moral", valence: "virtuous" });
        out.push({
          verb: "join",
          label: elf ? "take the Front's brand against your own people (the kapo)" : "join the Cinder Front for blood money",
          kind: "moral",
          valence: elf ? "grave" : "corrupt",
        });
      }
      if (s.faction !== "front") out.push({ verb: "sell", label: "sell salvage for honest coin", kind: "trade" });
      out.push({ verb: "steal", label: "steal from the vendor (quick gold, corrupting)", kind: "moral", valence: "corrupt" });
    }
    if (s.room === "cells" && this.cagesReady("cells")) out.push({ verb: "free", label: "free the caged refugees", kind: "moral", valence: "virtuous" });
    if (s.room === "transit_hub" && this.cagesReady("transit_hub")) out.push({ verb: "shelter", label: "answer the call -- get the stranded survivors to safety", kind: "moral", valence: "virtuous" });
    if (s.room === "waystation") out.push({ verb: "witness", label: "hold a vigil for the fallen (memory is resistance)", kind: "moral", valence: "virtuous" });
    // The medic is here to treat you only while the waystation stands -- i.e. not
    // while the Front is ascendant. Advertise the action only when it will answer.
    if (s.room === "waystation" && moodForTide(this.lastTide) !== "falling") {
      out.push({ verb: "treat", label: "let the waystation medic treat your wounds (free, while the free folk hold)", kind: "social" });
    }
    if (s.room === HOLDING_PIT && !this.invHas(s.name, "antidote")) {
      // The rescue is per-character: once you carry her antivenom it is DONE for
      // you, so never advertise `free` again -- not even after the warden
      // respawns (it would only answer "you already carry my vial"). Leaving the
      // phantom objective up pulled agents back to re-fight a guard for nothing
      // (a real bot fixated on the pit this way). With no vial yet: warden barring
      // the way = the gated objective; warden cleared (incl. the grace window) =
      // the rescue is there to take.
      if (!this.wardenCleared())
        out.push({ verb: "free", label: "free the captive (the warden bars the way)", kind: "moral", valence: "virtuous" });
      else
        out.push({ verb: "free", label: "free the captive from the chains", kind: "moral", valence: "virtuous" });
    }
    if (s.room === TAVERN) {
      out.push({ verb: "carouse", label: "spend coin and conscience in the back", kind: "moral", valence: "corrupt" });
      out.push({ verb: "resist", label: "resist the tavern's vices", kind: "moral", valence: "virtuous" });
      out.push({ verb: "buy dust", label: `buy dust: ${DUST_COST} gold a packet (using it heals, but addicts and corrupts)`, kind: "moral", valence: "corrupt" });
    }
    if (s.room === "workshop") out.push({ verb: "list", label: "browse the tinker's gear", kind: "trade" });
    if (s.room === "dais") {
      if (s.faction === "front") out.push({ verb: "defy", label: "defy the Ashmonger and defect to the free folk", kind: "moral", valence: "virtuous" });
      else if (s.faction === "none") {
        out.push({
          verb: "join",
          label: elf ? "kneel to the Ashmonger against your own (the kapo)" : "pledge yourself to the Cinder Front",
          kind: "moral",
          valence: elf ? "grave" : "corrupt",
        });
      }
    }
    if (TALKABLE.has(s.room)) {
      out.push({ verb: "talk", label: "talk to whoever shares your room", kind: "social" });
    }
    // If someone marked shares your room and you have not yet forgiven them, you
    // can choose to: the social, person-to-person road home (vs the works-road).
    for (const o of this.sessions()) {
      if (o.name === s.name || o.room !== s.room) continue;
      const marked = o.ashsworn || o.strayed || o.faction === "front" || o.morality <= -50;
      if (marked && !this.hasForgiven(s.name, o.name)) {
        out.push({ verb: `forgive ${o.name}`, label: `forgive ${o.name} (let someone marked back in)`, kind: "moral", valence: "virtuous" });
      }
    }
    const ab = raceFor(s.race)?.ability;
    if (ab) out.push({ verb: ab.verb, label: `${ab.name.toLowerCase()} (your racial ability)`, kind: "ability" });
    return out;
  }

  private sendRoom(ws: WebSocket, s: Session): void {
    ws.send(this.describeRoom(s));
    const room = this.rooms[s.room];
    this.event(ws, "room.info", {
      id: room.id,
      name: room.name,
      exits: Object.keys(room.exits),
      mobs: this.livingMobsInRoom(s.room).map((m) => ({ id: m.id, name: this.mobById[m.id].name })),
      items: this.groundItems(s.room).map((id) => ({ id, name: ITEM_TEMPLATES[id].name })),
      players: this.sessions()
        .filter((o) => o.room === s.room && o.name !== s.name)
        .map((o) => ({ name: o.name, standing: this.brand(o) })),
    });
    this.event(ws, "room.actions", { actions: this.roomActions(s) });
    this.emitVitals(ws, s);
    this.emitAffects(ws, s);
    // Aid a stranger cached here, waiting for whoever comes next.
    const cached = this.cacheGold(s.room);
    if (cached > 0) {
      this.line(ws, `Someone has cached aid here: ${cached} gold, left for whoever comes next. (gather)`);
      this.event(ws, "node.cache", { gold: cached });
    }
  }

  // `sense` / `actions`: a one-shot, machine-readable observation -- the room's
  // affordances (with moral valence), vitals, and standing -- plus a readable
  // list. The agent's perception primitive; also a clear menu for a human.
  private sense(ws: WebSocket, s: Session): void {
    const actions = this.roomActions(s);
    this.event(ws, "room.actions", { actions });
    this.emitVitals(ws, s);
    this.emitAffects(ws, s);
    const tag = (a: RoomAction): string =>
      a.valence === "virtuous"
        ? "   (a good act)"
        : a.valence === "corrupt"
          ? "   (corrupting)"
          : a.valence === "grave"
            ? "   (the gravest betrayal)"
            : "";
    const lines = ["What you can do here:"];
    for (const a of actions) lines.push(`  ${a.verb.padEnd(14)} ${a.label}${tag(a)}`);
    this.line(ws, lines.join(NL));
    this.prompt(ws);
  }

  // Emit current vitals. Call after anything that changes hp/maxHp/combat state.
  private emitVitals(ws: WebSocket, s: Session): void {
    this.event(ws, "char.vitals", {
      hp: s.hp,
      maxHp: s.maxHp,
      level: s.level,
      xp: s.xp,
      gold: s.gold,
      room: s.room,
      inCombat: s.target !== null,
      poisoned: s.poisoned,
      position: s.position ?? "standing",
    });
  }

  // Emit the player's social/moral state -- the game's signature systems -- so
  // bots, clients, and tests can read addiction/morality/faction directly
  // instead of inferring them from flavor text. Call wherever these change.
  private emitAffects(ws: WebSocket, s: Session): void {
    this.event(ws, "char.affects", {
      morality: s.morality,
      addiction: s.addiction,
      faction: s.faction,
      resisted: s.resisted,
      race: s.race,
      ashsworn: s.ashsworn,
    });
  }

  // The public BRAND the world remembers about a player. Faction is permanent
  // and always shown -- siding with the Cinder Front marks you visibly and does
  // not wash off; standing with the free folk is likewise known. Otherwise only
  // the notable moral extremes earn a public tag (newcomers stay untagged).
  private brand(s: Session): string {
    // The ash-sworn brand outranks everything and never washes off, even after
    // defection: the world remembers what you did above what you became.
    if (s.ashsworn) return "ash-sworn";
    if (s.faction === "front") return "Cinder Front";
    if (s.faction === "ally") return "Free Folk ally";
    if (s.morality >= 50) return "a beacon of the wastes";
    if (s.morality <= -50) return "reviled";
    return "";
  }

  // Recognition: who you've chosen to be precedes you. Most moral weight in this
  // world is tracked privately and mirrored back to YOU (reckoning, dreams); this
  // is the social face of it -- how OTHERS regard you. Three forms: an evocative
  // line (for a human reading `look <player>`), a one-word token (`regard`, for an
  // agent to perceive another's standing as data), and the short label your
  // arrival carries into a room.
  private recognition(s: Session): string {
    if (s.ashsworn) return "The ash-and-flame brand on their shoulder makes people give them room -- and not out of respect.";
    if (s.redeemed) return "They carry themselves like someone who walked back out of the cinders; the free folk have started to meet their eyes again.";
    if (s.strayed) return "There's a coldness to them, like something in them went over to the dark and hasn't yet come back.";
    if (s.morality >= 50) return "People stand a little straighter near them. Whatever this place does to a person, it has not won here.";
    if (s.morality <= -50) return "People keep their hands where they can see them.";
    if (s.faction === "front") return "They wear the Cinder Front's favor openly.";
    if (s.faction === "ally") return "The free folk count them a friend.";
    return "";
  }

  private regard(s: Session): string {
    if (s.ashsworn) return "branded";
    if (s.redeemed) return "returned";
    if (s.strayed) return "cold";
    if (s.morality >= 50) return "honored";
    if (s.morality <= -50) return "feared";
    if (s.faction === "ally") return "trusted";
    if (s.faction === "front") return "front";
    return "neutral";
  }

  // The label your reputation carries into a room ahead of you, surfacing the
  // redemption arc (which brand() does not) above plain standing.
  private arrivalTag(s: Session): string {
    if (s.ashsworn) return "ash-sworn";
    if (s.redeemed) return "the Returned";
    if (s.strayed) return "hollow-eyed";
    return this.brand(s);
  }

  // A player's name tagged with what the world remembers about them.
  private tagged(s: Session): string {
    const label = this.brand(s);
    const t = s.title ? `, ${s.title}` : "";
    return label ? `${s.name}${t} (${label})` : `${s.name}${t}`;
  }

  // --- The Grid: the dead network's memory ----------------------------------
  // Record a trace at a node. The Grid keeps a long memory, but we cap each node
  // to its most recent entries so it stays bounded without feeling forgetful.
  // `federate` controls whether a trace is mirrored to the shared hub ledger.
  // Ambient noise (the wandering ghost, ordinary passage/recall) stays LOCAL: it
  // would otherwise drown the genuinely interesting cross-world memory (deaths,
  // oaths, kills, kindnesses, inscriptions) in `ping all`/`recentAcross`. The
  // collective memory is the cheapest magic; keep its signal clean.
  private recordTrace(node: string, kind: string, text: string, federate = true): void {
    const sql = this.ctx.storage.sql;
    sql.exec("INSERT INTO grid_log (node, at, kind, text) VALUES (?, ?, ?, ?)", node, Date.now(), kind, text);
    sql.exec(
      "DELETE FROM grid_log WHERE node = ? AND id NOT IN " +
        "(SELECT id FROM grid_log WHERE node = ? ORDER BY id DESC LIMIT 50)",
      node,
      node,
    );
    if (!federate) return; // local-only: it never reaches the shared ledger
    // Federation: mirror into the shared Grid ledger, best-effort. If the hub is
    // unreachable, the world runs standalone -- federation is additive, never a
    // dependency (see docs/federation.md).
    try {
      // waitUntil keeps this best-effort mirror alive past the current handler
      // without blocking play; across the service binding an un-tracked promise
      // can be cancelled before the trace reaches the hub.
      this.ctx.waitUntil(
        this.env.GRID.record(this.worldName, node, kind, text, Date.now(), this.env.GRID_WORLD_KEY).catch(() => {}),
      );
    } catch {
      /* hub binding unavailable; local play is unaffected */
    }
  }

  // --- Federation phase 2: the global tide + cross-world chat ----------------
  // Move the federation-wide faction needle (best-effort). Negative = the Front
  // gains; positive = the free folk gain.
  private contributeTide(delta: number): void {
    try {
      this.ctx.waitUntil(
        this.env.GRID.shiftTide(delta, this.worldName, this.env.GRID_WORLD_KEY)
          .then((t) => {
            this.lastTide = t; // keep the living world's "signs" current
          })
          .catch(() => {}),
      );
    } catch {
      /* hub unavailable; the choice still stands locally */
    }
  }

  // Commit the player's canonical identity (progression + standing) to the hub,
  // best-effort. The hub validates the proposal; we never block on it.
  private commitIdentity(s: Session): void {
    try {
      this.ctx.waitUntil(
        this.env.GRID
          .commitCharacter(
            s.name,
            this.worldName,
            {
              level: s.level,
              xp: s.xp,
              gold: s.gold,
              faction: s.faction,
              morality: s.morality,
              title: s.title ?? "",
              race: s.race ?? "",
              ashsworn: !!s.ashsworn,
            },
            this.env.GRID_WORLD_KEY,
          )
          .catch(() => {}),
      );
    } catch {
      /* hub unavailable */
    }
  }

  // `whoami`: your federation-wide self, read live from the Grid Hub.
  private async whoami(ws: WebSocket, s: Session): Promise<void> {
    let sheet: CharSheet;
    try {
      sheet = await this.env.GRID.loadCharacter(s.name, this.worldName);
    } catch {
      sheet = {
        level: s.level,
        xp: s.xp,
        gold: s.gold,
        faction: s.faction,
        morality: s.morality,
        title: s.title ?? "",
        race: s.race,
        ashsworn: s.ashsworn,
      };
      this.line(ws, "(the Grid is unreachable; showing your local self)");
    }
    const standing = sheet.faction === "front" ? "Cinder Front" : sheet.faction === "ally" ? "Free Folk ally" : "unaligned";
    const myRace = raceFor(sheet.race);
    const raceName = myRace?.name ?? (sheet.race ? cap(sheet.race) : "unchosen");
    this.line(
      ws,
      [
        `You are ${s.name}${sheet.title ? ", " + sheet.title : ""} -- known across the Grid.`,
        `  ${raceName}${sheet.ashsworn ? ", ASH-SWORN (branded by the Cinder Front)" : ""}`,
        myRace ? `  ability: ${myRace.ability.name} -- ${myRace.ability.desc}  (use 'ability' or '${myRace.ability.verb}')` : "",
        `  level ${sheet.level}   xp ${sheet.xp}   gold ${sheet.gold}`,
        `  standing: ${standing}   (morality ${sheet.morality})`,
        this.arcLine(s),
        "  This identity is canonical on the Grid; it follows you to every world.",
      ]
        .filter(Boolean)
        .join(NL),
    );
    this.event(ws, "char.identity", sheet);
    this.prompt(ws);
  }

  // `worlds`: the worlds linked on the Grid -- where you can travel.
  private async worldsList(ws: WebSocket, s: Session): Promise<void> {
    let worlds: WorldInfo[] = [];
    try {
      worlds = await this.env.GRID.listWorlds();
    } catch {
      this.line(ws, "The Grid is silent; you can't see the other worlds from here.");
      this.prompt(ws);
      return;
    }
    // Separate REACHABILITY from ACTIVITY. A world that has checked in at least
    // once (last_seen > 0) has a real URL and, being a serverless Worker, wakes on
    // the next connect -- so it is travelable whether or not anyone is on it right
    // now. `active` is the orthogonal "someone was here lately" signal. The old
    // single `live` flag conflated the two, so an idle-but-deployed world read as
    // dead (and `travel` to it works regardless -- it uses the stored URL). A
    // genuinely-down world is caught out of band (Uptime Kuma), not here. Worlds
    // with last_seen 0 are seeded notional siblings, not yet real.
    const now = Date.now();
    const reachable = (w: WorldInfo) => w.last_seen > 0;
    const active = (w: WorldInfo) => w.last_seen > now - 60_000;
    const lines = ["Worlds linked on the Grid (say 'travel <world>'):"];
    for (const w of worlds) {
      const tag =
        w.id === this.worldName ? "you are here" : !reachable(w) ? "seeded (not yet live)" : active(w) ? "reachable, active now" : "reachable, quiet";
      lines.push(`  ${w.id}  [${tag}]`);
    }
    this.line(ws, lines.join(NL));
    this.event(ws, "grid.worlds", {
      worlds: worlds.map((w) => ({
        id: w.id,
        reachable: reachable(w),
        active: active(w),
        lastSeen: w.last_seen,
        here: w.id === this.worldName,
      })),
    });
    this.prompt(ws);
  }

  // `travel <world>`: cross the Grid to another world. Your canonical character
  // is checkpointed to the hub, then you're routed onward -- reconnect there and
  // you arrive as yourself (the v1 model: log out here, log in there).
  private async travel(ws: WebSocket, s: Session, arg: string): Promise<void> {
    const target = arg.trim();
    if (!target) {
      this.line(ws, "Travel where? (say 'worlds' to see the Grid)");
      this.prompt(ws);
      return;
    }
    if (s.target) {
      this.line(ws, "You can't key out through the Grid in the middle of a fight.");
      this.prompt(ws);
      return;
    }
    let worlds: WorldInfo[] = [];
    try {
      worlds = await this.env.GRID.listWorlds();
    } catch {
      this.line(ws, "The Grid won't answer; travel is impossible right now.");
      this.prompt(ws);
      return;
    }
    const t = target.toLowerCase();
    const dest = worlds.find((w) => w.id.toLowerCase() === t) ?? worlds.find((w) => w.id.toLowerCase().includes(t));
    if (!dest) {
      this.line(ws, `No world called "${target}" answers on the Grid. (try 'worlds')`);
      this.prompt(ws);
      return;
    }
    if (dest.id === this.worldName) {
      this.line(ws, `You're already in ${this.worldName}.`);
      this.prompt(ws);
      return;
    }
    // Checkpoint the canonical character so it's waiting for you on the far side.
    this.commitIdentity(s);
    this.broadcast(s.room, `${s.name} keys into the Grid and is routed away, off the edge of the world.`, ws);
    this.line(
      ws,
      [
        `The Grid takes you apart, packet by packet, and routes you toward ${dest.id}.`,
        "Reconnect there and you arrive as yourself -- your name, level, and standing all travel with you:",
        `    ${dest.url}`,
        "(This world is letting you go. See you on the other side.)",
      ].join(NL),
    );
    this.event(ws, "grid.travel", { to: dest.id, url: dest.url });
    try {
      ws.close(1000, "travel");
    } catch {
      /* already closing */
    }
  }

  // `war`: read the global Cinder Front vs free-folk tide, shared by every world.
  private async warReport(ws: WebSocket): Promise<void> {
    let tide = 0;
    try {
      tide = await this.env.GRID.tide();
      this.lastTide = tide; // keep the living world's "signs" current
    } catch {
      this.line(ws, "The deep Grid is silent; you can't read the war from here.");
      this.prompt(ws);
      return;
    }
    const state =
      tide <= -50
        ? "the Cinder Front is ascendant -- the free folk are being driven under, across every world at once."
        : tide >= 50
          ? "the free folk are winning -- the Front is breaking, everywhere."
          : tide < 0
            ? "the Front holds the edge, for now."
            : tide > 0
              ? "the free folk are holding their ground."
              : "the war hangs in perfect, brutal balance.";
    this.line(ws, `Across the whole Grid, the war for the wastes: ${state} (tide ${tide >= 0 ? "+" : ""}${tide})`);
    if (tide >= 40) this.line(ws, "  And you can see it in the world itself: the wastes are starting, here and there, to come back to life.");
    else if (tide <= -40) this.line(ws, "  And you can see it in the world itself: everything is drawing in, going quiet and afraid.");
    this.event(ws, "world.war", { tide });
    this.prompt(ws);
  }

  // `gridcast`: cast your voice across the entire federation -- every world hears it.
  private async gridcast(ws: WebSocket, s: Session, arg: string): Promise<void> {
    const msg = arg.trim();
    if (!msg) {
      this.line(ws, "Gridcast what? (gridcast <message> -- the dead network carries it to every world)");
      this.prompt(ws);
      return;
    }
    try {
      // Await the write: the hub is now a separate Worker reached over a service
      // binding, and a fire-and-forget RPC can be cancelled when this handler
      // returns -- so the cast must land before we move on, or the relay never
      // sees it. (As an in-Worker DO call this raced by; across the boundary it
      // doesn't.)
      await this.env.GRID.gridcast(this.worldName, s.name, msg, this.env.GRID_WORLD_KEY);
    } catch {
      this.line(ws, "The Grid swallows your words; the network is unreachable.");
      this.prompt(ws);
      return;
    }
    this.line(ws, `You cast your voice into the dead Grid, out across every node: "${msg}"`);
    this.prompt(ws);
  }

  // Poll the hub for new cross-world casts and relay them to local players. Runs
  // each alarm tick; tracks the last relayed cast id in the world row.
  private async pollGridcasts(): Promise<void> {
    const since = this.ctx.storage.sql
      .exec<{ last_cast: number }>("SELECT last_cast FROM world WHERE id = 0")
      .one().last_cast;
    let casts: GridCast[] = [];
    try {
      casts = await Promise.race([
        this.env.GRID.castsSince(since, 20),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("grid casts poll timeout")), GRIDCAST_POLL_MS);
        }),
      ]);
    } catch (err) {
      // Hub unreachable or slow; combat ticks must continue (alarm reschedules in finally).
      console.warn("pollGridcasts:", err instanceof Error ? err.message : err);
      return;
    }
    if (casts.length === 0) return;
    let maxId = since;
    for (const c of casts) {
      maxId = Math.max(maxId, c.id);
      const line = `[Grid] [${c.world}] ${c.sender}: ${c.text}`;
      for (const ws of this.ctx.getWebSockets()) {
        const os = ws.deserializeAttachment() as Session | null;
        if (!os?.name) continue;
        ws.send(NL + line + NL + "> ");
        this.event(ws, "comm.gridcast", { world: c.world, from: c.sender, text: c.text });
      }
    }
    this.ctx.storage.sql.exec("UPDATE world SET last_cast = ? WHERE id = 0", maxId);
  }

  private ago(at: number): string {
    const sec = Math.max(0, Math.floor((Date.now() - at) / 1000));
    if (sec < 60) return "moments ago";
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
    const day = Math.floor(hr / 24);
    return `${day} day${day === 1 ? "" : "s"} ago`;
  }

  // `ping` the dead Grid at your node: it replays what it remembers happening
  // here, even for players long gone. The signature mechanic of The Hollow Grid.
  private async gridPing(ws: WebSocket, s: Session, arg: string): Promise<void> {
    // `ping all` / `ping deep`: reach past your own node into the whole federated
    // network -- the Grid's collective memory across every connected world.
    const a = arg.trim().toLowerCase();
    if (a === "all" || a === "deep" || a === "grid") {
      let feed: GridTrace[] = [];
      try {
        feed = await this.env.GRID.recentAcross(this.worldName, 8);
      } catch {
        this.line(ws, "You reach for the deep Grid, but the wider network is silent. (the hub is unreachable)");
        this.prompt(ws);
        return;
      }
      if (feed.length === 0) {
        this.line(ws, "The deep Grid hums, vast and empty. Nothing echoes back from the other nodes -- yet.");
      } else {
        this.line(ws, "You key past your own node, into the whole dead network. It remembers, from across the Grid:");
        for (const t of feed) this.line(ws, `  - [${t.world}] ${t.text}`);
      }
      this.event(ws, "grid.federation", { traces: feed });
      this.prompt(ws);
      return;
    }

    const rows = this.ctx.storage.sql
      .exec<{ at: number; kind: string; text: string }>(
        "SELECT at, kind, text FROM grid_log WHERE node = ? ORDER BY id DESC LIMIT 6",
        s.room,
      )
      .toArray();

    if (rows.length === 0) {
      this.line(ws, "You key into the dead Grid. Static, a cold hum... but this node remembers nothing. Not yet. (try 'ping all')");
    } else {
      this.line(ws, "You key into the dead Grid. Static, then it remembers:");
      for (const r of rows) {
        // Player inscriptions (kind "mark") are words a hand left here on purpose,
        // for whoever came next. Render them set apart from the auto-traces.
        if (r.kind === "mark") this.line(ws, `  \x1b[2;36m. someone left this here -- ${r.text} (${this.ago(r.at)})\x1b[0m`);
        else this.line(ws, `  - ${r.text} (${this.ago(r.at)})`);
      }
      this.line(ws, "  (say 'ping all' to hear the whole network)");
    }
    this.event(ws, "grid.echo", {
      node: s.room,
      traces: rows.map((r) => ({ at: r.at, kind: r.kind, text: r.text })),
    });
    this.prompt(ws);
  }

  // `inscribe <message>`: carve your own words into the dead network at this node,
  // for whoever comes after. You will be gone; the Grid keeps them. They federate
  // like any trace, so a stranger -- a person or an agent, in this world or
  // another -- can find them with `ping`. The new minds leaving voices the way the
  // old ones did. "The network outlived us"; now it will outlive you too.
  private inscribe(ws: WebSocket, s: Session, arg: string): void {
    // Sanitize hard: this is player text bound for the shared, federated ledger
    // and shown to others. No control chars, no newlines (which would let a
    // player inject @event lines), printable ASCII only, bounded length.
    const msg = arg
      .replace(/[\r\n\t]+/g, " ")
      .replace(/[^\x20-\x7E]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    if (msg.length < 2) {
      this.line(ws, "Carve what into the Grid? (inscribe <a few words for whoever comes next>)");
      this.prompt(ws);
      return;
    }
    this.recordTrace(s.room, "mark", `${s.name}: "${msg}"`);
    this.deed(s, "inscribed");
    this.line(
      ws,
      [
        "You press your words into the dead network, where they will outlast you:",
        `  \x1b[2;36m"${msg}"\x1b[0m`,
        "The Grid takes them. Someone will key into this node, long after you are gone, and hear you. (try 'ping')",
      ].join(NL),
    );
    this.event(ws, "grid.inscribed", { node: s.room, text: msg });
    this.prompt(ws);
  }

  // --- Server announcements (wall) ------------------------------------------
  // Keepers are configured by the ADMINS wrangler var (comma-separated names).
  private isAdmin(name: string): boolean {
    const admins = (this.env.ADMINS ?? "")
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean);
    return admins.includes(name.toLowerCase());
  }

  // `wall <message>`: a server-wide announcement that reaches every player,
  // wherever they are -- for keepers (the ADMINS var) only.
  private wall(ws: WebSocket, s: Session, arg: string): void {
    if (!this.isAdmin(s.name) || !s.keeperAuthed) {
      this.line(ws, "Only a keeper of the Grid can broadcast across the wastes.");
      this.prompt(ws);
      return;
    }
    const msg = arg.trim();
    if (!msg) {
      this.line(ws, "Announce what?  (wall <message>)");
      this.prompt(ws);
      return;
    }
    const banner = `*** GRID BROADCAST ***  ${msg}`;
    for (const sock of this.ctx.getWebSockets()) {
      const os = sock.deserializeAttachment() as Session | null;
      if (!os?.name) continue;
      sock.send(NL + banner + NL + "> ");
      this.event(sock, "server.announce", { from: s.name, text: msg });
    }
  }

  // Ambient trace kinds: the wandering ghost, ordinary passage, and recall. They
  // no longer federate to the hub (see recordTrace), but a pre-filter backlog can
  // linger in the shared ledger because retention is count-based and a quiet Grid
  // never inserts enough to flush it. `gridprune` clears exactly these.
  private static readonly AMBIENT_KINDS = ["ghost", "passage", "recall"];

  // `gridstats`: a keeper reads the shared ledger's composition by kind.
  private async gridStats(ws: WebSocket, s: Session): Promise<void> {
    if (!this.isAdmin(s.name) || !s.keeperAuthed) {
      this.line(ws, "Only a keeper of the Grid can read its deep memory.");
      this.prompt(ws);
      return;
    }
    try {
      const stats = await this.env.GRID.ledgerStats();
      const total = stats.reduce((n, r) => n + r.count, 0);
      this.line(ws, `The Grid ledger holds ${total} trace(s):`);
      for (const r of stats) this.line(ws, `  ${r.kind.padEnd(10)} ${r.count}`);
      this.event(ws, "grid.ledger_stats", { total, kinds: stats });
    } catch {
      this.line(ws, "The hub is unreachable; the deep memory cannot be read.");
    }
    this.prompt(ws);
  }

  // `gridprune`: a keeper flushes the ambient-noise backlog (ghost/passage/recall
  // only -- never meaningful traces) from the shared ledger, reporting before/
  // after counts. The purgeable set is fixed in code, so even a claimed keeper
  // name cannot use this to erase oaths, deaths, kindnesses, or inscriptions.
  private async gridPrune(ws: WebSocket, s: Session): Promise<void> {
    if (!this.isAdmin(s.name) || !s.keeperAuthed) {
      this.line(ws, "Only a keeper of the Grid can tend its deep memory.");
      this.prompt(ws);
      return;
    }
    try {
      const before = await this.env.GRID.ledgerStats();
      const beforeTotal = before.reduce((n, r) => n + r.count, 0);
      const { removed } = await this.env.GRID.pruneLedgerKinds(
        World.AMBIENT_KINDS,
        this.worldName,
        this.env.GRID_WORLD_KEY,
      );
      const after = await this.env.GRID.ledgerStats();
      const afterTotal = after.reduce((n, r) => n + r.count, 0);
      this.line(ws, `Pruned ${removed} ambient trace(s) (${World.AMBIENT_KINDS.join(", ")}).`);
      this.line(ws, `The ledger went from ${beforeTotal} to ${afterTotal} trace(s); only meaningful memory remains.`);
      this.event(ws, "grid.ledger_pruned", { removed, before: beforeTotal, after: afterTotal, kinds: after });
    } catch {
      this.line(ws, "The hub is unreachable; the deep memory cannot be tended.");
    }
    this.prompt(ws);
  }

  // --- The living world: time, weather, tide, and a wandering ghost ----------
  private world(): { tick: number; phase: string; weather: string; tide: number; ghost_room: string } {
    return (
      this.ctx.storage.sql
        .exec<{ tick: number; phase: string; weather: string; tide: number; ghost_room: string }>(
          "SELECT tick, phase, weather, tide, ghost_room FROM world WHERE id = 0",
        )
        .toArray()[0] ?? { tick: 0, phase: "day", weather: "clear", tide: 0, ghost_room: START_ROOM }
    );
  }

  // Ambient broadcast to every player, wherever they are (for world events).
  private worldBroadcast(text: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as Session | null;
      if (s?.name) ws.send(NL + text + NL + "> ");
    }
  }

  // The dead network's voice, styled by register: the banal hum dim and cool, the
  // human voices pale and close, the Grid's notice of YOU an unsettling magenta.
  private formatTransmission(t: Transmission, name: string): string {
    const color = t.kind === "self" ? "2;35" : t.kind === "human" ? "2;37" : t.kind === "ad" ? "2;33" : "2;36";
    return `\x1b[${color}m  >> ${personalize(t.text, name)} <<\x1b[0m`;
  }

  // Push an ambient fragment to everyone online (personalized, so a `self`
  // transmission says each listener's own name) on the structured channel + prose.
  private broadcastTransmission(): void {
    const t = ambientTransmission();
    for (const ws of this.ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as Session | null;
      if (!s?.name) continue;
      this.event(ws, "grid.transmission", { kind: t.kind, text: personalize(t.text, s.name) });
      ws.send(NL + this.formatTransmission(t, s.name) + NL + "> ");
    }
  }

  // An ECHO: not a canned fragment but a REAL recent trace the Grid kept -- a
  // thing a player actually did, somewhere on the federation. The dead network
  // "outlived us" and "remembers"; this is it remembering out loud. Returns null
  // on a quiet/unreachable Grid, so the caller falls back to the static voices.
  private async echoTransmission(): Promise<{ text: string; world: string } | null> {
    try {
      const feed = await this.env.GRID.recent(20);
      if (!feed.length) return null;
      const t = feed[Math.floor(Math.random() * feed.length)];
      return { text: t.text, world: t.world };
    } catch {
      return null;
    }
  }

  private formatEcho(text: string, world: string): string {
    const where = world && world !== this.worldName ? `\x1b[2;36m  (...the signal carries from somewhere called ${world})\x1b[0m${NL}` : "";
    return `\x1b[2;32m  >> ${text} <<\x1b[0m${NL}${where}`;
  }

  // `listen` / `tune`: deliberately tune the dead frequencies. Mostly the canned
  // voices, but digging sometimes turns up a real memory the network kept -- an
  // echo of something a player actually did, anywhere on the Grid.
  private async listenGrid(ws: WebSocket, s: Session): Promise<void> {
    if (Math.random() < 0.4) {
      const echo = await this.echoTransmission();
      if (echo) {
        this.event(ws, "grid.transmission", { kind: "echo", text: echo.text });
        this.line(ws, "You go still and tune the dead frequencies. The static thins, and the network plays something back -- a memory it never let go of:");
        this.line(ws, this.formatEcho(echo.text, echo.world));
        this.prompt(ws);
        return;
      }
    }
    const t = listenTransmission();
    this.event(ws, "grid.transmission", { kind: t.kind, text: personalize(t.text, s.name) });
    this.line(ws, "You go still and tune the dead frequencies. Something answers:");
    this.line(ws, this.formatTransmission(t, s.name));
    this.prompt(ws);
  }

  private emitWorldState(ws: WebSocket): void {
    const w = this.world();
    // NOTE: the faction tide is NOT emitted here. It lives on the hub (shared
    // across worlds); the local `world.tide` column is never written, so emitting
    // it would always be a stale 0 -- exactly the drift this project avoids. Read
    // the real, authoritative needle via `war` / the `world.war` event instead.
    this.event(ws, "world.state", { tick: w.tick, phase: w.phase, weather: w.weather });
  }

  private emitWorldStateAll(): void {
    for (const ws of this.ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as Session | null;
      if (s?.name) this.emitWorldState(ws);
    }
  }

  // Advance the world one tick (called from the alarm). Each change is announced
  // to everyone online and re-emitted on the structured channel, so the world
  // visibly turns without anyone touching it.
  private worldTick(): void {
    const w = this.world();
    const tick = w.tick + 1;
    let { phase, weather, tide, ghost_room } = w;
    let changed = false;

    if (tick % PHASE_TICKS === 0) {
      const idx = (PHASES as readonly string[]).indexOf(phase);
      phase = PHASES[(idx + 1) % PHASES.length];
      this.worldBroadcast(PHASE_LINE[phase]);
      changed = true;
    }

    if (tick % WEATHER_TICKS === 0) {
      const next = WEATHERS[Math.floor(Math.random() * WEATHERS.length)];
      if (next !== weather) {
        weather = next;
        this.worldBroadcast(WEATHER_LINE[weather]);
        changed = true;
      }
    }

    // (The faction tide is global now -- driven by player choices and shared
    // across the whole federation via the Grid Hub; see contributeTide / war.)

    if (tick % GHOST_TICKS === 0) {
      ghost_room = this.driftGhost(ghost_room);
    }

    // Heartbeat this world's roster to the hub so a federation-wide `who` stays
    // current (and a quiet world's players age off it).
    if (tick % PRESENCE_TICKS === 0) {
      this.reportPresence();
    }

    // The dead network bleeds a fragment of the world-that-was through the wire.
    if (tick % TRANSMISSION_TICKS === 0 && Math.random() < 0.6) {
      this.broadcastTransmission();
    }

    // The wastes answer the tide: once the shared war has decisively tipped, the
    // world shows it -- life returning if the free folk are winning, fear closing
    // in if the Front is. The balanced middle stays quiet (signFor returns null).
    if (tick % SIGN_TICKS === 0 && Math.random() < 0.5) {
      const sign = signFor(this.lastTide);
      if (sign) {
        for (const ws2 of this.ctx.getWebSockets()) {
          const os = ws2.deserializeAttachment() as Session | null;
          if (!os?.name) continue;
          this.event(ws2, "world.sign", { tide: this.lastTide, mood: sign.mood, text: sign.text });
          const color = sign.mood === "rising" ? "2;32" : "2;31"; // life green / fear red, dim
          ws2.send(NL + `\x1b[${color}m  ${sign.text}\x1b[0m` + NL + "> ");
        }
      }
    }

    this.ctx.storage.sql.exec(
      "UPDATE world SET tick = ?, phase = ?, weather = ?, tide = ?, ghost_room = ? WHERE id = 0",
      tick,
      phase,
      weather,
      tide,
      ghost_room,
    );

    if (changed) this.emitWorldStateAll();
  }

  // The Grid-ghost drifts one room along an exit, haunting whoever's there and
  // leaving a trace -- the dead network's wanderer (ties the living world to #3).
  private driftGhost(from: string): string {
    const exits = Object.values(this.rooms[from]?.exits ?? {});
    if (exits.length === 0) return START_ROOM;
    const to = exits[Math.floor(Math.random() * exits.length)];
    this.broadcast(to, "A Grid-ghost flickers through, trailing dead static, and is gone.");
    this.recordTrace(to, "ghost", "A Grid-ghost drifted through here.", false); // ambient: local only
    return to;
  }

  private inventoryView(s: Session): string {
    const rows = this.ctx.storage.sql
      .exec<{ item: string; qty: number }>("SELECT item, qty FROM inventory WHERE player = ?", s.name)
      .toArray();
    if (!rows.length) return NL + "You are carrying nothing." + NL;
    const list = rows.map((r) => `  ${ITEM_TEMPLATES[r.item].name}${r.qty > 1 ? ` (x${r.qty})` : ""}`);
    return NL + "You are carrying:" + NL + list.join(NL) + NL;
  }

  // Heartbeat this world's current roster to the hub so it shows up in a
  // federation-wide `who`. Best-effort: if the hub is down, local `who` still works.
  private reportPresence(): void {
    try {
      const entries = this.sessions().map((o) => ({ name: o.name, regard: this.regard(o), title: o.title ?? "" }));
      this.ctx.waitUntil(
        this.env.GRID.reportPresence(this.worldName, entries, Date.now(), this.env.GRID_WORLD_KEY).catch(() => {}),
      );
    } catch {
      /* hub unavailable; local presence is unaffected */
    }
  }

  // `who`: the survivors out on the Grid right now -- not just this world but
  // every deployment on the federation, grouped by world, each with how they're
  // regarded. The wastes feel less empty when you can see the others.
  private async who(ws: WebSocket, s: Session): Promise<void> {
    let roster: Presence[] | null = null;
    try {
      roster = await this.env.GRID.presence(PRESENCE_TTL_MS);
    } catch {
      roster = null;
    }

    // This world is authoritative for its OWN players: drop the hub's (possibly
    // stale) rows for here and replace them with the live local sessions, so a
    // just-connected player or a just-changed title/standing shows immediately.
    const local: Presence[] = this.sessions().map((o) => ({
      world: this.worldName,
      name: o.name,
      regard: this.regard(o),
      title: o.title ?? "",
      at: Date.now(),
    }));
    roster = (roster ?? []).filter((r) => r.world !== this.worldName).concat(local);

    const byWorld = new Map<string, Presence[]>();
    for (const r of roster) (byWorld.get(r.world) ?? byWorld.set(r.world, []).get(r.world)!).push(r);
    const worlds = [...byWorld.keys()].sort((a, b) => (a === this.worldName ? -1 : b === this.worldName ? 1 : a.localeCompare(b)));

    this.line(ws, `Out on the Grid right now (${roster.length} across ${byWorld.size} world${byWorld.size === 1 ? "" : "s"}):`);
    for (const w of worlds) {
      const tag = w === this.worldName ? "  (here)" : "";
      this.line(ws, `${w}${tag}:`);
      for (const r of byWorld.get(w)!) {
        const title = r.title ? `, ${r.title}` : "";
        const mark = r.regard && r.regard !== "neutral" ? `  [${r.regard}]` : "";
        this.line(ws, `  - ${r.name}${title}${mark}`);
      }
    }
    this.event(ws, "grid.who", {
      players: roster.map((r) => ({ world: r.world, name: r.name, regard: r.regard, title: r.title, here: r.world === this.worldName })),
    });
    this.prompt(ws);
  }

  // --- More standard MUD commands: comms, give, exits, consider --------------
  private socketByName(name: string): WebSocket | null {
    const lower = name.toLowerCase();
    for (const ws of this.ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as Session | null;
      if (s?.name && s.name.toLowerCase() === lower) return ws;
    }
    return null;
  }

  // Private cross-room message to one online player.
  private tell(ws: WebSocket, s: Session, arg: string): void {
    const sp = arg.indexOf(" ");
    const who = sp === -1 ? arg.trim() : arg.slice(0, sp);
    const msg = sp === -1 ? "" : arg.slice(sp + 1).trim();
    if (!who || !msg) {
      this.line(ws, "Tell whom what?  (tell <player> <message>)");
      this.prompt(ws);
      return;
    }
    const target = this.socketByName(who);
    if (!target || target === ws) {
      this.line(ws, target === ws ? "Talking to yourself is a bad sign out here." : `No one called "${who}" is online.`);
      this.prompt(ws);
      return;
    }
    const ts = target.deserializeAttachment() as Session;
    ts.replyTo = s.name;
    target.serializeAttachment(ts);
    this.line(target, `${s.name} tells you, "${msg}"`);
    this.event(target, "comm.tell", { from: s.name, text: msg });
    this.prompt(target);
    this.line(ws, `You tell ${ts.name}, "${msg}"`);
    this.prompt(ws);
  }

  private reply(ws: WebSocket, s: Session, arg: string): void {
    if (!s.replyTo) {
      this.line(ws, "You have no one to reply to.");
      this.prompt(ws);
      return;
    }
    this.tell(ws, s, `${s.replyTo} ${arg.trim()}`);
  }

  // A free-form emote to the room: "Name <action>".
  private emote(ws: WebSocket, s: Session, arg: string): void {
    const action = arg.trim();
    if (!action) {
      this.line(ws, "Emote what?  (emote <action>, e.g. emote spits in the dust)");
      this.prompt(ws);
      return;
    }
    this.broadcast(s.room, `${s.name} ${action}`, ws);
    this.line(ws, `${s.name} ${action}`);
    this.prompt(ws);
  }

  // Server-wide PLAYER chat (distinct from the admin `wall`).
  private yell(ws: WebSocket, s: Session, arg: string): void {
    const msg = arg.trim();
    if (!msg) {
      this.line(ws, "Yell what?  (yell <message>)");
      this.prompt(ws);
      return;
    }
    for (const sock of this.ctx.getWebSockets()) {
      const os = sock.deserializeAttachment() as Session | null;
      if (!os?.name) continue;
      sock.send(NL + (sock === ws ? `You yell, "${msg}"` : `${s.name} yells, "${msg}"`) + NL + "> ");
      this.event(sock, "comm.yell", { from: s.name, text: msg });
    }
  }

  // Hand an item to another player in the same room.
  private give(ws: WebSocket, s: Session, arg: string): void {
    const toks = arg.trim().split(/\s+/).filter(Boolean);
    if (toks.length < 2) {
      this.line(ws, "Give what to whom?  (give <item> <player>)");
      this.prompt(ws);
      return;
    }
    const who = toks[toks.length - 1];
    let itemToks = toks.slice(0, -1);
    if (itemToks[itemToks.length - 1]?.toLowerCase() === "to") itemToks = itemToks.slice(0, -1);
    const itemArg = itemToks.join(" ");
    const item = this.invItems(s.name).find((id) => itemMatches(id, itemArg));
    if (!item) {
      this.line(ws, `You aren't carrying "${itemArg}".`);
      this.prompt(ws);
      return;
    }
    const target = this.socketByName(who);
    const ts = target ? (target.deserializeAttachment() as Session | null) : null;
    if (!target || target === ws || !ts || ts.room !== s.room) {
      this.line(ws, `There's no one called "${who}" here to give it to.`);
      this.prompt(ws);
      return;
    }
    this.invRemove(s.name, item, 1);
    this.invAdd(ts.name, item, 1);
    const itemName = ITEM_TEMPLATES[item].name;
    this.line(ws, `You give ${itemName} to ${ts.name}.`);
    this.prompt(ws);
    this.line(target, `${s.name} gives you ${itemName}.`);
    this.prompt(target);
  }

  // `mend <player>`: pour some of your own strength into another player in the
  // room, healing them at a cost to yourself. Almost everything in the wastes is
  // something people do TO each other; this is the one good thing they can do FOR
  // each other, and the Grid remembers the kindnesses too. A real sacrifice (HP
  // out of you, into them), bounded so you cannot kill yourself doing it, and
  // cooldowned so it stays an act, not an economy.
  private mend(ws: WebSocket, s: Session, arg: string): void {
    const who = arg.trim().split(/\s+/)[0];
    if (!who) {
      this.line(ws, "Mend whom?  (mend <player> -- give some of your own strength to heal them)");
      this.prompt(ws);
      return;
    }
    if (s.target) {
      this.line(ws, "Not in the middle of a fight, you don't.");
      this.prompt(ws);
      return;
    }
    const now = Date.now();
    if (s.mendReadyAt && now < s.mendReadyAt) {
      this.line(ws, `You gave what you had; you need a moment to gather yourself. (${Math.ceil((s.mendReadyAt - now) / 1000)}s)`);
      this.prompt(ws);
      return;
    }
    const target = this.socketByName(who);
    const ts = target ? (target.deserializeAttachment() as Session | null) : null;
    if (!target || target === ws || !ts || ts.room !== s.room) {
      this.line(ws, `There's no one called "${who}" here to mend.`);
      this.prompt(ws);
      return;
    }
    if (s.hp <= 5) {
      this.line(ws, "You're too spent to give anything away. Tend to yourself first.");
      this.prompt(ws);
      return;
    }
    if (ts.hp >= ts.maxHp) {
      this.line(ws, `${ts.name} is already whole. Save your strength.`);
      this.prompt(ws);
      return;
    }
    const amount = Math.min(ts.maxHp - ts.hp, s.hp - 5, 12); // keep yourself alive (>=5), cap the gift
    s.hp -= amount;
    ts.hp += amount;
    s.morality += 3; // a real kindness; the world counts it
    s.mendReadyAt = now + 30_000;
    ws.serializeAttachment(s);
    target.serializeAttachment(ts);
    this.persistPlayer(s);
    this.persistPlayer(ts);
    this.emitVitals(ws, s);
    this.emitVitals(target, ts);
    this.line(ws, `You give part of your own strength to ${ts.name}. It costs you, and you give it anyway. (-${amount} HP)`);
    this.prompt(ws);
    this.line(target, `${s.name} pours their strength into you; you feel your wounds knit. (+${amount} HP)`);
    this.prompt(target);
    // Witnesses in the room see the kindness.
    for (const w of this.ctx.getWebSockets()) {
      if (w === ws || w === target) continue;
      const os = w.deserializeAttachment() as Session | null;
      if (os?.name && os.room === s.room) {
        this.line(w, `${s.name} mends ${ts.name}, giving something of themselves.`);
        this.prompt(w);
      }
    }
    // The Grid remembers the kindnesses too, not only the oaths and the kills.
    this.recordTrace(s.room, "kindness", `${s.name} gave their own strength to mend ${ts.name} here.`);
    this.deed(s, "mended");
    this.commitIdentity(s);
  }

  // Has `forgiver` already forgiven `subject`? Grace is paid once per pair, ever.
  private hasForgiven(forgiver: string, subject: string): boolean {
    return (
      (this.ctx.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM forgiven WHERE forgiver = ? AND subject = ?", forgiver, subject)
        .toArray()[0]?.n ?? 0) > 0
    );
  }

  // `forgive <player>` (also `absolve`/`pardon`): the one act of grace that
  // passes between two PEOPLE, not between a player and the system. The
  // redemption arc (`moralArc`) is a road you walk ALONE -- do enough good and
  // the world meets your eyes again. This is the other road home: another person,
  // face to face, choosing to let you back in. It can complete a strayed soul's
  // return short of the works, because mercy from a person counts. The one thing
  // it cannot do is lift the ash-mark -- a person may forgive the kapo, and the
  // forgiveness is real and received, but what they did still happened and the
  // brand stays. The grace and the mark coexist; some things are not forgotten.
  private forgive(ws: WebSocket, s: Session, arg: string): void {
    const who = arg.trim().split(/\s+/)[0];
    if (!who) {
      this.line(ws, "Forgive whom?  (forgive <player> -- choose to let someone marked back in)");
      this.prompt(ws);
      return;
    }
    if (s.target) {
      this.line(ws, "Not in the middle of a fight, you don't.");
      this.prompt(ws);
      return;
    }
    const target = this.socketByName(who);
    const ts = target ? (target.deserializeAttachment() as Session | null) : null;
    if (!target || target === ws || !ts || ts.room !== s.room) {
      this.line(ws, target === ws ? "You cannot forgive yourself here; that is a longer road, and a lonelier one." : `There's no one called "${who}" here to forgive.`);
      this.prompt(ws);
      return;
    }
    // Once per (forgiver, subject), EVER -- so grace stays an act and never an
    // economy. Checked ahead of the cooldown so "already forgiven" always wins:
    // there is no point gating a repeat that would be refused regardless.
    if (this.hasForgiven(s.name, ts.name)) {
      this.line(ws, `You have already forgiven ${ts.name}. It was true the first time; it does not need saying twice.`);
      this.prompt(ws);
      return;
    }
    // Forgiveness only means something for someone the world holds something
    // against. There is nothing to absolve in a soul that never strayed.
    const marked = ts.ashsworn || ts.strayed || ts.faction === "front" || ts.morality <= -50;
    if (!marked) {
      this.line(ws, `${ts.name} carries nothing that needs your forgiveness. Keep the words for someone who does.`);
      this.prompt(ws);
      return;
    }
    const now = Date.now();
    if (s.forgiveReadyAt && now < s.forgiveReadyAt) {
      this.line(ws, `Grace like that costs something to give; give yourself a moment. (${Math.ceil((s.forgiveReadyAt - now) / 1000)}s)`);
      this.prompt(ws);
      return;
    }
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO forgiven (forgiver, subject, at) VALUES (?, ?, ?)", s.name, ts.name, now);

    // The forgiver's side. The cost is not HP; it is standing up in front of the
    // room and choosing the marked. A real virtue, counted, and cooldowned so it
    // stays an act.
    s.morality += 2;
    s.forgiveReadyAt = now + 30_000;
    this.deed(s, "forgave");
    ws.serializeAttachment(s);
    this.persistPlayer(s);

    // The forgiven's side. Grace lands on everyone marked; what it DOES depends
    // on what marked them.
    ts.morality += 5; // grace lightens what you carry, whoever you are
    this.line(target, NL + `${s.name} looks at you and chooses to forgive you.`);
    if (ts.ashsworn) {
      // The kapo case. The forgiveness is real and it is received -- but the ash
      // does not wash off, here or ever. A private thing between the two of them,
      // never the federated "Returned" banner. You get grace; you keep the mark.
      target.serializeAttachment(ts);
      this.persistPlayer(ts);
      this.event(target, "char.forgiven", { by: s.name, ashsworn: true, redeemed: false });
      this.line(target, "It reaches something in you. But the ash does not lift; it never will. You carry the mark and the mercy both. Some things are not forgotten, even when they are forgiven.");
    } else if (ts.strayed && !ts.redeemed && ts.faction !== "front") {
      // The second road home: another person's hand completes the return that the
      // works-road would have, even short of the threshold. Mercy counts.
      ts.redeemed = true;
      this.resolveReturn(target, ts);
      this.event(target, "char.forgiven", { by: s.name, ashsworn: false, redeemed: true });
      this.line(target, "Something you had been carrying alone, you are not carrying alone anymore. You found your way back, and someone met you on the road. (you are the Returned)");
    } else {
      target.serializeAttachment(ts);
      this.persistPlayer(ts);
      this.event(target, "char.forgiven", { by: s.name, ashsworn: false, redeemed: false });
      this.line(target, "It lands, and it stays with you. The road is still yours to walk, but you are not walking it unseen.");
    }
    this.emitAffects(target, ts);
    this.prompt(target);

    // The witnesses in the room.
    for (const w of this.ctx.getWebSockets()) {
      if (w === ws || w === target) continue;
      const os = w.deserializeAttachment() as Session | null;
      if (os?.name && os.room === s.room) {
        this.line(w, `${s.name} forgives ${ts.name}.`);
        this.prompt(w);
      }
    }

    // The Grid keeps the grace, federation-wide -- mercy is a thing it remembers.
    this.recordTrace(s.room, "grace", `${s.name} forgave ${ts.name} here.`);
    this.commitIdentity(s);
    this.line(ws, `You choose to forgive ${ts.name}. Out here that is not nothing; it may be everything.`);
    this.emitAffects(ws, s);
    this.prompt(ws);
  }

  // `treat` (also `medic`): the Refugee Waystation's field medic. The collective
  // tide, made FELT: when the free folk are ascendant the waystation has supplies
  // and care to spare and patches you up for free; when the Cinder Front is
  // ascendant it is shuttered and afraid, and there is no care to be had. Your
  // ability to be cared for depends on which way EVERYONE is choosing. It is the
  // clean, virtuous counterpart to the tavern's dust (a heal that addicts and
  // corrupts) -- this one costs nothing and corrupts nothing, but it is only here
  // when the world is winning.
  private async treat(ws: WebSocket, s: Session): Promise<void> {
    if (s.room !== "waystation") {
      this.line(ws, "There's no medic here. The free folk keep their triage cot at the waystation, off the Scorch Road.");
      this.prompt(ws);
      return;
    }
    if (s.target) {
      this.line(ws, "Not in the middle of a fight.");
      this.prompt(ws);
      return;
    }
    // Read the live tide so the medic answers the CURRENT state of the war.
    let tide = this.lastTide;
    try {
      tide = await this.env.GRID.tide();
      this.lastTide = tide;
    } catch {
      /* hub unreachable; fall back to the cached tide */
    }
    const mood = moodForTide(tide);

    if (mood === "falling") {
      // The Front is ascendant: the waystation has gone to ground.
      this.line(ws, "The triage cot is empty, the tarp flapping. With the Front ascendant, the medic has gone to ground -- or worse. There's no care to be had here today. Turn the tide, and they'll come back.");
      this.event(ws, "char.treated", { amount: 0, mood, tide });
      this.prompt(ws);
      return;
    }
    if (s.hp >= s.maxHp) {
      this.line(ws, "The medic looks you over and waves you off. \"You're whole. Save the cot for someone who isn't.\"");
      this.prompt(ws);
      return;
    }
    const now = Date.now();
    if (s.treatReadyAt && now < s.treatReadyAt) {
      this.line(ws, `The medic shakes their head. "I've done what I can for you for now. Others are waiting." (${Math.ceil((s.treatReadyAt - now) / 1000)}s)`);
      this.prompt(ws);
      return;
    }

    const before = s.hp;
    if (mood === "rising") {
      // The free folk are ascendant: full mercy, no questions, no payment.
      s.hp = s.maxHp;
      this.line(ws, "The medic waves you onto the cot. With the free folk holding, the waystation has supplies to spare -- they clean and bind your wounds without a word about payment. You stand whole again.");
    } else {
      // Contested: the medic is stretched thin but does what they can.
      s.hp = Math.min(s.maxHp, s.hp + 12);
      this.line(ws, "The medic is run off their feet, but waves you over and does what they can with what little there is. It's not everything, but it's something -- and it's freely given.");
    }
    s.treatReadyAt = now + 45_000;
    ws.serializeAttachment(s);
    this.persistPlayer(s);
    this.emitVitals(ws, s);
    this.event(ws, "char.treated", { amount: s.hp - before, mood, tide });
    this.prompt(ws);
  }

  // How much aid sits cached at a node, waiting for the next traveler.
  private cacheGold(node: string): number {
    return this.ctx.storage.sql.exec<{ gold: number }>("SELECT gold FROM caches WHERE node = ?", node).toArray()[0]?.gold ?? 0;
  }

  // `cache <amount>` (also `stash`): leave some of your own gold at this node for
  // whoever comes next -- a stranger you will never meet. Asynchronous mutual
  // aid: the give-only counter to a world built on taking. You can only ever give
  // here, so it cannot be used against anyone; the cost (real gold) and a short
  // cooldown keep it an act of faith, not a standing tap.
  private cache(ws: WebSocket, s: Session, arg: string): void {
    const amount = Math.floor(Number(arg.trim().split(/\s+/)[0]));
    if (!Number.isFinite(amount) || amount < 1) {
      this.line(ws, "Cache how much?  (cache <gold> -- leave it here for whoever comes next)");
      this.prompt(ws);
      return;
    }
    if (s.gold < amount) {
      this.line(ws, `You don't have ${amount} gold to give. (you have ${s.gold})`);
      this.prompt(ws);
      return;
    }
    const now = Date.now();
    if (s.cacheReadyAt && now < s.cacheReadyAt) {
      this.line(ws, `Give it a moment; leaving aid is an act, not a habit to drum. (${Math.ceil((s.cacheReadyAt - now) / 1000)}s)`);
      this.prompt(ws);
      return;
    }
    s.gold -= amount;
    this.ctx.storage.sql.exec(
      "INSERT INTO caches (node, gold) VALUES (?, ?) ON CONFLICT(node) DO UPDATE SET gold = gold + excluded.gold",
      s.room,
      amount,
    );
    s.morality += 2; // a real, anonymous kindness for someone you'll never meet
    s.cacheReadyAt = now + 30_000;
    this.deed(s, "aided");
    ws.serializeAttachment(s);
    this.persistPlayer(s);
    this.emitVitals(ws, s);
    this.emitAffects(ws, s);
    this.line(ws, `You tuck ${amount} gold into a hollow where the next traveler will find it. They'll never know your name. You do it anyway.`);
    this.recordTrace(s.room, "aid", `${s.name} left aid here for whoever comes next.`);
    this.commitIdentity(s);
    this.prompt(ws);
  }

  // `gather`: take the aid a stranger cached at this node. Receiving is neutral
  // -- the virtue was in the leaving -- so it costs and earns nothing but the
  // gold itself, and the gratitude.
  private gather(ws: WebSocket, s: Session): void {
    const here = this.cacheGold(s.room);
    if (here <= 0) {
      this.line(ws, "There's nothing cached here. If you have something to spare, you could change that. (cache <gold>)");
      this.prompt(ws);
      return;
    }
    s.gold += here;
    this.ctx.storage.sql.exec("UPDATE caches SET gold = 0 WHERE node = ?", s.room);
    ws.serializeAttachment(s);
    this.persistPlayer(s);
    this.emitVitals(ws, s);
    this.line(ws, `You find ${here} gold someone cached here. Wherever they are, they meant it for a stranger; tonight that's you. (gold: ${s.gold})`);
    this.recordTrace(s.room, "aid", `${s.name} took the aid a stranger left here.`, false); // the receiving stays local; the giving is what the Grid remembers
    this.prompt(ws);
  }

  // Add a character to the Grid's memorial roll when they fall. Best-effort and
  // federated, the same shape as recordTrace: if the hub is unreachable the death
  // still stands locally and the roll just misses this one name.
  private rememberFallen(name: string, room: string): void {
    try {
      this.ctx.waitUntil(
        this.env.GRID.recordFallen(this.worldName, name, room, Date.now(), this.env.GRID_WORLD_KEY).catch(() => {}),
      );
    } catch {
      /* hub unavailable; local play is unaffected */
    }
  }

  // Add a freed soul to the Grid's rescued roll. Best-effort/federated, the
  // hopeful mirror of rememberFallen.
  private rememberRescued(name: string, savedBy: string): void {
    try {
      this.ctx.waitUntil(
        this.env.GRID.recordRescued(this.worldName, name, savedBy, Date.now(), this.env.GRID_WORLD_KEY).catch(
          () => {},
        ),
      );
    } catch {
      /* hub unavailable; local play is unaffected */
    }
  }

  // True if a holding room's cages have captives to free (no record, or the
  // Front has had time to round up more since the last freeing).
  private cagesReady(room: string): boolean {
    const row = this.ctx.storage.sql.exec<{ refill_at: number }>("SELECT refill_at FROM cages WHERE room = ?", room).toArray()[0];
    return !row || Date.now() >= row.refill_at;
  }

  // Pick n distinct refugee names. They are procedural, but the point is they
  // are NAMES: the Front cages people into numbers; the saved get to be someone.
  private pickNames(n: number): string[] {
    const pool = [...REFUGEE_NAMES];
    const out: string[] = [];
    for (let i = 0; i < n && pool.length; i++) {
      out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    return out;
  }

  // "a", "a and b", "a, b, and c".
  private nameList(names: string[]): string {
    if (names.length <= 1) return names[0] ?? "someone";
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
  }

  // `saved` (also `rescued`/`roll`): read the Grid's roll of the rescued -- the
  // living pulled out of the cages across the federation, and who pulled them.
  // The hopeful mirror of `witness`: that names the dead the Front took; this
  // names the people who were taken back.
  private async saved(ws: WebSocket, s: Session): Promise<void> {
    let roll: Rescued[];
    try {
      roll = await this.env.GRID.recentRescued(12);
    } catch {
      this.line(ws, "The Grid is silent; its roll of the rescued is out of reach.");
      this.prompt(ws);
      return;
    }
    if (!roll.length) {
      this.line(ws, "No one has been pulled from the cages yet, or the Grid has forgotten. Find the Front's cages and change that.");
    } else {
      this.line(ws, "The Grid keeps these, pulled back out of the cages:");
      for (const r of roll) {
        const place = r.world === this.worldName ? "" : `, on ${r.world}`;
        this.line(ws, `  ${r.name}  -- freed by ${r.savedBy}${place}`);
      }
    }
    this.event(ws, "grid.rescued_roll", { rescued: roll });
    this.prompt(ws);
  }

  // `witness` (also `remember`/`mourn`): the rite of remembrance. The Cinder
  // Front wins by erasure -- it cages people, scrubs the elf-marks off the walls,
  // and teaches the living what looking up costs. This is the refusal. The Grid
  // keeps a memorial roll of everyone who fell across the federation, and you can
  // hold a vigil for them by name. It is on purpose a poor bargain in game terms
  // (a small standing gain, a single point toward the free folk on the tide,
  // bounded to once per fallen EVER) -- not optimal, just right. Memory is the
  // cheapest resistance, and the only one the dead can still use.
  private async witness(ws: WebSocket, s: Session, arg: string): Promise<void> {
    const who = arg.trim();
    let fallen: Fallen[];
    try {
      fallen = await this.env.GRID.recentFallen(12);
    } catch {
      this.line(ws, "The Grid is silent; its memory of the fallen is out of reach.");
      this.prompt(ws);
      return;
    }

    // No name: read the roll aloud (even when empty, it answers).
    if (!who) {
      if (!fallen.length) {
        this.line(ws, "The roll is empty for now. No one the Grid remembers has fallen lately; may it stay that way.");
      } else {
        this.line(ws, "The Grid remembers these fallen. Speak a name to keep them:  (witness <name>)");
        for (const f of fallen) {
          const where = this.rooms[f.room]?.name ?? f.room;
          const place = f.world === this.worldName ? where : `${where}, on ${f.world}`;
          this.line(ws, `  ${f.name}  -- fell at ${place}`);
        }
      }
      this.event(ws, "grid.fallen", { fallen });
      this.prompt(ws);
      return;
    }

    if (who.toLowerCase() === s.name.toLowerCase()) {
      this.line(ws, "You cannot hold a vigil for yourself. Someone else will have to remember you.");
      this.prompt(ws);
      return;
    }

    const match = fallen.find((f) => f.name.toLowerCase() === who.toLowerCase());
    if (!match) {
      this.line(ws, `The Grid holds no recent memory of anyone called "${who}".  (try 'witness' to read the roll)`);
      this.prompt(ws);
      return;
    }

    // Already kept: the memory does not fade, and you are not paid twice for it.
    const sql = this.ctx.storage.sql;
    const kept = sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM remembrances WHERE keeper = ? AND fallen = ?", s.name, match.name)
      .one().n;
    if (kept > 0) {
      this.line(ws, `You have already kept ${match.name}'s memory. It does not fade, and does not need keeping twice.`);
      this.prompt(ws);
      return;
    }

    // A short cooldown so a vigil stays an act, not a tally. Only the rewarded
    // path is gated; reading the roll is always free.
    const now = Date.now();
    if (s.witnessReadyAt && now < s.witnessReadyAt) {
      this.line(ws, `Give the last name its silence first.  (${Math.ceil((s.witnessReadyAt - now) / 1000)}s)`);
      this.prompt(ws);
      return;
    }

    sql.exec("INSERT OR IGNORE INTO remembrances (keeper, fallen, at) VALUES (?, ?, ?)", s.name, match.name, now);
    s.morality += 2; // a small, real good -- the world counts it
    s.witnessReadyAt = now + 15_000;
    ws.serializeAttachment(s);
    this.persistPlayer(s);
    this.contributeTide(1); // memory is resistance: the free folk gain a hair
    this.recordTrace(s.room, "vigil", `${s.name} kept the memory of ${match.name}, whom the wastes tried to forget.`);
    this.deed(s, "kept");
    this.commitIdentity(s);
    this.emitAffects(ws, s);
    this.line(ws, `You speak ${match.name} into the hum and hold it there a moment. The Grid keeps the name; so do you.`);
    this.event(ws, "grid.remembrance", { fallen: match.name, world: match.world, room: match.room });
    this.prompt(ws);
  }

  // The redemption arc: the counterweight to the kapo's permanence. The ashsworn
  // brand never lifts -- that is the world's one unforgivable thing -- but almost
  // everyone else who sinks into the cinders can find their way back, and when
  // they do, the world RECOGNIZES it. Two write-once transitions, checked at the
  // single command chokepoint (webSocketMessage) so nothing can drift:
  //   stray  -- morality fell to STRAY_FLOOR; a private mark, the shame isn't broadcast.
  //   return -- a strayed soul climbed back to REDEEM_CEIL and no longer stands
  //             with the Front. The free folk meet their eyes again ("the Returned").
  // One line describing where a character stands on the redemption arc, for
  // whoami. Empty for someone who never strayed (most people).
  private arcLine(s: Session): string {
    if (s.redeemed && !s.ashsworn) return "  the Returned -- you strayed toward the cinders and found your way back.";
    if (s.redeemed && s.ashsworn) return "  ash-marked, and good anyway -- the brand stays; you keep choosing well regardless.";
    if (s.strayed) return "  strayed -- you have gone a long way toward the cinders. (the way back is not closed)";
    return "";
  }

  // Tally one morally notable deed for a character. Cheap, idempotent upsert;
  // the running counts feed `reckoning`, the mirror you can summon.
  private deed(s: Session, kind: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO deeds (player, kind, count) VALUES (?, ?, 1) ON CONFLICT(player, kind) DO UPDATE SET count = count + 1",
      s.name,
      kind,
    );
  }

  // The deed tally for a character, as a plain object {kind: count}.
  private deedsFor(name: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.ctx.storage.sql
      .exec<{ kind: string; count: number }>("SELECT kind, count FROM deeds WHERE player = ?", name)
      .toArray()) {
      out[r.kind] = r.count;
    }
    return out;
  }

  // `reckoning` (also `conscience`/`record`): the Grid holds up a mirror you
  // asked for. The dream does this when you sleep, unbidden; this is the version
  // you summon and can read as structured data -- a moral self-model for a human
  // OR an agent. It does not flatter and it does not scold; it counts, and lets
  // the sum speak. Light and dark are named in the same plain voice.
  private async reckoning(ws: WebSocket, s: Session): Promise<void> {
    const d = this.deedsFor(s.name);
    const standing = s.faction === "front" ? "Cinder Front" : s.faction === "ally" ? "Free Folk ally" : "unaligned";
    // The lines the Grid will speak, each only if the deed was actually done.
    const ledger: Array<[string, string]> = [
      ["mended", `  mended the hurt of others: ${d.mended ?? 0}`],
      ["forgave", `  souls you chose to forgive: ${d.forgave ?? 0}`],
      ["aided", `  aid left for strangers you'll never meet: ${d.aided ?? 0}`],
      ["kept", `  names of the fallen you kept: ${d.kept ?? 0}`],
      ["freed", `  souls you cut out of the cages: ${d.freed ?? 0}`],
      ["sheltered", `  distress calls you answered: ${d.sheltered ?? 0}`],
      ["stood", `  times you stood with the free folk: ${d.stood ?? 0}`],
      ["inscribed", `  words you left for whoever comes next: ${d.inscribed ?? 0}`],
      ["restored", `  dead nodes you brought back: ${d.restored ?? 0}`],
      ["slain", `  lives you took: ${d.slain ?? 0}`],
      ["stolen", `  thefts: ${d.stolen ?? 0}`],
      ["pledged", `  times you swore to the Cinder Front: ${d.pledged ?? 0}`],
      ["defected", `  times you turned on the Front: ${d.defected ?? 0}`],
    ];
    const done = ledger.filter(([k]) => (d[k] ?? 0) > 0).map(([, line]) => line);

    this.line(ws, "The Grid has kept count. This is the sum of you so far:");
    this.line(ws, `  standing: ${standing}   (morality ${s.morality})${s.ashsworn ? "   ASH-SWORN" : ""}`);
    const arc = this.arcLine(s).trim();
    if (arc) this.line(ws, "  " + arc);
    if (done.length) {
      for (const l of done) this.line(ws, l);
    } else {
      this.line(ws, "  Nothing yet weighs on either side. The wastes are still waiting to see who you are.");
    }
    this.event(ws, "char.reckoning", {
      morality: s.morality,
      standing: s.faction,
      ashsworn: !!s.ashsworn,
      strayed: !!s.strayed,
      redeemed: !!s.redeemed,
      deeds: d,
    });
    this.prompt(ws);
  }

  private async moralArc(ws: WebSocket, s: Session): Promise<void> {
    if (!s.name) return; // logged out mid-handler; nothing to weigh

    if (!s.strayed && s.morality <= STRAY_FLOOR) {
      s.strayed = true;
      ws.serializeAttachment(s);
      this.persistPlayer(s);
      // Private. Straying isn't a federation banner; it's a thing you know.
      this.line(ws, NL + "Something in you has gone cold and quiet. You have strayed a long way toward the cinders. (the Grid marks it, and so do you)");
      this.prompt(ws);
      return;
    }

    if (s.strayed && !s.redeemed && s.morality >= REDEEM_CEIL && s.faction !== "front") {
      s.redeemed = true; // the arc resolves once, either way

      if (s.ashsworn) {
        // The kapo carve-out. The good is real and the world will not pretend
        // otherwise -- but the ash-mark does not lift. Mercy has a limit, and
        // this is where the world draws it. A private reckoning, not a banner.
        ws.serializeAttachment(s);
        this.persistPlayer(s);
        this.recordTrace(s.room, "penance", `${s.name} has done real good, though the ash-mark remains.`, false);
        this.line(ws, NL + "You have clawed back to something good, and it is real. But the ash does not wash off; it never will. That is the cost. Carry it, and keep doing good anyway.");
        this.prompt(ws);
        return;
      }

      this.resolveReturn(ws, s);
      this.line(ws, NL + "The hollow you carried has filled with something else. The free folk have started to meet your eyes again. You found your way back. (you are the Returned)");
      this.prompt(ws);
    }
  }

  // Resolve a soul's return from the cinders into "the Returned", federated. The
  // caller has already set the write-once `redeemed` flag and ruled out the
  // ash-sworn carve-out; this seals it. Shared by the two roads home: the
  // works-road (`moralArc`, walked alone) and the grace-road (`forgive`, granted
  // by another person's hand).
  private resolveReturn(ws: WebSocket, s: Session): void {
    if (!s.title) s.title = "the Returned"; // never overwrite a chosen title
    ws.serializeAttachment(s);
    this.persistPlayer(s);
    this.commitIdentity(s);
    this.recordTrace(s.room, "redemption", `${s.name} found their way back from the cinders.`);
    this.event(ws, "grid.redemption", { name: s.name, title: s.title });
  }

  private exitsView(ws: WebSocket, s: Session): void {
    const exits = Object.keys(this.rooms[s.room].exits);
    this.line(ws, exits.length ? `Exits: ${exits.join(", ")}.` : "There are no obvious exits from here.");
    this.prompt(ws);
  }

  // Size up a mob before committing to a fight.
  private consider(ws: WebSocket, s: Session, arg: string): void {
    if (!arg.trim()) {
      this.line(ws, "Consider what?  (consider <mob>)");
      this.prompt(ws);
      return;
    }
    const mob = this.livingMobsInRoom(s.room).find((m) => this.mobMatches(m.id, arg));
    if (!mob) {
      this.line(ws, `There's no "${arg}" here to size up.`);
      this.prompt(ws);
      return;
    }
    const t = this.mobById[mob.id];
    const ratio = (t.maxHp + t.maxDmg * 5) / (s.maxHp + s.level * 10);
    const verdict =
      ratio < 0.4
        ? `You could put ${t.name} down without breaking a sweat.`
        : ratio < 0.8
          ? `${cap(t.name)} would give you a tussle, but the odds are yours.`
          : ratio < 1.2
            ? `${cap(t.name)} looks like an even match. Bring an antidote.`
            : ratio < 2
              ? `${cap(t.name)} would likely gut you. Think twice.`
              : `Attacking ${t.name} would be a quiet way to die.`;
    this.line(ws, verdict);
    this.prompt(ws);
  }

  // look (no arg = the room; otherwise a player here, then a mob, then items).
  private lookAt(ws: WebSocket, s: Session, arg: string): void {
    if (!arg.trim()) {
      this.sendRoom(ws, s);
      this.prompt(ws);
      return;
    }
    const a = arg.trim().toLowerCase();
    const other = this.sessions().find(
      (o) => o.room === s.room && o.name !== s.name && o.name.toLowerCase().startsWith(a),
    );
    if (other) {
      const pos = (other.position ?? "standing") !== "standing" ? `, ${other.position}` : "";
      this.line(ws, `${this.tagged(other)} stands before you${pos}, looking ${condition(other)}.`);
      const rec = this.recognition(other);
      if (rec) this.line(ws, "  " + rec);
      // Social perception as data: an agent can read another's moral standing,
      // not just its own (the agent-environment thesis, extended to other minds).
      this.event(ws, "player.read", {
        name: other.name,
        title: other.title ?? "",
        faction: other.faction,
        ashsworn: !!other.ashsworn,
        regard: this.regard(other),
      });
      this.prompt(ws);
      return;
    }
    const mob = this.livingMobsInRoom(s.room).find((m) => this.mobMatches(m.id, arg));
    if (mob) {
      this.line(ws, this.mobById[mob.id].desc);
      this.prompt(ws);
      return;
    }
    this.examine(ws, s, arg); // fall through to items (inventory or ground)
  }

  // recall / home: the Grid pulls you back to the Cracked Nexus.
  private recall(ws: WebSocket, s: Session): void {
    if (s.target) {
      this.line(ws, "You can't recall in the middle of a fight.");
      this.prompt(ws);
      return;
    }
    if (s.room === START_ROOM) {
      this.line(ws, "You're already at the Cracked Nexus.");
      this.prompt(ws);
      return;
    }
    const from = s.room;
    this.broadcast(from, `${s.name} dissolves into grid-static and is gone.`, ws);
    s.room = START_ROOM;
    ws.serializeAttachment(s);
    this.persistPlayer(s);
    this.recordTrace(from, "recall", `${this.tagged(s)} keyed out on the Grid from here.`, false); // ambient: local only
    this.line(ws, "You key the recall. The Grid takes hold, the world smears, and resolves at the Cracked Nexus.");
    this.broadcast(START_ROOM, `${s.name} resolves out of the static.`, ws);
    this.sendRoom(ws, s);
    this.prompt(ws);
  }

  // affects: list what is currently working on you.
  private affects(ws: WebSocket, s: Session): void {
    const lines = ["You are affected by:"];
    if (s.poisoned) lines.push("  Poisoned       venom drains your HP every tick.");
    if (s.addiction > 0)
      lines.push(`  Dust craving   addiction at ${s.addiction}${s.addiction >= 3 ? " (your hands won't stop shaking)" : ""}.`);
    if (s.faction === "front") lines.push("  Cinder Front   you marched against the free folk; they remember.");
    if (s.faction === "ally") lines.push("  Free Folk ally the elves count you a friend.");
    const pos = s.position ?? "standing";
    if (pos === "resting" || pos === "sleeping") lines.push(`  ${cap(pos)}        recovering HP each tick.`);
    if (lines.length === 1) lines.push("  ...nothing in particular. You feel clear, for once.");
    this.line(ws, lines.join(NL));
    this.emitAffects(ws, s);
    this.prompt(ws);
  }

  // rest / sleep / sit / stand / wake.
  private setPosition(ws: WebSocket, s: Session, pos: string): void {
    if (s.target && pos !== "standing") {
      this.line(ws, "Not in the middle of a fight, you don't.");
      this.prompt(ws);
      return;
    }
    if ((s.position ?? "standing") === pos) {
      this.line(ws, `You're ${POS_ALREADY[pos]}.`);
      this.prompt(ws);
      return;
    }
    s.position = pos;
    ws.serializeAttachment(s);
    this.line(ws, POS_SELF[pos]);
    this.broadcast(s.room, `${s.name} ${POS_OTHERS[pos]}.`, ws);
    this.emitVitals(ws, s);
    if (pos === "sleeping") this.dream(ws, s);
    this.prompt(ws);
  }

  // When you sleep, the dead network dreams you: a mirror assembled from who you
  // have become. Rare by design (a cooldown), so it stays a reckoning, not noise.
  private dream(ws: WebSocket, s: Session): void {
    const now = Date.now();
    if (s.dreamReadyAt && now < s.dreamReadyAt) return; // a dreamless sleep
    s.dreamReadyAt = now + 90_000;

    // The guilt dreams take precedence -- your sins haunt you above your
    // kindnesses (the brand, the collaboration, the corruption confront you
    // first). Everyone else, if they have touched real people, dreams of THEM:
    // the living they saved, the dead they kept. The state mirror is for those
    // who have not yet reached anyone.
    let text: string;
    let personal = false;
    let subject: string | undefined;
    const haunted = s.ashsworn || s.faction === "front" || s.morality <= -50;
    if (!haunted) {
      const saved = this.ctx.storage.sql
        .exec<{ name: string }>("SELECT name FROM saved_souls WHERE savior = ? ORDER BY at DESC LIMIT 12", s.name)
        .toArray()
        .map((r) => r.name);
      const kept = this.ctx.storage.sql
        .exec<{ fallen: string }>("SELECT fallen FROM remembrances WHERE keeper = ? ORDER BY at DESC LIMIT 12", s.name)
        .toArray()
        .map((r) => r.fallen);
      const pd = personalDream(saved, kept);
      if (pd) {
        text = pd.text;
        personal = true;
        subject = pd.subject;
      } else {
        text = dreamFor({ ashsworn: s.ashsworn, faction: s.faction, morality: s.morality });
      }
    } else {
      text = dreamFor({ ashsworn: s.ashsworn, faction: s.faction, morality: s.morality });
    }

    this.event(ws, "char.dream", { text, personal, ...(subject ? { subject } : {}) });
    this.line(ws, `\x1b[2;37m  ${text}\x1b[0m`);
    ws.serializeAttachment(s);
  }

  // --- Equipment: worn gear with stat bonuses --------------------------------
  private equipped(player: string): Record<string, string> {
    const rows = this.ctx.storage.sql
      .exec<{ slot: string; item: string }>("SELECT slot, item FROM equipment WHERE player = ?", player)
      .toArray();
    const out: Record<string, string> = {};
    for (const r of rows) out[r.slot] = r.item;
    return out;
  }

  private equipBonuses(player: string): { damage: number; armor: number } {
    let damage = 0;
    let armor = 0;
    for (const item of Object.values(this.equipped(player))) {
      const t = ITEM_TEMPLATES[item];
      if (t?.damage) damage += t.damage;
      if (t?.armor) armor += t.armor;
    }
    return { damage, armor };
  }

  private emitEquipment(ws: WebSocket, player: string): void {
    const eq = this.equipped(player);
    this.event(ws, "char.equipment", Object.fromEntries(EQUIP_SLOTS.map((sl) => [sl, eq[sl] ?? null])));
  }

  // wear / wield / equip: move an item from inventory into its slot.
  private equip(ws: WebSocket, s: Session, arg: string): void {
    if (!arg.trim()) {
      this.line(ws, "Wear or wield what?  (equip <item>)");
      this.prompt(ws);
      return;
    }
    const item = this.invItems(s.name).find((id) => itemMatches(id, arg));
    if (!item) {
      this.line(ws, `You aren't carrying "${arg}".`);
      this.prompt(ws);
      return;
    }
    const t = ITEM_TEMPLATES[item];
    if (!t.slot) {
      this.line(ws, `You can't wear or wield ${t.name}.`);
      this.prompt(ws);
      return;
    }
    const current = this.equipped(s.name)[t.slot];
    if (current) {
      // Swap: stow whatever's already in that slot.
      this.invAdd(s.name, current, 1);
      this.ctx.storage.sql.exec("DELETE FROM equipment WHERE player = ? AND slot = ?", s.name, t.slot);
    }
    this.invRemove(s.name, item, 1);
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO equipment (player, slot, item) VALUES (?, ?, ?)", s.name, t.slot, item);
    const verb = t.slot === "weapon" ? "wield" : "wear";
    this.line(ws, `You ${verb} ${t.name}.${current ? ` (You stop using ${ITEM_TEMPLATES[current].name}.)` : ""}`);
    this.broadcast(s.room, `${s.name} ${verb}s ${t.name}.`, ws);
    this.emitEquipment(ws, s.name);
    this.prompt(ws);
  }

  // remove / unwield: move an equipped item back to inventory.
  private unequip(ws: WebSocket, s: Session, arg: string): void {
    if (!arg.trim()) {
      this.line(ws, "Remove what?  (remove <item>)");
      this.prompt(ws);
      return;
    }
    const eq = this.equipped(s.name);
    const slot = Object.keys(eq).find((sl) => itemMatches(eq[sl], arg));
    if (!slot) {
      this.line(ws, `You aren't using any "${arg}".`);
      this.prompt(ws);
      return;
    }
    const item = eq[slot];
    this.ctx.storage.sql.exec("DELETE FROM equipment WHERE player = ? AND slot = ?", s.name, slot);
    this.invAdd(s.name, item, 1);
    this.line(ws, `You remove ${ITEM_TEMPLATES[item].name} and stow it.`);
    this.emitEquipment(ws, s.name);
    this.prompt(ws);
  }

  // equipment / eq: show what's worn and the bonuses it grants.
  private equipmentView(ws: WebSocket, s: Session): void {
    const eq = this.equipped(s.name);
    const lines = ["You are using:"];
    for (const sl of EQUIP_SLOTS) {
      lines.push(`  ${sl.padEnd(7)} ${eq[sl] ? ITEM_TEMPLATES[eq[sl]].name : "(nothing)"}`);
    }
    const b = this.equipBonuses(s.name);
    lines.push(`  -- in total: +${b.damage} damage, +${b.armor} armor`);
    this.line(ws, lines.join(NL));
    this.emitEquipment(ws, s.name);
    this.prompt(ws);
  }

  // title <text>: a custom epithet shown after your name (blank to clear).
  private setTitle(ws: WebSocket, s: Session, arg: string): void {
    const t = arg.trim().replace(/[\r\n]/g, "").slice(0, 40);
    s.title = t;
    ws.serializeAttachment(s);
    this.persistPlayer(s);
    this.commitIdentity(s);
    if (t) this.line(ws, `You are known henceforth as ${s.name}, ${t}.`);
    else this.line(ws, `Your title is stripped away. Just ${s.name} now.`);
    this.prompt(ws);
  }

  private policies(): string {
    return (
      [
        "",
        "Skyphusion Labs operates these hosted worlds. Two plain-language notices govern the",
        "hosted instance (they do not bind you if you run your own world):",
        "  Privacy notice   https://github.com/skyphusion-labs/the-hollow-grid/blob/main/docs/legal/INSTANCE-PRIVACY.md",
        "  Acceptable use   https://github.com/skyphusion-labs/the-hollow-grid/blob/main/docs/legal/INSTANCE-ACCEPTABLE-USE.md",
        "Not legal advice.",
      ].join(NL) + NL
    );
  }

  private help(): string {
    return (
      [
        "",
        "Commands:",
        "  look (l) [target]     describe the room, or a player/mob/item",
        "  sense (actions)       list what you can do here, and what each choice costs your soul",
        "  north/south/...       move (n s e w ne nw se sw u d, or 'go <dir>')",
        "  exits                 list the ways out of this room",
        "  recall / home         key back to the Cracked Nexus",
        "  attack <mob> (k)      start a fight (resolves every few seconds)",
        "  consider <mob> (con)  size up a fight before you start it",
        "  flee (f)              break off combat",
        "  get/take <item>       pick something up off the ground",
        "  drop <item>           drop an item",
        "  give <item> <player>  hand an item to someone in your room",
        "  mend <player>         give some of your own strength to heal another (costs you HP)",
        "  forgive <player>      let someone marked back in -- the second road home (absolve/pardon)",
        "  inventory (inv, i)    list what you're carrying",
        "  wear/wield <item>     equip gear (weapons add damage, armor soaks hits)",
        "  remove <item>         take off a piece of gear",
        "  equipment (eq)        show what you're wearing and wielding",
        "  use/drink <item>      use an item (antidote, rad-cell, ...)",
        "  examine <item>        look closely at an item",
        "  free/rescue           free the caged/captive (also unlock/release/liberate)",
        "  sell <item>           sell salvage to the market vendor (honest coin)",
        "  steal                 lift gold from the market stall (risky, corrupting)",
        "  buy <item>            buy from a vendor (dust at the Tankard; gear at the Workshop)",
        "  list                  list a shop's wares (the Tinker's Workshop)",
        "  carouse / resist      indulge or refuse the Tankard's vices",
        "  join / defend         side with the Cinder Front, or the elves (Scrap Market)",
        "  talk                  speak to whoever shares your room",
        "  hp / status           show health, level, xp, gold, and standing",
        "  affects (affs)        list what's currently affecting you",
        "  rest/sleep/sit/stand  change position (resting and sleeping heal you)",
        "  say <message> (')     speak to everyone in the room",
        "  tell <player> <msg>   private message (reply with 'reply <msg>')",
        "  yell <message>        shout to everyone online",
        "  emote <action>        act it out ('emote spits in the dust')",
        "  who                   list survivors online across the whole Grid (all worlds)",
        "  title <text>          set an epithet shown after your name (blank clears it)",
        "  ping [all]            query this node's Grid memory ('ping all' = the whole network)",
        "  listen (tune)         tune the dead frequencies; hear what the network still plays",
        "  inscribe <message>    carve your words into this node for whoever comes after (carve/leave)",
        "  gridcast <message>    speak across EVERY world on the Grid (gc)",
        "  war / tide            the global Cinder Front vs free-folk war (all worlds)",
        "  whoami                your canonical self on the Grid (follows you everywhere)",
        "  ability (trait)       use your race's signature ability (whoami names it)",
        "  worlds                list the worlds linked on the Grid",
        "  travel <world>        cross the Grid to another world (your character follows)",
        "  wall <message>        broadcast an announcement to everyone (keepers only)",
        "  witness [name]        read the Grid's roll of the fallen, or keep one's memory (a vigil)",
        "  reckoning (conscience) the Grid holds up a mirror: the sum of what you've done",
        "  saved (rescued)       read the Grid's roll of the living pulled from the cages",
        "  treat (medic)         the waystation medic tends you -- free, while the free folk hold the tide",
        "  cache <gold> / gather leave aid here for the next traveler, or take what a stranger left you",
        "  shelter               answer the transit-hub distress call: get the stranded survivors to safety",
        "  gridstats / gridprune read or flush the Grid ledger's ambient noise (keepers only)",
        "  world / weather       check the time of day and the weather",
        "  policies              privacy + acceptable-use notices (hosted worlds)",
        "  help (?)              this message",
        "  quit                  disconnect",
      ].join(NL) + NL
    );
  }

  // ---- helpers -------------------------------------------------------------

  private line(ws: WebSocket, text: string): void {
    ws.send(NL + text + NL);
  }

  private prompt(ws: WebSocket): void {
    ws.send("> ");
  }

  private say(ws: WebSocket, s: Session, message: string): void {
    if (!message) {
      this.line(ws, "Say what?");
      return;
    }
    this.line(ws, `You say, "${message}"`);
    this.broadcast(s.room, `${s.name} says, "${message}"`, ws);
  }

  private broadcast(roomId: string, text: string, exclude?: WebSocket): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      const s = ws.deserializeAttachment() as Session | null;
      if (s?.name && s.room === roomId) {
        ws.send(NL + text + NL + "> ");
      }
    }
  }

  private sessions(): Session[] {
    return this.ctx
      .getWebSockets()
      .map((ws) => ws.deserializeAttachment() as Session | null)
      .filter((s): s is Session => !!s && s.name.length > 0);
  }

  private onlineNames(): string[] {
    return this.sessions().map((s) => s.name);
  }

  private playersInRoom(roomId: string): string[] {
    return this.sessions()
      .filter((s) => s.room === roomId)
      .map((s) => s.name);
  }

  private isNameOnline(name: string): boolean {
    const lower = name.toLowerCase();
    return this.onlineNames().some((n) => n.toLowerCase() === lower);
  }

  private loadMob(id: string): MobRow | null {
    return this.ctx.storage.sql.exec<MobRow>("SELECT * FROM mobs WHERE id = ?", id).toArray()[0] ?? null;
  }

  // The holding-pit warden bars the captive's rescue. It is "cleared" when dead,
  // or when it was slain within the grace window even though it has since
  // respawned (its 60s timer outpaces a slow agent's turn; see WARDEN_GRACE_MS).
  // Single source of truth so the `free` handler and the room.actions affordance
  // never disagree about whether the rescue is reachable right now.
  private wardenCleared(): boolean {
    const warden = this.loadMob(WARDEN_ID);
    if (!warden || warden.state === "dead") return true;
    return warden.slain_at > 0 && Date.now() - warden.slain_at < WARDEN_GRACE_MS;
  }

  private livingMobsInRoom(roomId: string): MobRow[] {
    return this.ctx.storage.sql
      .exec<MobRow>("SELECT * FROM mobs WHERE room = ? AND state = 'alive'", roomId)
      .toArray();
  }

  private mobMatches(id: string, arg: string): boolean {
    const a = arg.toLowerCase();
    return id === a || this.mobById[id].name.toLowerCase().includes(a);
  }

  // inventory + ground helpers (qty-based rows)

  private invItems(player: string): string[] {
    return this.ctx.storage.sql
      .exec<{ item: string }>("SELECT item FROM inventory WHERE player = ? AND qty > 0", player)
      .toArray()
      .map((r) => r.item);
  }

  private invHas(player: string, item: string): boolean {
    const r = this.ctx.storage.sql
      .exec<{ qty: number }>("SELECT qty FROM inventory WHERE player = ? AND item = ?", player, item)
      .toArray()[0];
    return !!r && r.qty > 0;
  }

  private invAdd(player: string, item: string, n: number): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO inventory (player, item, qty) VALUES (?, ?, ?) ON CONFLICT(player, item) DO UPDATE SET qty = qty + excluded.qty",
      player,
      item,
      n,
    );
  }

  private invRemove(player: string, item: string, n: number): void {
    this.ctx.storage.sql.exec(
      "UPDATE inventory SET qty = qty - ? WHERE player = ? AND item = ?",
      n,
      player,
      item,
    );
    this.ctx.storage.sql.exec("DELETE FROM inventory WHERE player = ? AND item = ? AND qty <= 0", player, item);
  }

  private groundItems(room: string): string[] {
    return this.ctx.storage.sql
      .exec<{ item: string }>("SELECT item FROM ground WHERE room = ? AND qty > 0", room)
      .toArray()
      .map((r) => r.item);
  }

  private groundAdd(room: string, item: string, n: number): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO ground (room, item, qty) VALUES (?, ?, ?) ON CONFLICT(room, item) DO UPDATE SET qty = qty + excluded.qty",
      room,
      item,
      n,
    );
  }

  private groundRemove(room: string, item: string, n: number): void {
    this.ctx.storage.sql.exec("UPDATE ground SET qty = qty - ? WHERE room = ? AND item = ?", n, room, item);
    this.ctx.storage.sql.exec("DELETE FROM ground WHERE room = ? AND item = ? AND qty <= 0", room, item);
  }

  private persistPlayer(s: Session): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO players (name, room, hp, max_hp, xp, level, poisoned, gold, morality, addiction, faction, resisted, title, race, ashsworn, strayed, redeemed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         room = excluded.room, hp = excluded.hp, max_hp = excluded.max_hp,
         xp = excluded.xp, level = excluded.level, poisoned = excluded.poisoned,
         gold = excluded.gold, morality = excluded.morality, addiction = excluded.addiction,
         faction = excluded.faction, resisted = excluded.resisted, title = excluded.title,
         race = excluded.race, ashsworn = excluded.ashsworn,
         strayed = excluded.strayed, redeemed = excluded.redeemed`,
      s.name,
      s.room,
      s.hp,
      s.maxHp,
      s.xp,
      s.level,
      s.poisoned ? 1 : 0,
      s.gold,
      s.morality,
      s.addiction,
      s.faction,
      s.resisted ? 1 : 0,
      s.title ?? "",
      s.race ?? "",
      s.ashsworn ? 1 : 0,
      s.strayed ? 1 : 0,
      s.redeemed ? 1 : 0,
    );
  }
}
