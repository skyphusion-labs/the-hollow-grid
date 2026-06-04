// Item templates — static game data. Inventories (per player) and ground piles
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
}

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
  },
  plating: {
    id: "plating",
    name: "a sheet of scrap plating",
    desc: "Buckled salvage. Heavy, dull, occasionally useful.",
    value: 3,
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
};

export function itemMatches(id: string, arg: string): boolean {
  const a = arg.toLowerCase();
  if (!a) return false;
  return id === a || ITEM_TEMPLATES[id].name.toLowerCase().includes(a);
}
