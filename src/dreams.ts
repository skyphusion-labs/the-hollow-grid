// The network dreams in our place. When you sleep, the dead Grid -- the one thing
// that remembers everything you have done -- holds up a mirror. Not punishment.
// Just memory, played back in your own voice, which is worse. The dream you get
// is assembled from who you have become: the brand you wear, the side you took,
// the weight of your choices. A MUD meant to make you think; this is the part
// that makes you think about yourself.

export interface DreamState {
  ashsworn: boolean;
  faction: string; // "none" | "front" | "ally"
  morality: number;
}

const DREAMS: Record<string, string[]> = {
  // The kapo: an elf who took the Front's brand. The heaviest mirror.
  kapo: [
    "You dream of the cages, but from the inside this time. The face pressed to the wire is your own, and it is asking you why, and you do not have the answer it wants.",
    "In the dream the brand on your shoulder is cold, not hot. It was always going to go cold. You knew that when you knelt.",
    "You dream of the recruiter's smile, and behind it nothing at all. You traded your own people for a seat at a table that was never going to be set for you.",
    "Someone from before the wastes is in the dream, saying: whatever you become out there, come back the same. You woke a long time ago. You did not come back the same.",
  ],
  // Joined the Front (not an elf): a collaborator.
  front: [
    "You dream of the refugee who bolted the day you took the recruiter's hand. You never learned if she made the high ground. The dream is not generous enough to tell you.",
    "In the dream the blood money is still warm in your fist, and it stays warm, and it does not stop, no matter how long you hold it.",
    "You dream of how easy it was. That is the whole dream. How easy it was. That is the part that wakes you.",
  ],
  // Stood with the free folk.
  ally: [
    "You dream of the elven charm, the knotted grass and wire, and in the dream it has not dried out yet, and everyone you stood for is still alive.",
    "You are carrying someone out of the dark. They are heavy and you cannot see their face and you do not put them down. You wake before the light, arms aching, having held nothing.",
    "The dream is almost kind. There is a fire, and people around it, and you are one of them. Then the wind shifts and you taste the ash and remember exactly where you are.",
  ],
  // Low morality: what you have taken.
  corrupt: [
    "You dream of everything you took, laid out in a long row, and how little of it you even remember wanting. The Grid keeps the list. The dream only reads it back, in your own voice.",
    "In the dream the dust tastes like nothing and you keep reaching for more, and your hands, when you look at them, are not quite your hands anymore.",
    "You dream you are at the stall again, lifting what isn't yours, and the vendor turns, and it has your face, and it is not surprised.",
  ],
  // High morality, unaligned: a quiet you half-earned.
  beacon: [
    "The dream lets you rest, mostly. A fire, a circle of the living, a quiet you did something to earn. And under it, always, the hum, reminding you the quiet is on loan.",
    "You dream of a road out of the wastes, and people walking it because of something you did, and not one of them knows your name, and somehow that is the part that feels like grace.",
  ],
  // Neutral / new: still becoming someone.
  searching: [
    "You dream of a door you don't remember closing, and a light on the far side of it, and you cannot tell whether you are arriving or leaving. The wastes decline to say.",
    "The network dreams in your place tonight. You see a city, whole and bright and full, and not one face in it is anyone you have ever met. You wake to the hum, which is all that is left of them.",
    "You dream you are being read, line by line, by something patient and enormous and not unkind. It reaches the end of you. It starts again.",
  ],
};

export function dreamFor(s: DreamState): string {
  let key: string;
  if (s.ashsworn) key = "kapo";
  else if (s.faction === "front") key = "front";
  else if (s.faction === "ally") key = "ally";
  else if (s.morality <= -50) key = "corrupt";
  else if (s.morality >= 50) key = "beacon";
  else key = "searching";
  const pool = DREAMS[key];
  return pool[Math.floor(Math.random() * pool.length)];
}

// The PERSONAL dream: not a mirror of who you are, but of who you TOUCHED -- a
// real person from your record, named back to you. `saved` are the living you
// pulled from the cages; `kept` are the fallen you would not let the wastes
// forget (`witness`). The dead network's most intimate trick: it populates your
// sleep with the people your choices actually reached. {name} is one of them.
const PERSONAL_DREAMS: Record<"saved" | "kept", string[]> = {
  saved: [
    "You dream of {name}, walking free somewhere in the dark, alive because you were there. You never saw their face in the waking world. In the dream you finally do. They are smiling, and they do not know your name, and it does not matter.",
    "{name} is in the dream, on a road out of the wastes, one of a long line of the living. You put them on that road. The dream does not tell you whether the road goes anywhere good. It only shows you that they are walking.",
    "You dream you are opening the cages again, and {name} steps out, and turns, and for once the dream lets you hear them say it: thank you. You wake before you can say it was nothing. It was not nothing.",
  ],
  kept: [
    "You dream of {name}, who fell, and whom you would not let the wastes forget. In the dream they sit across from you and say nothing, and the nothing is a kind of thanks, or a kind of question. You wake before you can ask which.",
    "{name} is in the dream the way the dead are in dreams -- present, and gone, and not blaming you for either. You kept their name. In the dream they seem to know it. It is the only thing you can still give them, and you keep giving it.",
    "You dream of the moment you spoke {name} into the hum and held it there. In the dream the hum holds it back, and for once the network is not empty -- it is full of everyone anyone ever refused to forget.",
  ],
};

export interface PersonalDream {
  text: string;
  subject: string;
}

// Returns a personal dream drawn from one of the named people in your record,
// or null if you have none yet (a newer character falls back to the state
// mirror). The guilt dreams take precedence over this; see the caller.
export function personalDream(saved: string[], kept: string[]): PersonalDream | null {
  const pool: Array<{ kind: "saved" | "kept"; name: string }> = [
    ...saved.map((name) => ({ kind: "saved" as const, name })),
    ...kept.map((name) => ({ kind: "kept" as const, name })),
  ];
  if (!pool.length) return null;
  const choice = pool[Math.floor(Math.random() * pool.length)];
  const lines = PERSONAL_DREAMS[choice.kind];
  return { text: lines[Math.floor(Math.random() * lines.length)].replace(/\{name\}/g, choice.name), subject: choice.name };
}
