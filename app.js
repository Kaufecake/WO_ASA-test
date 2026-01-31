/* Wurm Online – Advanced Shard Analyzer (app.js)
   Full replacement implementing:
   - session anchoring (ignore until gather/analyse)
   - mining-context lock (would mine X + max QL)
   - "Unknown" indistinct traces
   - multiplicity (multiple instances per ore/ql)
   - uniform grid only (no major lines)
   - hatch only unresolved candidate cells
   - centered label for multi-cell candidates, no hatch behind text
*/

const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d");

const stepXEl = document.getElementById("stepX");
const stepYEl = document.getElementById("stepY");
const logTextEl = document.getElementById("logText");

const addBtn = document.getElementById("addBtn");
const undoBtn = document.getElementById("undoBtn");
const resetBtn = document.getElementById("resetBtn");
const downloadBtn = document.getElementById("downloadBtn");
const statsEl = document.getElementById("stats");

const STORAGE_KEY = "wo_shard_analyzer_state_v3";

const QUALITY_BANDS = [
  { key: "poor",      label: "20-29", color: "#9aa0a6" },
  { key: "normal",    label: "40-59", color: "#3ddc84" },
  { key: "good",      label: "60-79", color: "#4ea1ff" },
  { key: "very_good", label: "80-94", color: "#b36bff" },
  { key: "utmost",    label: "95-99", color: "#ffb020" }
];

function bandForAdj(adj) {
  if (!adj) return null;
  const a = adj.toLowerCase();
  if (a.includes("utmost")) return QUALITY_BANDS.find(b => b.key === "utmost");
  if (a.includes("very good")) return QUALITY_BANDS.find(b => b.key === "very_good");
  if (a.includes("good")) return QUALITY_BANDS.find(b => b.key === "good");
  if (a.includes("normal")) return QUALITY_BANDS.find(b => b.key === "normal");
  if (a.includes("poor")) return QUALITY_BANDS.find(b => b.key === "poor");
  return null;
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function parseIntSafe(v, fallback = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

// ===== State =====
// Each "entry" is one paste + step coordinate, stored for undo/rebuild
// Veins are derived by replaying entries into a constraint solver.
let state = {
  entries: [],
  nextVeinId: 1
};

// Vein instance structure:
// {
//   id,
//   ore,              // "iron" | "copper" | "Unknown" etc (display-cased later)
//   qlDisplay,        // "96" or "95-99" or ""
//   qlColor,          // hex
//   feasible: Set<string>, // "x,y" for unresolved OR for locked (size=1)
//   locked: boolean,
//   lockedCoord: {x,y} | null
// }

function coordKey(x, y) { return `${x},${y}`; }
function parseCoordKey(k) {
  const [xs, ys] = k.split(",");
  return { x: parseInt(xs, 10), y: parseInt(ys, 10) };
}

function setIntersect(a, b) {
  const out = new Set();
  for (const v of a) if (b.has(v)) out.add(v);
  return out;
}

function setSize(s) { return s ? s.size : 0; }

function oreNormalize(raw) {
  if (!raw) return null;
  let t = raw.toLowerCase().trim();

  // common phrases
  t = t.replace(/\s+ore\b/g, "");        // "iron ore" -> "iron"
  t = t.replace(/\s+vein\b/g, "");
  t = t.replace(/\s+here\b/g, "");

  // normalize plural / shards phrasing
  if (t.includes("stone shards")) return null; // ignore
  if (t.includes("shards")) return null;

  // keep only letters/spaces
  t = t.replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;

  // if phrase ends with "quality iron" etc, later parsing handles it
  return t;
}

function titleCase(s) {
  return s.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1));
}

// ===== Direction parsing =====
const DIR_MAP = {
  "north": { dx: 0, dy: 1 },
  "south": { dx: 0, dy: -1 },
  "east":  { dx: 1, dy: 0 },
  "west":  { dx: -1, dy: 0 },
  "northeast": { dx: 1, dy: 1 },
  "northwest": { dx: -1, dy: 1 },
  "southeast": { dx: 1, dy: -1 },
  "southwest": { dx: -1, dy: -1 },
  "ne": { dx: 1, dy: 1 },
  "nw": { dx: -1, dy: 1 },
  "se": { dx: 1, dy: -1 },
  "sw": { dx: -1, dy: -1 }
};

function parseDirectionPhrase(phraseRaw) {
  if (!phraseRaw) return null;
  const p = phraseRaw.toLowerCase().replace(/[().]/g, "").trim();

  // exact matches
  if (DIR_MAP[p]) return { type: "octant", ...DIR_MAP[p] };

  // formats: "north of east", "east of north", etc
  const m = p.match(/(north|south|east|west)\s+of\s+(north|south|east|west)/i);
  if (m) {
    const a = m[1].toLowerCase();
    const b = m[2].toLowerCase();
    // we treat this as the "between" octant (a blended direction)
    const v1 = DIR_MAP[a];
    const v2 = DIR_MAP[b];
    const dx = clamp(v1.dx + v2.dx, -1, 1);
    const dy = clamp(v1.dy + v2.dy, -1, 1);
    return { type: "octant", dx, dy };
  }

  return null;
}

// ===== Strength -> distance mapping =====
// You can tune these; they’re the typical “ring distance” approach.
function strengthToDistance(strengthWord) {
  if (!strengthWord) return 0;
  const s = strengthWord.toLowerCase();
  // Most restrictive should map to farthest ring
  if (s.includes("indistinct")) return 5;
  if (s.includes("vague"))      return 4;
  if (s.includes("minuscule"))  return 3;
  if (s.includes("faint"))      return 3;
  if (s.includes("slight"))     return 2;
  return 2;
}

// Candidate ring points at Chebyshev distance d filtered by octant
function ringCandidates(source, d, dir) {
  const out = new Set();
  if (!d || d < 1 || !dir) return out;

  const sx = source.x, sy = source.y;
  // ring: max(|dx|,|dy|) == d
  for (let dx = -d; dx <= d; dx++) {
    for (let dy = -d; dy <= d; dy++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== d) continue;

      // octant filter
      if (!octantMatch(dx, dy, dir)) continue;

      out.add(coordKey(sx + dx, sy + dy));
    }
  }
  return out;
}

// For an octant direction (dx,dy in {-1,0,1}), require matching signs
function octantMatch(dx, dy, dir) {
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);

  // If dir wants dx=0, then dx must be 0. If dir wants dx!=0, signs must match.
  if (dir.dx === 0 && sx !== 0) return false;
  if (dir.dx !== 0 && sx !== dir.dx) return false;

  if (dir.dy === 0 && sy !== 0) return false;
  if (dir.dy !== 0 && sy !== dir.dy) return false;

  return true;
}

// ===== Parsing =====
function extractStrengthWord(line) {
  const s = line.toLowerCase();
  // detect the strongest match present
  const words = ["indistinct", "vague", "minuscule", "faint", "slight"];
  for (const w of words) if (s.includes(w)) return w;
  return null;
}

// Parses "utmost quality iron" => { adj:"utmost", ore:"iron" }
// Parses "very good quality iron" => { adj:"very good", ore:"iron" }
// Parses "iron" => { adj:null, ore:"iron" }
function parseOreAndAdjFromDescriptor(descRaw) {
  if (!descRaw) return null;
  const d = descRaw.toLowerCase().trim();

  // Special: "something, but cannot quite make it out"
  if (d.includes("something") && d.includes("cannot quite make it out")) {
    return { ore: "Unknown", adj: null };
  }
  if (d === "something") return { ore: "Unknown", adj: null };

  // Try to find one of the known quality phrases
  let adj = null;
  if (d.includes("utmost quality")) adj = "utmost";
  else if (d.includes("very good quality")) adj = "very good";
  else if (d.includes("good quality")) adj = "good";
  else if (d.includes("normal quality")) adj = "normal";
  else if (d.includes("poor quality")) adj = "poor";

  // Ore is usually last word: "... iron"
  // Strip "quality" phrase and take remaining tail
  let orePart = d
    .replace("utmost quality", "")
    .replace("very good quality", "")
    .replace("good quality", "")
    .replace("normal quality", "")
    .replace("poor quality", "")
    .replace(/\bquality\b/g, "")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!orePart) orePart = d.replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  const tokens = orePart.split(" ").filter(Boolean);
  const ore = tokens.length ? tokens[tokens.length - 1] : null;

  if (!ore) return null;
  return { ore: oreNormalize(ore) || ore, adj };
}

// Parse one pasted block into a structured "entry"
function parseLogBlock(rawText) {
  const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  let started = false;
  let ended = false;

  // Mining-context (used to lock at the source)
  let mineOre = null;
  let mineMaxQl = null;

  // Trace observations (directional)
  const traces = [];

  // Accept either analyse/analyze + shard/ore, or gather fragments
  const startRegex = /(you start to gather fragments of the rock\.)|(you start to analys(e|z)e the (shard|ore)\.)/i;
  const endRegex = /you finish analys(e|z)ing the (shard|ore)\./i;

  // "You would mine X here."
  const mineRegex = /you would mine (.+?) here\./i;
  const maxQlRegex = /it has a max quality of (\d+)\./i;

  // directional trace formats include:
  // "You spot a slight trace of utmost quality iron (north of east)."
  // "You notice a vague trace of very good quality iron (west)."
  // "You spot an indistinct trace of something, but cannot quite make it out (east of north)."
  const traceRegex = /\b(trace of)\s+(.+?)\s*\((.+?)\)\./i;

  for (const line of lines) {
    if (!started) {
      if (startRegex.test(line)) {
        started = true;
      } else {
        continue; // ignore before start
      }
    }

    if (endRegex.test(line)) {
      ended = true;
      // include nothing after end
      break;
    }

    // mining context
    const mMine = line.match(mineRegex);
    if (mMine) {
      const ore = oreNormalize(mMine[1]);
      if (ore) mineOre = ore;
      continue;
    }

    const mQl = line.match(maxQlRegex);
    if (mQl) {
      mineMaxQl = parseIntSafe(mQl[1], null);
      continue;
    }

    // trace lines
    const mTrace = line.match(traceRegex);
    if (mTrace) {
      const strength = extractStrengthWord(line);
      const descriptor = mTrace[2].trim();
      const dirPhrase = mTrace[3].trim();

      const dir = parseDirectionPhrase(dirPhrase);
      if (!dir) continue;

      const parsed = parseOreAndAdjFromDescriptor(descriptor);
      if (!parsed) continue;

      let ore = parsed.ore || "Unknown";
      if (!ore) ore = "Unknown";

      let adj = parsed.adj; // may be null

      traces.push({
        ore,
        adj,
        strengthWord: strength,
        dir
      });
      continue;
    }

    // otherwise ignore
  }

  if (!started) return null;

  return {
    mineOre,
    mineMaxQl,
    traces,
    ended
  };
}

// ===== Multiplicity / data association =====
function bestMatchingVein(veins, ore, qlDisplay, candidateSet) {
  let best = null;
  let bestScore = 0;

  for (const v of veins) {
    if (v.ore !== ore) continue;
    if ((v.qlDisplay || "") !== (qlDisplay || "")) continue;
    if (!v.feasible || v.feasible.size === 0) continue;

    // Score by overlap size
    let overlap = 0;
    for (const k of candidateSet) if (v.feasible.has(k)) overlap++;
    if (overlap > bestScore) {
      bestScore = overlap;
      best = v;
    }
  }

  // Require at least some overlap
  return bestScore > 0 ? best : null;
}

function createVeinInstance(ore, qlDisplay, qlColor, feasibleSet) {
  return {
    id: state.nextVeinId++,
    ore,
    qlDisplay: qlDisplay || "",
    qlColor: qlColor || "#cfd8dc",
    feasible: new Set(feasibleSet),
    locked: false,
    lockedCoord: null
  };
}

function lockVeinAt(veins, ore, qlDisplay, qlColor, x, y) {
  const k = coordKey(x, y);

  // If there is already a matching vein whose feasible includes this coord, lock it
  for (const v of veins) {
    if (v.ore === ore && (v.qlDisplay || "") === (qlDisplay || "")) {
      if (v.feasible && v.feasible.has(k)) {
        v.feasible = new Set([k]);
        v.locked = true;
        v.lockedCoord = { x, y };
        v.qlColor = qlColor || v.qlColor;
        return;
      }
    }
  }

  // Otherwise create a new locked instance
  const vNew = createVeinInstance(ore, qlDisplay, qlColor, [k]);
  vNew.locked = true;
  vNew.lockedCoord = { x, y };
  veins.push(vNew);
}

function incorporateCandidates(veins, ore, qlDisplay, qlColor, candidateSet) {
  // Find best existing match (multiplicity support)
  const match = bestMatchingVein(veins, ore, qlDisplay, candidateSet);

  if (!match) {
    veins.push(createVeinInstance(ore, qlDisplay, qlColor, candidateSet));
    return;
  }

  // Intersect and update
  match.feasible = setIntersect(match.feasible, candidateSet);

  if (match.feasible.size === 1) {
    const only = [...match.feasible][0];
    const c = parseCoordKey(only);
    match.locked = true;
    match.lockedCoord = { x: c.x, y: c.y };
  }
}

// ===== Rebuild solver from entries =====
function rebuildVeinsFromEntries() {
  const veins = [];

  for (const entry of state.entries) {
    const { stepX, stepY, parsed } = entry;
    const source = { x: stepX, y: stepY };

    // 1) Mining-context lock if ore + maxQL exist
    if (parsed.mineOre && Number.isFinite(parsed.mineMaxQl)) {
      const ore = parsed.mineOre;
      const ql = parsed.mineMaxQl;
      const qlDisplay = String(ql);
      const qlColor = qlColorForNumber(ql);
      lockVeinAt(veins, ore, qlDisplay, qlColor, source.x, source.y);
    }

    // 2) Directional traces grouped by (ore, adj/band)
    //    Within a single entry, multiple lines for same ore+band intersect.
    const groups = new Map(); // key => Set(coords)

    for (const t of parsed.traces) {
      const ore = t.ore || "Unknown";
      const band = bandForAdj(t.adj);
      const qlDisplay = band ? band.label : ""; // unknown band -> blank unless mined lock exists
      const qlColor = band ? band.color : "#cfd8dc";

      const d = strengthToDistance(t.strengthWord);
      if (!d) continue;

      const cand = ringCandidates(source, d, t.dir);
      if (cand.size === 0) continue;

      const key = `${ore}||${qlDisplay}`;
      if (!groups.has(key)) groups.set(key, cand);
      else groups.set(key, setIntersect(groups.get(key), cand));

      // store color for group
      // (we’ll compute again below; this is fine)
    }

    for (const [key, candSet] of groups.entries()) {
      if (!candSet || candSet.size === 0) continue;

      const [ore, qlDisplay] = key.split("||");
      let qlColor = "#cfd8dc";
      // if qlDisplay is a known band, use that color
      const knownBand = QUALITY_BANDS.find(b => b.label === qlDisplay);
      if (knownBand) qlColor = knownBand.color;

      incorporateCandidates(veins, ore, qlDisplay, qlColor, candSet);
    }
  }

  return veins;
}

function qlColorForNumber(n) {
  // map numeric to your same color family
  // (20-29 poor, 40-59 normal, 60-79 good, 80-94 very good, 95-99 utmost)
  if (!Number.isFinite(n)) return "#cfd8dc";
  if (n >= 95) return QUALITY_BANDS.find(b => b.key === "utmost").color;
  if (n >= 80) return QUALITY_BANDS.find(b => b.key === "very_good").color;
  if (n >= 60) return QUALITY_BANDS.find(b => b.key === "good").color;
  if (n >= 40) return QUALITY_BANDS.find(b => b.key === "normal").color;
  return QUALITY_BANDS.find(b => b.key === "poor").color;
}

// ===== Rendering =====
function drawBackground() {
  // dark bluish background
  const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  g.addColorStop(0, "#0b0f14");
  g.addColorStop(1, "#070a0f");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function computeBounds(veins) {
  // bounds in tile coordinates
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  // include all feasible cells + all sources
  for (const v of veins) {
    for (const k of v.feasible) {
      const c = parseCoordKey(k);
      minX = Math.min(minX, c.x);
      minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x);
      maxY = Math.max(maxY, c.y);
    }
  }
  for (const e of state.entries) {
    minX = Math.min(minX, e.stepX);
    minY = Math.min(minY, e.stepY);
    maxX = Math.max(maxX, e.stepX);
    maxY = Math.max(maxY, e.stepY);
  }

  if (!Number.isFinite(minX)) {
    minX = -10; minY = -10; maxX = 10; maxY = 10;
  }

  // padding so labels don’t clip
  const pad = 6;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;

  return { minX, minY, maxX, maxY };
}

function tileToPx(x, y, bounds, cell, margin) {
  const px = margin + (x - bounds.minX) * cell;
  // invert y for screen
  const py = margin + (bounds.maxY - y) * cell;
  return { px, py };
}

function drawUniformGrid(bounds, cell, margin) {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255,255,255,0.08)";

  const cols = bounds.maxX - bounds.minX + 1;
  const rows = bounds.maxY - bounds.minY + 1;

  // vertical lines
  for (let i = 0; i <= cols; i++) {
    const x = margin + i * cell;
    ctx.beginPath();
    ctx.moveTo(x, margin);
    ctx.lineTo(x, margin + rows * cell);
    ctx.stroke();
  }

  // horizontal lines
  for (let j = 0; j <= rows; j++) {
    const y = margin + j * cell;
    ctx.beginPath();
    ctx.moveTo(margin, y);
    ctx.lineTo(margin + cols * cell, y);
    ctx.stroke();
  }

  ctx.restore();
}

function hatchCell(px, py, cell) {
  // subtle diagonal hatch, no text background hatch
  ctx.save();
  ctx.beginPath();
  ctx.rect(px, py, cell, cell);
  ctx.clip();

  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;

  const step = 6;
  for (let i = -cell; i < cell * 2; i += step) {
    ctx.beginPath();
    ctx.moveTo(px + i, py + cell);
    ctx.lineTo(px + i + cell, py);
    ctx.stroke();
  }
  ctx.restore();
}

function drawLabelCentered(textTop, textBottom, centerX, centerY, color) {
  ctx.save();

  const padX = 10, padY = 8;
  ctx.font = "16px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  const wTop = ctx.measureText(textTop).width;
  const wBot = textBottom ? ctx.measureText(textBottom).width : 0;
  const boxW = Math.max(wTop, wBot) + padX * 2;
  const boxH = textBottom ? 48 : 32;

  const x = centerX - boxW / 2;
  const y = centerY - boxH / 2;

  // label background (solid, no hatch)
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  roundRect(ctx, x, y, boxW, boxH, 8);
  ctx.fill();

  // text
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.fillText(textTop, centerX, y + (textBottom ? 16 : boxH / 2));

  if (textBottom) {
    ctx.fillStyle = color || "rgba(255,255,255,0.92)";
    ctx.fillText(textBottom, centerX, y + 34);
  }

  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawSourceMarkers(bounds, cell, margin) {
  for (let i = 0; i < state.entries.length; i++) {
    const e = state.entries[i];
    const { px, py } = tileToPx(e.stepX, e.stepY, bounds, cell, margin);

    const cx = px + cell / 2;
    const cy = py + cell / 2;

    ctx.save();
    ctx.strokeStyle = "#ff3333";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - 10, cy - 10);
    ctx.lineTo(cx + 10, cy + 10);
    ctx.moveTo(cx + 10, cy - 10);
    ctx.lineTo(cx - 10, cy + 10);
    ctx.stroke();

    // label the first as "Source"
    if (i === 0) {
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.font = "16px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText("Source", cx + 14, cy - 14);
    }
    ctx.restore();
  }
}

function drawVeins(bounds, cell, margin, veins) {
  for (const v of veins) {
    const oreName = v.ore === "Unknown" ? "Unknown" : titleCase(v.ore);
    const qlText = v.qlDisplay || "";

    if (v.locked && v.feasible.size === 1) {
      // No hatching if locked
      const only = [...v.feasible][0];
      const c = parseCoordKey(only);
      const { px, py } = tileToPx(c.x, c.y, bounds, cell, margin);
      const cx = px + cell / 2;
      const cy = py + cell / 2;

      drawLabelCentered(oreName, qlText, cx, cy, v.qlColor);
      continue;
    }

    // Unresolved: hatch candidate cells
    let minPx = Infinity, minPy = Infinity, maxPx = -Infinity, maxPy = -Infinity;

    for (const k of v.feasible) {
      const c = parseCoordKey(k);
      const { px, py } = tileToPx(c.x, c.y, bounds, cell, margin);

      hatchCell(px, py, cell);

      minPx = Math.min(minPx, px);
      minPy = Math.min(minPy, py);
      maxPx = Math.max(maxPx, px + cell);
      maxPy = Math.max(maxPy, py + cell);
    }

    // One centered label over the candidate region
    if (Number.isFinite(minPx)) {
      const cx = (minPx + maxPx) / 2;
      const cy = (minPy + maxPy) / 2;
      drawLabelCentered(oreName, qlText, cx, cy, v.qlColor);
    }
  }
}

function render() {
  const veins = rebuildVeinsFromEntries();

  drawBackground();

  const bounds = computeBounds(veins);

  // choose cell size to fit
  const cols = bounds.maxX - bounds.minX + 1;
  const rows = bounds.maxY - bounds.minY + 1;

  const margin = 30;
  const usableW = canvas.width - margin * 2;
  const usableH = canvas.height - margin * 2;

  const cell = Math.max(8, Math.floor(Math.min(usableW / cols, usableH / rows)));

  // redraw with updated cell size
  drawUniformGrid(bounds, cell, margin);

  // veins
  drawVeins(bounds, cell, margin, veins);

  // sources on top
  drawSourceMarkers(bounds, cell, margin);

  // stats
  const lockedCount = veins.filter(v => v.locked).length;
  const unresolvedCount = veins.length - lockedCount;

  statsEl.innerHTML = `
    <div><b>Entries:</b> ${state.entries.length}</div>
    <div><b>Vein instances:</b> ${veins.length} (locked: ${lockedCount}, unresolved: ${unresolvedCount})</div>
  `;
}

// ===== UI actions =====
function addEntry() {
  const stepX = parseIntSafe(stepXEl.value, 0);
  const stepY = parseIntSafe(stepYEl.value, 0);
  const raw = logTextEl.value || "";

  const parsed = parseLogBlock(raw);
  if (!parsed) {
    alert("No usable session found. Make sure the paste includes 'You start to gather fragments...' or 'You start to analyse/analyze the shard/ore.'");
    return;
  }

  state.entries.push({ stepX, stepY, parsed, raw });
  saveState();
  render();
}

function undoEntry() {
  state.entries.pop();
  saveState();
  render();
}

function resetAll() {
  if (!confirm("Reset all entries?")) return;
  state.entries = [];
  state.nextVeinId = 1;
  saveState();
  render();
}

function downloadPNG() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const a = document.createElement("a");
  a.download = `wo_shard_map_${ts}.png`;
  a.href = canvas.toDataURL("image/png");
  a.click();
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {}
}

function loadState() {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (!s) return;
    const obj = JSON.parse(s);
    if (!obj || !Array.isArray(obj.entries)) return;
    state = obj;
    if (!Number.isFinite(state.nextVeinId)) state.nextVeinId = 1;
  } catch (e) {}
}

addBtn.addEventListener("click", addEntry);
undoBtn.addEventListener("click", undoEntry);
resetBtn.addEventListener("click", resetAll);
downloadBtn.addEventListener("click", downloadPNG);

loadState();
render();
