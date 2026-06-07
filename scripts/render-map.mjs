// Render a graphical SVG map of the world from src/rooms.ts (the single source of
// truth for rooms + exits). Dependency-free: parses the ROOMS object literal,
// lays rooms out on a grid by walking compass exits from START_ROOM (with
// collision nudging for the non-Euclidean vertical shafts), and emits a styled,
// zone-coloured SVG suitable for a website. Regenerate after adding rooms:
//   node scripts/render-map.mjs > docs/map.svg
//
// The topology is shared across the federation (Dustfall relabels the same rooms
// via WORLD_MAP), so this map's shape holds for every world; the labels are the
// primary world's (The Hollow Grid).

import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const src = readFileSync(ROOT + "src/rooms.ts", "utf8");

// --- pull the ROOMS object literal out of the TS source and eval it ----------
const startTok = "export const ROOMS";
const open = src.indexOf("{", src.indexOf(startTok));
let depth = 0, end = -1;
for (let i = open; i < src.length; i++) {
  if (src[i] === "{") depth++;
  else if (src[i] === "}" && --depth === 0) { end = i; break; }
}
const ROOMS = eval("(" + src.slice(open, end + 1) + ")");
const START = (src.match(/START_ROOM\s*=\s*"([^"]+)"/) || [])[1] || Object.keys(ROOMS)[0];

// --- zones (for colour); a room not listed falls back to "town" --------------
const ZONES = {
  town: { label: "The Nexus & Town", color: "#00e5ff", ids: ["nexus", "tavern", "market", "holding_pit", "workshop"] },
  undercity: { label: "The Undercity (server farm)", color: "#39ff14", ids: ["tunnels", "sump", "floodgate", "coldrow", "cooling", "fiber", "corelab", "archive"] },
  wastes: { label: "The Open Wastes", color: "#ffb000", ids: ["roof", "dunes", "scorch_road", "transit_hub", "waystation"] },
  front: { label: "The Cinder Front", color: "#ff2d55", ids: ["checkpoint", "gate", "muster", "cells", "warroom", "dais"] },
};
const zoneOf = (id) => Object.keys(ZONES).find((z) => ZONES[z].ids.includes(id)) || "town";

// --- layout: BFS from START, place by compass delta, nudge off collisions ----
const DELTA = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0], up: [0, -1], down: [0, 1] };
const pos = {};           // id -> [gx, gy]
const taken = new Set();  // "gx,gy"
const key = (x, y) => x + "," + y;
function freeNear(x, y) {
  if (!taken.has(key(x, y))) return [x, y];
  for (let r = 1; r < 12; r++)
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++)
        if (Math.max(Math.abs(dx), Math.abs(dy)) === r && !taken.has(key(x + dx, y + dy))) return [x + dx, y + dy];
  return [x, y];
}
pos[START] = [0, 0]; taken.add(key(0, 0));
const q = [START];
while (q.length) {
  const id = q.shift();
  const [x, y] = pos[id];
  for (const [dir, dest] of Object.entries(ROOMS[id].exits)) {
    if (pos[dest] || !ROOMS[dest]) continue;
    const d = DELTA[dir] || [0, 0];
    const [nx, ny] = freeNear(x + d[0], y + d[1]);
    pos[dest] = [nx, ny]; taken.add(key(nx, ny)); q.push(dest);
  }
}
// any unreached rooms: drop them in a spare column so nothing is silently lost
let spare = 0;
for (const id of Object.keys(ROOMS)) if (!pos[id]) { const p = freeNear(8, spare++); pos[id] = p; taken.add(key(p[0], p[1])); }

// --- undirected edge set (dedup n<->s pairs), flag vertical (up/down) links --
const edges = new Map();
for (const id of Object.keys(ROOMS))
  for (const [dir, dest] of Object.entries(ROOMS[id].exits)) {
    if (!ROOMS[dest]) continue;
    const k = [id, dest].sort().join("|");
    if (!edges.has(k)) edges.set(k, { a: id, b: dest, vert: dir === "up" || dir === "down" });
  }

// --- geometry ----------------------------------------------------------------
const COLW = 200, ROWH = 132, BW = 158, BH = 60, PAD = 90;
const xs = Object.values(pos).map((p) => p[0]), ys = Object.values(pos).map((p) => p[1]);
const minX = Math.min(...xs), minY = Math.min(...ys);
const cx = (id) => (pos[id][0] - minX) * COLW + PAD + BW / 2;
const cy = (id) => (pos[id][1] - minY) * ROWH + PAD + BH / 2 + 70; // +70 leaves room for the title band
const W = (Math.max(...xs) - minX) * COLW + BW + PAD * 2;
const H = (Math.max(...ys) - minY) * ROWH + BH + PAD * 2 + 70;

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function wrap(name) {
  if (name.length <= 18) return [name];
  const words = name.split(" "); const lines = ["", ""]; let i = 0;
  for (const w of words) { if ((lines[i] + " " + w).trim().length > 18 && i === 0) i = 1; lines[i] = (lines[i] + " " + w).trim(); }
  return lines.filter(Boolean);
}

// --- emit SVG ----------------------------------------------------------------
const out = [];
out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'Courier New',monospace">`);
out.push(`<defs>
  <filter id="glow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#13131f" stroke-width="1"/></pattern>
</defs>`);
out.push(`<rect width="${W}" height="${H}" fill="#0a0a12"/><rect width="${W}" height="${H}" fill="url(#grid)"/>`);

// title band
out.push(`<text x="${W / 2}" y="52" text-anchor="middle" fill="#e6f7ff" font-size="34" letter-spacing="14" filter="url(#glow)">THE HOLLOW GRID</text>`);
out.push(`<text x="${W / 2}" y="78" text-anchor="middle" fill="#5a6b7b" font-size="13" letter-spacing="3">the network outlived us. now it just hums, empty, and waits.</text>`);

// edges, routed as right-angle corridors (Manhattan elbows) so the non-aligned
// nudged links read as passages, not diagonals slashing the map.
const elbow = (x1, y1, x2, y2) =>
  x1 === x2 || y1 === y2 ? `${x1},${y1} ${x2},${y2}`
    : Math.abs(x2 - x1) >= Math.abs(y2 - y1) ? `${x1},${y1} ${x2},${y1} ${x2},${y2}` : `${x1},${y1} ${x1},${y2} ${x2},${y2}`;
for (const { a, b, vert } of edges.values()) {
  const pts = elbow(cx(a), cy(a), cx(b), cy(b));
  if (vert) out.push(`<polyline points="${pts}" fill="none" stroke="#9aa7b5" stroke-width="1.6" stroke-dasharray="5 4" opacity="0.6"/>`);
  else out.push(`<polyline points="${pts}" fill="none" stroke="#3a4a5a" stroke-width="2"/>`);
}

// rooms
for (const id of Object.keys(ROOMS)) {
  const color = ZONES[zoneOf(id)].color;
  const x = cx(id) - BW / 2, y = cy(id) - BH / 2;
  const lines = wrap(ROOMS[id].name);
  const isStart = id === START;
  out.push(`<g>`);
  out.push(`<rect x="${x}" y="${y}" width="${BW}" height="${BH}" rx="7" fill="#10131c" stroke="${color}" stroke-width="${isStart ? 3 : 1.7}" ${isStart ? 'filter="url(#glow)"' : ""}/>`);
  const ty = cy(id) - (lines.length - 1) * 8;
  lines.forEach((ln, i) => out.push(`<text x="${cx(id)}" y="${ty + i * 16 + 5}" text-anchor="middle" fill="#dfe9f3" font-size="13">${esc(ln)}</text>`));
  out.push(`</g>`);
}

// legend
let lx = PAD, ly = H - 34;
for (const z of Object.values(ZONES)) {
  out.push(`<rect x="${lx}" y="${ly - 11}" width="14" height="14" rx="3" fill="#10131c" stroke="${z.color}" stroke-width="2"/>`);
  out.push(`<text x="${lx + 22}" y="${ly}" fill="#9aa7b5" font-size="13">${esc(z.label)}</text>`);
  lx += 40 + z.label.length * 8.2;
}
out.push(`<text x="${W - PAD}" y="${H - 34}" text-anchor="end" fill="#5a6b7b" font-size="12">- - -  ladder / shaft (up·down)</text>`);
out.push(`</svg>`);
process.stdout.write(out.join("\n"));
