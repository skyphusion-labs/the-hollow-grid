// Item templates: static game data. Inventories (per player) and ground piles
// (per room) are stored as (owner, item, qty) rows in SQLite, referencing these
// ids. An item is "usable" if it has a `use` effect.

export type ItemEffect =
  | { effect: "cure_poison" }
  | { effect: "heal"; amount: number }
  | { effect: "drug" };

export interface ItemTemplate {
  id: string;
  /** display name, conventionally with an article ("an antidote vial") */
  name: string;
  desc: string;
  use?: ItemEffect;
  /** gold the market vendor will pay for it; 0 = unsellable */
  value?: number;
  /** equipment slot this item occupies, if it can be worn/wielded */
  slot?: EquipSlot;
  /** weapon: bonus to attack damage */
  damage?: number;
  /** armor: flat reduction to incoming damage */
  armor?: number;
}

export type EquipSlot = "weapon" | "head" | "body" | "hands" | "feet";
export const EQUIP_SLOTS: EquipSlot[] = ["weapon", "head", "body", "hands", "feet"];

export const ITEM_TEMPLATES: Record<string, ItemTemplate> = {
  antidote: {
    id: "antidote",
    name: "an antidote vial",
    desc: "A slim vial of antivenom, cold and faintly blue. The maiden's gift.",
    use: { effect: "cure_poison" },
  },
  radcell: {
    id: "radcell",
    name: "a rad-cell",
    desc: "A cracked power cell, still warm. Press it to a wound and it jolts you back together.",
    use: { effect: "heal", amount: 10 },
    value: 12,
  },
  shiv: {
    id: "shiv",
    name: "a rusted shiv",
    desc: "Sharp enough, if the tetanus doesn't get you first.",
    value: 5,
    slot: "weapon",
    damage: 3,
  },
  plating: {
    id: "plating",
    name: "a sheet of scrap plating",
    desc: "Buckled salvage. Heavy, dull, and just about wearable as a chestpiece.",
    value: 3,
    slot: "body",
    armor: 2,
  },
  gland: {
    id: "gland",
    name: "a venom gland",
    desc: "A translucent sac, still beading with toxin. Handle carefully.",
    value: 8,
  },
  keycard: {
    id: "keycard",
    name: "the warden's keycard",
    desc: "A blood-flecked access card, magnetic strip worn smooth.",
    value: 20,
  },
  dust: {
    id: "dust",
    name: "a packet of dust",
    desc: "Grimy narcotic powder that smells of ozone. It promises to make the pain go away.",
    use: { effect: "drug" },
  },
  charm: {
    id: "charm",
    name: "an elven charm",
    desc: "A woven token of knotted grass and wire, pressed into your hand by grateful refugees.",
  },
  rebar: {
    id: "rebar",
    name: "a length of rebar",
    desc: "A meter of rusted reinforcing bar. Crude and heavy, and it caves skulls just fine.",
    value: 10,
    slot: "weapon",
    damage: 6,
  },
  helm: {
    id: "helm",
    name: "a dented scrap helm",
    desc: "A welded pot that's taken worse hits than you have. It'll do.",
    value: 6,
    slot: "head",
    armor: 1,
  },
  shard: {
    id: "shard",
    name: "the core shard",
    desc:
      "A sliver of black crystal lattice, warm and faintly humming. A whole node's " +
      "worth of the dead Grid, somehow still holding a charge. The operator wants this.",
  },
  cleaver: {
    id: "cleaver",
    name: "the Ashmonger's cleaver",
    desc:
      "A brutal slab of a blade ground from a road-grader and stained dark with use. It was " +
      "the Front commander's pride. Now it's salvage like everything else.",
    value: 60,
    slot: "weapon",
    damage: 9,
  },

  // --- Dustfall salvage: the salt pan's own gear, shaped by sun and scarcity. ---
  // Defined in the shared catalog (item definitions are harmless data); only
  // Dustfall's loot, shop, and starter actually hand them out. They parallel the
  // Hollow Grid set in stats/value so the two worlds stay balanced.
  machete: {
    id: "machete",
    name: "a rusted machete",
    desc: "A farm blade worn to a mean edge on someone's doorstep. It has cut more rope than men, but it'll do either.",
    value: 5,
    slot: "weapon",
    damage: 3,
  },
  spear: {
    id: "spear",
    name: "a scrap-iron spear",
    desc: "A leaf of sharpened sheet-steel lashed to a length of pipe. Reach is its own kind of mercy out on the pan.",
    value: 10,
    slot: "weapon",
    damage: 6,
  },
  hide: {
    id: "hide",
    name: "a stitched-hide vest",
    desc: "Plates of sun-cured leather sewn over a salvage frame. It stops a blade better than it stops the heat.",
    value: 3,
    slot: "body",
    armor: 2,
  },
  wrap: {
    id: "wrap",
    name: "a sun-bleached head-wrap",
    desc: "Layered rag and a band of beaten tin, against the glare and the occasional thrown rock.",
    value: 6,
    slot: "head",
    armor: 1,
  },
  waterskin: {
    id: "waterskin",
    name: "a sloshing waterskin",
    desc: "A bladder of brackish, hard-won water. Out here, this is what mends you. Drink and feel the worst of it recede.",
    use: { effect: "heal", amount: 10 },
    value: 12,
  },
  saltbrick: {
    id: "saltbrick",
    name: "a brick of pressed salt",
    desc: "A hand-sized block of pan-salt, scored for breaking. On the flats it spends almost as well as coin.",
    value: 8,
  },
};

// The Grease Pit (Dustfall) and the Tinker's Workshop (Hollow Grid) sell from the
// same `workshop` room, but stock their own region's gear. Same prices, so a
// player crossing worlds finds a familiar economy in unfamiliar goods.
export type Ware = { item: string; price: number };
const WARES_HOLLOW: Ware[] = [
  { item: "shiv", price: 12 },
  { item: "helm", price: 14 },
  { item: "antidote", price: 14 },
  { item: "radcell", price: 16 },
  { item: "plating", price: 18 },
  { item: "rebar", price: 45 },
];
const WARES_DUSTFALL: Ware[] = [
  { item: "machete", price: 12 },
  { item: "wrap", price: 14 },
  { item: "antidote", price: 14 },
  { item: "waterskin", price: 16 },
  { item: "hide", price: 18 },
  { item: "spear", price: 45 },
];

// Per-deployment shop stock and starter weapon (keyed by WORLD_MAP, like the map,
// bestiary, and banner). Unknown or unset falls back to the Hollow Grid.
export function waresFor(key?: string): Ware[] {
  return key?.trim().toLowerCase() === "dustfall" ? WARES_DUSTFALL : WARES_HOLLOW;
}
export function starterFor(key?: string): string {
  return key?.trim().toLowerCase() === "dustfall" ? "machete" : "shiv";
}

export function itemMatches(id: string, arg: string): boolean {
  const a = arg.toLowerCase();
  if (!a) return false;
  return id === a || ITEM_TEMPLATES[id].name.toLowerCase().includes(a);
}
