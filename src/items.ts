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
};

export function itemMatches(id: string, arg: string): boolean {
  const a = arg.toLowerCase();
  if (!a) return false;
  return id === a || ITEM_TEMPLATES[id].name.toLowerCase().includes(a);
}
