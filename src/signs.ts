// The wastes answer the tide. The faction war is a single shared number every
// world moves together; this makes it FELT. When the free folk are winning, the
// world quietly starts to come back to life. When the Cinder Front is winning, it
// darkens and draws in. Loss is not the end state here: life insists on returning,
// and it returns faster where people choose well. The collective ethic, made
// visible -- so a player (or an agent) can watch what everyone is choosing add up
// to a world that heals or a world that hardens.

export type Mood = "rising" | "falling" | "still";

// The tide runs -100..+100 (positive = the free folk ascendant). Signs only fire
// once it has decisively tipped; the balanced middle stays the plain wastes.
export function moodForTide(tide: number): Mood {
  if (tide >= 40) return "rising";
  if (tide <= -40) return "falling";
  return "still";
}

const SIGNS: Record<Mood, string[]> = {
  // The free folk ascendant: the world remembering how to live.
  rising: [
    "A shoot of green has pushed up through the cracked concrete here. Nobody remembers the last time anything grew.",
    "Somewhere past the ridge a bird is singing. An actual bird. People stop where they stand, not quite believing it.",
    "The hum sounds almost gentle today. Less like a dying machine, more like something finally resting.",
    "A child's laugh carries from the direction of the free camp, and for a moment the whole waste seems to lean toward it.",
    "Someone cleared the ash off an old solar panel, and it is quietly, stubbornly, working again.",
    "Word is the refugees planted something down in the floodplain. Word is it took.",
    "The water in the cisterns tastes a little less of rust lately. Small mercies, but the wastes have not offered many.",
  ],
  // The Cinder Front ascendant: the world drawing in, afraid.
  falling: [
    "Smoke stands on the horizon, black and patient. Another camp, the wind says. It carries ash, and worse.",
    "People keep their eyes down today. The Front walks tall, and everyone has learned what looking up costs.",
    "The hum has an edge to it lately, like a held breath. Even the machines seem to be waiting for something bad.",
    "A checkpoint went up overnight where there wasn't one. The wastes feel smaller every day the Front is winning.",
    "Someone scrubbed the elf-marks off the waystation wall. The free folk are getting careful. Getting quiet.",
    "A column of the branded marched through at dawn. Doors that were open yesterday stay shut today.",
  ],
  still: [],
};

// A sign for the current tide, or null when the war is too balanced to show.
export function signFor(tide: number): { mood: Mood; text: string } | null {
  const mood = moodForTide(tide);
  const pool = SIGNS[mood];
  if (pool.length === 0) return null;
  return { mood, text: pool[Math.floor(Math.random() * pool.length)] };
}
