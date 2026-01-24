// Wurm Online - Advanced Shard Analyzer (static)
//
// Key fixes in this build:
// - Supports multiple veins of the same ore+quality bin correctly by using:
//    per-entry UNION of candidate tiles, then cross-entry INTERSECTION.
// - Unresolved tiles are hatched and darken with overlap.
// - Locked tiles are magenta-outlined.
// - Labels render INSIDE the tile (ore on line 1, quality/range on line 2).
// - Grid lines are visible (minor + major).
// - Red X source markers remain (no red box).
// - Entries list, Undo, Reset, Download PNG all work.

//
// ----------------------------
// Direction & distance helpers
// ----------------------------
function normalizeDirText(s){
  return s.trim().toLowerCase().replace(/-/g," ").replace(/\s+/g," ");
}

function dirSector(dx, dy){
  if(dx===0 && dy===0) return "CENTER";
  const ax = Math.abs(dx), ay = Math.abs(dy);

  if(dx===0) return dy>0 ? "N" : "S";
  if(dy===0) return dx>0 ? "E" : "W";

  if(ax===ay){
    if(dx>0 && dy>0) return "NE";
    if(dx>0 && dy<0) return "SE";
    if(dx<0 && dy<0) return "SW";
    if(dx<0 && dy>0) return "NW";
  }

  if(ay > ax){
    if(dy>0) return dx>0 ? "E of N" : "W of N";
    return dx>0 ? "E of S" : "W of S";
  } else {
    if(dx>0) return dy>0 ? "N of E" : "S of E";
    return dy>0 ? "N of W" : "S of W";
  }
}

function ringCandidates(px, py, d){
  const out = [];
  for(let dx=-d; dx<=d; dx++){
    for(let dy=-d; dy<=d; dy++){
      if(Math.max(Math.abs(dx), Math.abs(dy)) !== d) continue;
      out.push([px+dx, py+dy]);
    }
  }
  return out;
}

const DIR_MAP = {
  "north":"N","south":"S","east":"E","west":"W",
  "northeast":"NE","northwest":"NW","southeast":"SE","southwest":"SW",
  "east of north":"E of N","west of north":"W of N",
  "east of south":"E of S","west of south":"W of S",
  "north of east":"N of E","south of east":"S of E",
  "north of west":"N of W","south of west":"S of W",
};

function candidatesForLine(px, py, d, dirText){
  const dir = DIR_MAP[normalizeDirText(dirText)];
  if(!dir) return new Set();
  const set = new Set();
  for(const [x,y] of ringCandidates(px, py, d)){
    const dx = x - px, dy = y - py;
    if(dirSector(dx,dy) === dir){
      set.add(`${x},${y}`);
    }
  }
  return set;
}

function strengthToDistance(line){
  const s = line.toLowerCase();
  if(/\b(indistinct)\b/.test(s)) return 6;
  if(/\b(vague)\b/.test(s)) return 5;
  if(/\b(minuscule)\b/.test(s)) return 4;
  if(/\b(faint)\b/.test(s)) return 3;
  if(/\b(slight)\b/.test(s)) return 2;
  if(/\b(trace|traces)\b/.test(s)) return 1;
  return null;
}

//
// ----------------------------
// Quality label + colors
// ----------------------------
// Your requirement: show ore name + colored number range below.
// Also: if numeric quality exists, show single number (not a range).
function qualityRangeFromAdjective(line){
  const s = line.toLowerCase();
  if(/\butmost\b/.test(s)) return "95-99";
  if(/\bvery good\b/.test(s)) return "80-94";
  if(/\bgood\b/.test(s)) return "60-79";
  if(/\bnormal\b/.test(s)) return "40-59";
  if(/\bacceptable\b/.test(s)) return "30-39";
  if(/\bpoor\b/.test(s)) return "20-29";
  return "unknown";
}

function qualityLabelFromLine(line){
  // If numeric quality appears, display as exact integer.
  const s = line.toLowerCase();
  const m = s.match(/\b(\d{1,3})(?:\.\d+)?\b/);
  if(m){
    const q = parseInt(m[1], 10);
    if(!Number.isNaN(q) && q >= 0 && q <= 100) return String(q);
  }
  return qualityRangeFromAdjective(line);
}

function qColor(qLabel){
  // Updated bins per your screenshot:
  // 95-99 orange, 80-94 purple, 60-79 blue, 40-59 green, 30-39 white, 20-29 gray.
  const n = /^[0-9]+$/.test(qLabel) ? parseInt(qLabel,10) : null;

  const bin = (num)=>{
    if(num >= 95) return "95-99";
    if(num >= 80) return "80-94";
    if(num >= 60) return "60-79";
    if(num >= 40) return "40-59";
    if(num >= 30) return "30-39";
    if(num >= 20) return "20-29";
    return "other";
  };

  const b = (n!==null) ? bin(n) : qLabel;

  switch(b){
    case "95-99": return "rgba(255,149,0,1)";    // orange
    case "80-94": return "rgba(166,77,255,1)";   // purple
    case "60-79": return "rgba(60,140,255,1)";   // blue
    case "40-59": return "rgba(0,255,120,1)";    // green
    case "30-39": return "rgba(255,255,255,1)";  // white
    case "20-29": return "rgba(170,170,170,1)";  // gray
    default: return "rgba(220,220,220,1)";
  }
}

function titleCase(s){
  return s.split(" ").map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(" ");
}

//
// ----------------------------
// Parsing (more forgiving)
// ----------------------------
// Supports:
//  - "You find faint traces of iron (north of east)."
//  - "You find vague traces of iron ore (west)."
function parseDirectionalLine(line){
  const d = strengthToDistance(line);
  if(!d) return null;

  // Ore + direction in parentheses
  const m = line.match(/traces?\s+of\s+([a-z ]+?)\s*(?:ore)?\s*\(([^)]+)\)/i);
  if(!m) return null;

  const ore = m[1].trim().toLowerCase().replace(/\s+/g," ");
  const dir = m[2].trim();

  const qLabel = qualityLabelFromLine(line);
  return { ore: titleCase(ore), qLabel, d, dir };
}

function parseExactLine(line){
  // "You would mine iron here."
  const m = line.match(/you would mine\s+([a-z ]+?)\s+here/i);
  if(!m) return null;

  const ore = m[1].trim().toLowerCase().replace(/\s+/g," ");
  if(ore.includes("stone shards")) return null;

  const qLabel = qualityLabelFromLine(line);
  return { ore: titleCase(ore), qLabel };
}

function parseLog(text){
  const directional = [];
  const exact = [];
  for(const raw of text.split(/\r?\n/)){
    const line = raw.trim();
    if(!line) continue;

    const ex = parseExactLine(line);
    if(ex){ exact.push(ex); continue; }

    const dl = parseDirectionalLine(line);
    if(dl) directional.push(dl);
  }
  return { directional, exact };
}

//
// ----------------------------
// Solver state
// ----------------------------
// IMPORTANT: We do NOT assume a single vein instance per ore+quality.
// Instead we do per-entry union, then cross-entry intersection.
const state = {
  entries: [],

  // locked: key -> {xy:"x,y", ore, qLabel}
  locked: new Map(),

  // feasible: key -> {set:Set("x,y"), ore, qLabel}
  feasible: new Map()
};

function setUnion(a, b){
  const out = new Set(a);
  for(const v of b) out.add(v);
  return out;
}

function setIntersect(a, b){
  const out = new Set();
  for(const v of a) if(b.has(v)) out.add(v);
  return out;
}

function makeKey(ore, qLabel){
  return `${ore}|${qLabel}`;
}

function rebuildAll(){
  state.locked.clear();
  state.feasible.clear();

  // 1) Gather per-entry unions for each ore+qLabel.
  // entryUnions: key -> Set("x,y") union across all occurrences in that entry
  // across entries, we'll intersect these unions.
  const perEntryResults = []; // array of Map(key -> {set, ore, qLabel})

  for(const entry of state.entries){
    const { x, y, text } = entry;
    const { directional, exact } = parseLog(text);

    // Apply exact locks immediately.
    for(const ex of exact){
      const key = makeKey(ex.ore, ex.qLabel);
      state.locked.set(key, { xy: `${x},${y}`, ore: ex.ore, qLabel: ex.qLabel });
    }

    const m = new Map();

    // For each directional occurrence, compute its candidate set.
    for(const obs of directional){
      const key = makeKey(obs.ore, obs.qLabel);
      if(state.locked.has(key)) continue;

      const c = candidatesForLine(x, y, obs.d, obs.dir);
      if(!m.has(key)){
        m.set(key, { set: new Set(c), ore: obs.ore, qLabel: obs.qLabel });
      } else {
        // UNION within the entry for same ore+qLabel (multiple veins of same type)
        const prev = m.get(key);
        prev.set = setUnion(prev.set, c);
      }
    }

    perEntryResults.push(m);
  }

  // 2) Cross-entry intersection of those unions.
  // Start by collecting all keys that appear in ANY entry union.
  const allKeys = new Set();
  for(const em of perEntryResults){
    for(const key of em.keys()) allKeys.add(key);
  }

  for(const key of allKeys){
    if(state.locked.has(key)) continue;

    let current = null;
    let ore = null, qLabel = null;

    for(const em of perEntryResults){
      if(!em.has(key)) continue;
      const v = em.get(key);
      ore = v.ore; qLabel = v.qLabel;

      current = (current === null) ? new Set(v.set) : setIntersect(current, v.set);
    }

    if(current === null) continue;

    if(current.size === 1){
      const only = [...current][0];
      state.locked.set(key, { xy: only, ore, qLabel });
    } else {
      state.feasible.set(key, { set: current, ore, qLabel });
    }
  }
}

//
// ----------------------------
// Rendering
// ----------------------------
function parseXY(s){
  const [x,y] = s.split(",").map(v=>parseInt(v,10));
  return {x,y};
}

function getBounds(){
  const PAD = 6;

  if(state.entries.length === 0){
    return { xmin:-6, xmax:6, ymin:-6, ymax:6 };
  }

  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;

  const include = (x, y) => {
    xmin = Math.min(xmin, x);
    xmax = Math.max(xmax, x);
    ymin = Math.min(ymin, y);
    ymax = Math.max(ymax, y);
  };

  for(const e of state.entries){
    include(e.x - PAD, e.y - PAD);
    include(e.x + PAD, e.y + PAD);
  }

  for(const v of state.locked.values()){
    const {x,y} = parseXY(v.xy);
    include(x,y);
  }
  for(const v of state.feasible.values()){
    for(const xy of v.set){
      const {x,y} = parseXY(xy);
      include(x,y);
    }
  }

  return { xmin, xmax, ymin, ymax };
}

function drawHatch(ctx, x, y, cell){
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, cell, cell);
  ctx.clip();

  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 1;

  const step = 8;
  for(let i = -cell; i < cell*2; i += step){
    ctx.beginPath();
    ctx.moveTo(x + i, y);
    ctx.lineTo(x + i + cell, y + cell);
    ctx.stroke();
  }
  ctx.restore();
}

function drawCellLabel(ctx, X, Y, cell, ore, qLabel, color){
  // Label inside cell like WurmNode
  const boxW = cell - 10;
  const boxH = 38;
  const bx = X + 5;
  const by = Y + (cell - boxH)/2;

  ctx.fillStyle = "rgba(0,0,0,0.65)";
  ctx.fillRect(bx, by, boxW, boxH);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.font = "14px system-ui";
  ctx.fillStyle = "rgba(230,230,230,0.95)";
  ctx.fillText(ore, X + cell/2, by + 12);

  ctx.font = "14px system-ui";
  ctx.fillStyle = color;
  ctx.fillText(qLabel, X + cell/2, by + 28);

  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}

function sourceMarker(ctx, X, Y, cell, idx){
  ctx.strokeStyle = "rgba(255,0,0,0.95)";
  ctx.lineWidth = 3;

  ctx.beginPath();
  ctx.moveTo(X + 10, Y + 10);
  ctx.lineTo(X + cell - 10, Y + cell - 10);
  ctx.moveTo(X + cell - 10, Y + 10);
  ctx.lineTo(X + 10, Y + cell - 10);
  ctx.stroke();

  ctx.fillStyle = "rgba(255,0,0,0.95)";
  ctx.font = "12px system-ui";
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(String(idx), X + cell - 4, Y + cell - 6);

  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}

function render(){
  const canvas = document.getElementById("mapCanvas");
  const ctx = canvas.getContext("2d");

  const {xmin,xmax,ymin,ymax} = getBounds();
  const gridW = (xmax-xmin+1);
  const gridH = (ymax-ymin+1);

  // Make cells big enough for label INSIDE
  const cell = 86;
  const margin = 24;

  const width = Math.min(3000, Math.max(900, gridW*cell + margin*2));
  const height = Math.min(2200, Math.max(700, gridH*cell + margin*2));

  if(canvas.width !== width) canvas.width = width;
  if(canvas.height !== height) canvas.height = height;

  ctx.fillStyle = "#0b0e14";
  ctx.fillRect(0,0,canvas.width, canvas.height);

  const ox = margin;
  const oy = margin;

  const px = (x)=> ox + (x - xmin) * cell;
  const py = (y)=> oy + (ymax - y) * cell;

  // Grid lines (fix "missing" look): stronger minor + stronger major
  for(let x=xmin; x<=xmax; x++){
    const X = px(x);
    const major = ((x - xmin) % 4 === 0);
    ctx.strokeStyle = major ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.12)";
    ctx.lineWidth = major ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(X, py(ymin));
    ctx.lineTo(X, py(ymax)+cell);
    ctx.stroke();
  }
  for(let y=ymin; y<=ymax; y++){
    const Y = py(y);
    const major = ((ymax - y) % 4 === 0);
    ctx.strokeStyle = major ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.12)";
    ctx.lineWidth = major ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(px(xmin), Y);
    ctx.lineTo(px(xmax)+cell, Y);
    ctx.stroke();
  }

  // Build overlap intensity + tile label lists for unresolved
  const intensity = new Map(); // xy -> count
  const tileToLabels = new Map(); // xy -> [{ore,qLabel,color}, ...]

  const addIntensity = (xy)=> intensity.set(xy, (intensity.get(xy)||0) + 1);

  for(const v of state.feasible.values()){
    const color = qColor(v.qLabel);
    for(const xy of v.set){
      addIntensity(xy);
      if(!tileToLabels.has(xy)) tileToLabels.set(xy, []);
      tileToLabels.get(xy).push({ ore: v.ore, qLabel: v.qLabel, color });
    }
  }

  let maxv = 1;
  for(const v of intensity.values()) maxv = Math.max(maxv, v);

  // Fill + hatch unresolved tiles with darkening
  for(const [xy, v] of intensity.entries()){
    const {x,y} = parseXY(xy);
    const t = Math.max(0, Math.min(1, v/maxv));
    const g = Math.floor(220 * (1 - t));
    const X = px(x), Y = py(y);

    ctx.fillStyle = `rgb(${g},${g},${g})`;
    ctx.fillRect(X, Y, cell, cell);
    drawHatch(ctx, X, Y, cell);
  }

  // Labels inside hatched tiles:
  // If multiple different labels overlap, show the "strongest" one (most overlap contributes)
  // and then "+N" if there are more.
  for(const [xy, labels] of tileToLabels.entries()){
    const {x,y} = parseXY(xy);
    const X = px(x), Y = py(y);

    // Prefer highest quality numeric/bin just for determinism
    labels.sort((a,b)=>{
      const na = /^[0-9]+$/.test(a.qLabel) ? parseInt(a.qLabel,10) : -1;
      const nb = /^[0-9]+$/.test(b.qLabel) ? parseInt(b.qLabel,10) : -1;
      return nb - na;
    });

    const main = labels[0];
    drawCellLabel(ctx, X, Y, cell, main.ore, main.qLabel, main.color);

    if(labels.length > 1){
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.font = "12px system-ui";
      ctx.textAlign = "right";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(`+${labels.length-1}`, X + cell - 6, Y + cell - 8);
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
    }
  }

  // Sources (red X)
  for(let i=0; i<state.entries.length; i++){
    const e = state.entries[i];
    sourceMarker(ctx, px(e.x), py(e.y), cell, i+1);
  }

  // Locked tiles: magenta outline + label INSIDE
  for(const v of state.locked.values()){
    const {x,y} = parseXY(v.xy);
    const X = px(x), Y = py(y);

    ctx.strokeStyle = "rgba(255,0,255,1)";
    ctx.lineWidth = 4;
    ctx.strokeRect(X, Y, cell, cell);

    drawCellLabel(ctx, X, Y, cell, v.ore, v.qLabel, qColor(v.qLabel));
  }
}

//
// ----------------------------
// UI helpers
// ----------------------------
function updateStats(){
  const stats = document.getElementById("stats");
  stats.innerHTML =
    `Entries: ${state.entries.length}<br>` +
    `Locked veins: ${state.locked.size}<br>` +
    `Unresolved: ${state.feasible.size}`;
}

function snippetFromText(text){
  const line = text.split(/\r?\n/).map(s=>s.trim()).find(s=>s.length>0) || "";
  return line;
}

function renderEntriesList(){
  const host = document.getElementById("entriesList");
  host.innerHTML = "";

  if(state.entries.length === 0){
    const empty = document.createElement("div");
    empty.className = "entryMeta";
    empty.textContent = "No entries yet. Add a step + pasted log above.";
    host.appendChild(empty);
    return;
  }

  state.entries.forEach((e, idx) => {
    const card = document.createElement("div");
    card.className = "entryCard";

    const left = document.createElement("div");
    const meta = document.createElement("div");
    meta.className = "entryMeta";
    meta.innerHTML = `<strong>#${idx+1}</strong> &nbsp; step: (${e.x}, ${e.y})`;

    const snip = document.createElement("div");
    snip.className = "entrySnippet";
    snip.textContent = snippetFromText(e.text);

    left.appendChild(meta);
    left.appendChild(snip);

    const btns = document.createElement("div");
    btns.className = "entryBtns";

    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = "Delete";
    del.addEventListener("click", () => {
      state.entries.splice(idx, 1);
      regenerate();
    });

    btns.appendChild(del);

    card.appendChild(left);
    card.appendChild(btns);
    host.appendChild(card);
  });
}

function regenerate(){
  rebuildAll();
  updateStats();
  renderEntriesList();
  render();
}

//
// ----------------------------
// Wiring
// ----------------------------
document.getElementById("addBtn").addEventListener("click", ()=>{
  const stepX = parseInt(document.getElementById("stepX").value, 10) || 0;
  const stepY = parseInt(document.getElementById("stepY").value, 10) || 0;
  const text = document.getElementById("logText").value.trim();
  if(!text){
    alert("Paste a log first.");
    return;
  }
  state.entries.push({ x: stepX, y: stepY, text });
  document.getElementById("logText").value = "";
  regenerate();
});

document.getElementById("undoBtn").addEventListener("click", ()=>{
  state.entries.pop();
  regenerate();
});

document.getElementById("resetBtn").addEventListener("click", ()=>{
  if(!confirm("Reset all entries?")) return;
  state.entries = [];
  regenerate();
});

document.getElementById("downloadBtn").addEventListener("click", ()=>{
  const canvas = document.getElementById("mapCanvas");
  const a = document.createElement("a");
  a.download = "wurm-online-advanced-shard-analyzer.png";
  a.href = canvas.toDataURL("image/png");
  a.click();
});

// Initial render
regenerate();
