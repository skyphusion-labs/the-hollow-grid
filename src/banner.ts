// The login banner: a framed, color-graded title card sent to every connecting
// client. ANSI/256-color, so it lights up in any terminal client (wscat, the
// bundled `npm run connect`, telnet); a client that ignores escapes just sees
// the letters. The cyan gradient fades top-to-bottom, so the logo reads as going
// literally hollow -- on theme for "the network outlived us."
//
// Built once at module load. Exported as lines so the caller joins them with its
// own newline convention (the world speaks CRLF).

// Block glyphs, five rows tall. Only the letters in the title are defined.
const GLYPHS: Record<string, [string, string, string, string, string]> = {
  H: ["█  █", "█  █", "████", "█  █", "█  █"],
  O: [" ██ ", "█  █", "█  █", "█  █", " ██ "],
  L: ["█   ", "█   ", "█   ", "█   ", "████"],
  W: ["█   █", "█   █", "█ █ █", "██ ██", "█   █"],
  G: [" ███", "█   ", "█ ██", "█  █", " ███"],
  R: ["███ ", "█  █", "███ ", "█ █ ", "█  █"],
  I: ["███", " █ ", " █ ", " █ ", "███"],
  D: ["███ ", "█  █", "█  █", "█  █", "███ "],
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

const FRAME = fg(30); // dim teal frame
const NEON = fg(201); // neon magenta, the only loud accent (corners + flavor marks)
const THE = fg(66); // muted, so the logo dominates
const GRADIENT = [fg(51), fg(45), fg(44), fg(38), fg(31)]; // bright cyan -> deep
const TAGLINE = fg(245); // soft gray
const FLAVOR = fg(240); // dimmer gray
const STATIC = fg(22); // ghost-green grid, almost subliminal

// One centered line. `row` is single-color; `segRow` mixes colors on one line,
// centering by VISIBLE width so the escape codes never throw off the frame.
const row = (code: string, text: string): string => paint(FRAME, "  │") + paint(code, center(text)) + paint(FRAME, "│");
const blank = (): string => paint(FRAME, "  │") + " ".repeat(INNER) + paint(FRAME, "│");
function segRow(segs: { code: string; text: string }[]): string {
  const visible = segs.reduce((n, s) => n + [...s.text].length, 0);
  const left = Math.max(0, Math.floor((INNER - visible) / 2));
  const right = Math.max(0, INNER - visible - left);
  const body = " ".repeat(left) + segs.map((s) => paint(s.code, s.text)).join("") + " ".repeat(right);
  return paint(FRAME, "  │") + body + paint(FRAME, "│");
}

const title = bigText("HOLLOW   GRID");
const bar = "─".repeat(INNER);
// A widely spaced dotted line: the grid showing faintly through, like phosphor.
const gridDots = Array(14).fill("·").join("   ");

export const BANNER_LINES: string[] = [
  "",
  paint(NEON, "  ╭") + paint(FRAME, bar) + paint(NEON, "╮"),
  segRow([
    { code: NEON, text: ". : ." },
    { code: FLAVOR, text: "  the grid remembers what we were  " },
    { code: NEON, text: ". : ." },
  ]),
  blank(),
  row(THE, "T  H  E"),
  ...title.map((r, i) => row(`1;${GRADIENT[i]}`, r)),
  row(STATIC, gridDots),
  row(TAGLINE, "the network outlived us."),
  row(TAGLINE, "now it just hums, empty, and waits."),
  paint(NEON, "  ╰") + paint(FRAME, bar) + paint(NEON, "╯"),
  "",
];
