// Per-world login banners: a framed, color-graded title card sent to every
// connecting client. ANSI/256-color, so it lights up in any terminal client
// (wscat, the bundled `npm run connect`, telnet); a client that ignores escapes
// just sees the letters. Each world gets its own title, palette, and voice
// (selected by WORLD_MAP, like the map and bestiary), so arriving somewhere new
// announces itself: the Hollow Grid in cold cyan going hollow, Dustfall in the
// hot rust of the salt pan. Built on demand (cheap, once per DO).

// Block glyphs, five rows tall. Only the letters used by the titles are defined.
const GLYPHS: Record<string, [string, string, string, string, string]> = {
  H: ["█  █", "█  █", "████", "█  █", "█  █"],
  O: [" ██ ", "█  █", "█  █", "█  █", " ██ "],
  L: ["█   ", "█   ", "█   ", "█   ", "████"],
  W: ["█   █", "█   █", "█ █ █", "██ ██", "█   █"],
  G: [" ███", "█   ", "█ ██", "█  █", " ███"],
  R: ["███ ", "█  █", "███ ", "█ █ ", "█  █"],
  I: ["███", " █ ", " █ ", " █ ", "███"],
  D: ["███ ", "█  █", "█  █", "█  █", "███ "],
  U: ["█  █", "█  █", "█  █", "█  █", " ██ "],
  S: ["████", "█   ", "████", "   █", "████"],
  T: ["████", " ██ ", " ██ ", " ██ ", " ██ "],
  F: ["████", "█   ", "███ ", "█   ", "█   "],
  A: [" ██ ", "█  █", "████", "█  █", "█  █"],
  " ": ["   ", "   ", "   ", "   ", "   "],
};

const RESET = "\x1b[0m";
const paint = (code: string, s: string): string => `\x1b[${code}m${s}${RESET}`;
const fg = (n: number): string => `38;5;${n}`;

const INNER = 68;
function center(s: string, w = INNER): string {
  const pad = w - [...s].length;
  const left = Math.max(0, Math.floor(pad / 2));
  return " ".repeat(left) + s + " ".repeat(Math.max(0, pad - left));
}

// Render a string into its five rows of block glyphs.
function bigText(s: string): [string, string, string, string, string] {
  const rows: [string, string, string, string, string] = ["", "", "", "", ""];
  [...s].forEach((ch, i) => {
    const g = GLYPHS[ch] ?? GLYPHS[" "];
    const gap = i < s.length - 1 ? " " : "";
    for (let r = 0; r < 5; r++) rows[r] += g[r] + gap;
  });
  return rows;
}

// The colors that distinguish one world's card from another.
interface Palette {
  frame: string; // the box
  accent: string; // the one loud note (corners + flavor marks)
  kicker: string; // the small line above the title
  gradient: [string, string, string, string, string]; // the title, top row to bottom
  flavor: string; // the line under the frame's top edge
  tagline: string; // the closing couplet
  dots: string; // the faint dotted line beneath the title
}

interface BannerSpec {
  title: string; // rendered as block letters
  kicker: string; // e.g. "T  H  E"
  flavor: string; // the ". : . <this> . : ." line
  tagline: [string, string];
  palette: Palette;
}

// One faint dotted line: texture showing faintly through, like phosphor or dust.
const gridDots = Array(14).fill("·").join("   ");

function build(spec: BannerSpec): string[] {
  const { palette: p } = spec;
  const bar = "─".repeat(INNER);
  const edge = (corner: string) => paint(p.accent, corner);
  const wrap = (inner: string): string => paint(p.frame, "  │") + inner + paint(p.frame, "│");
  const line = (code: string, text: string, bold = false): string => wrap(paint((bold ? "1;" : "") + code, center(text)));
  const blank = (): string => wrap(" ".repeat(INNER));
  const flavorLine = (): string => {
    const mark = ". : .";
    const mid = `  ${spec.flavor}  `;
    const visible = mark.length * 2 + [...mid].length;
    const left = Math.max(0, Math.floor((INNER - visible) / 2));
    const right = Math.max(0, INNER - visible - left);
    const body =
      " ".repeat(left) + paint(p.accent, mark) + paint(p.flavor, mid) + paint(p.accent, mark) + " ".repeat(right);
    return wrap(body);
  };

  return [
    "",
    edge("  ╭") + paint(p.frame, bar) + edge("╮"),
    flavorLine(),
    blank(),
    line(p.kicker, spec.kicker),
    ...bigText(spec.title).map((r, i) => line(p.gradient[i], r, true)),
    line(p.dots, gridDots),
    line(p.tagline, spec.tagline[0]),
    line(p.tagline, spec.tagline[1]),
    edge("  ╰") + paint(p.frame, bar) + edge("╯"),
    "",
  ];
}

// The Hollow Grid: cold cyan going hollow, a neon-magenta accent, phosphor-green
// grid showing through. The dead city that just hums.
const HOLLOW_GRID: BannerSpec = {
  title: "HOLLOW   GRID",
  kicker: "T  H  E",
  flavor: "the grid remembers what we were",
  tagline: ["the network outlived us.", "now it just hums, empty, and waits."],
  palette: {
    frame: fg(30),
    accent: fg(201),
    kicker: fg(66),
    gradient: [fg(51), fg(45), fg(44), fg(38), fg(31)],
    flavor: fg(240),
    tagline: fg(245),
    dots: fg(22),
  },
};

// Dustfall: the hot rust of the open salt pan, a burning-orange accent, drifting
// dust showing through. The place people fled TO.
const DUSTFALL: BannerSpec = {
  title: "DUSTFALL",
  kicker: "W E L C O M E   T O",
  flavor: "the pan keeps what the wind brings",
  tagline: ["everyone here ran from somewhere.", "the dust hasn't decided what you are yet."],
  palette: {
    frame: fg(94),
    accent: fg(202),
    kicker: fg(180),
    gradient: [fg(229), fg(223), fg(216), fg(208), fg(166)],
    flavor: fg(180),
    tagline: fg(245),
    dots: fg(94),
  },
};

// Pick a world's banner by key (set per deployment via WORLD_MAP, like the map
// and bestiary). Unknown or unset falls back to the Hollow Grid.
export function bannerFor(key?: string): string[] {
  return key?.trim().toLowerCase() === "dustfall" ? build(DUSTFALL) : build(HOLLOW_GRID);
}
