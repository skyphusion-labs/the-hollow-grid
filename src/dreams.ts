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
