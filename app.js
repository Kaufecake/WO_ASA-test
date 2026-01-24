// Wurm Online - Advanced Shard Analyzer (static)
//
// Updates requested:
// - Do NOT draw a red box on source tile; draw only a red X with a small index.
// - Make squares larger (closer to WurmNode). We use a fixed-ish large cell size and auto-resize canvas.
// - Use WurmNode-style ore labels: ore name line 1, quality label line 2 (e.g., 95-99 or exact number) with color.
//   If an exact quality number is present in the line, we show it as a single integer (not a range).
// - Keep hatched unresolved candidates.
//
// Notes:
// - Quality ranges per Wurmpedia: Poor 20-29, Acceptable 30-39, Normal 40-59, Good 60-79, Very good 80-94, Utmost 95-99.

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
  const s = line.toLowerCase();

  // If a numeric quality appears, use a single integer label (closest integer).
  const m = s.match(/\b(\d{1,3})(?:\.\d+)?\b/);
  if(m){
    const q = parseInt(m[1], 10);
    if(!Number.isNaN(q) && q >= 0 && q <= 100){
      return String(q);
    }
  }

  return qualityRangeFromAdjective(line);
}

function oreFromLine(line){
  // "You notice a ... trace(s) of iron ore (...)" or "You would mine iron here."
  const s = line.toLowerCase();
  let m = s.match(/traces?\s+of\s+([a-z ]+?)\s*(?:ore)?\s*\(/i);
  if(m) return m[1].trim().replace(/\s+/g," ");
  m = s.match(/you would mine\s+([a-z ]+?)\s+here/i);
  if(m) return m[1].trim().replace(/\s+/g," ");
  return null;
}

function titleCase(s){
  return s.split(" ").map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(" ");
}

function veinKey(ore, qLabel){
  return `${titleCase(ore)}|${qLabel}`;
}

function parseDirectionalLine(line){
  const m = line.match(/traces?\s+of\s+([a-z ]+?)\s*(?:ore)?\s*\(([^)]+)\)/i);
  if(!m) return null;

  const ore = m[1].trim().toLowerCase().replace(/\s+/g," ");
  const dir = m[2].trim();
  const d = strengthToDistance(line);
  if(!d) return null;

  const qLabel = qualityLabelFromLine(line);
  return { key: veinKey(ore, qLabel), ore: titleCase(ore), qLabel, d, dir };
}

function parseExactLine(line){
  const m = line.match(/you would mine\s+([a-z ]+?)\s+here/i);
  if(!m) return null;

  const ore = m[1].trim().toLowerCase().replace(/\s+/g," ");
  if(ore.includes("stone shards")) return null;

  const qLabel = qualityLabelFromLine(line);
  return { key: veinKey(ore, qLabel), ore: titleCase(ore), qLabel };
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

// ----------------------------
// Solver state
// ----------------------------
const state = {
  entries: [],        // {x,y,text}
  locked: new Map(),  // veinKey -> {xy:"x,y", ore, qLabel}
  feasible: new Map() // veinKey -> {set:Set("x,y"), ore, qLabel}
};

function setIntersect(a, b){
  const out = new Set();
  for(const v of a) if(b.has(v)) out.add(v);
  return out;
}

function applyEntry(entry){
  const {x, y, text} = entry;
  const { directional, exact } = parseLog(text);

  for(const ex of exact){
    if(state.locked.has(ex.key)) continue;
    state.locked.set(ex.key, { xy:`${x},${y}`, ore: ex.ore, qLabel: ex.qLabel });
    state.feasible.delete(ex.key);
  }

  const grouped = new Map();
  for(const dl of directional){
    if(state.locked.has(dl.key)) continue;
    if(!grouped.has(dl.key)) grouped.set(dl.key, []);
    grouped.get(dl.key).push(dl);
  }

  for(const [key, lines] of grouped.entries()){
    let S = null;
    let ore = lines[0].ore, qLabel = lines[0].qLabel;

    for(const ln of lines){
      const C = candidatesForLine(x, y, ln.d, ln.dir);
      S = (S === null) ? C : setIntersect(S, C);
    }
    if(S === null) continue;

    if(state.feasible.has(key)){
      S = setIntersect(state.feasible.get(key).set, S);
    }

    if(S.size === 1){
      const only = [...S][0];
      state.locked.set(key, { xy: only, ore, qLabel });
      state.feasible.delete(key);
    } else {
      state.feasible.set(key, { set: S, ore, qLabel });
    }
  }
}

function rebuildAll(){
  state.locked.clear();
  state.feasible.clear();
  for(const e of state.entries){
    applyEntry(e);
  }
}

// ----------------------------
// Rendering
// ----------------------------
function parseXY(s){
  const [x,y] = s.split(",").map(v=>parseInt(v,10));
  return {x,y};
}

function getBounds(){
  const PAD = 6;
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;

  const include = (x, y) => {
    xmin = Math.min(xmin, x);
    xmax = Math.max(xmax, x);
    ymin = Math.min(ymin, y);
    ymax = Math.max(ymax, y);
  };

  if(state.entries.length === 0){
    return { xmin:-10, xmax:10, ymin:-10, ymax:10 };
  }

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

  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 1;

  const step = 6;
  for(let i = -cell; i < cell*2; i += step){
    ctx.beginPath();
    ctx.moveTo(x + i, y);
    ctx.lineTo(x + i + cell, y + cell);
    ctx.stroke();
  }
  ctx.restore();
}

function sourceMarker(ctx, x, y, cell, idx){
  // Only red X (no red box), plus a small index number (subscript-ish).
  ctx.strokeStyle = "rgba(255,0,0,0.95)";
  ctx.lineWidth = 3;

  ctx.beginPath();
  ctx.moveTo(x + 6, y + 6);
  ctx.lineTo(x + cell - 6, y + cell - 6);
  ctx.moveTo(x + cell - 6, y + 6);
  ctx.lineTo(x + 6, y + cell - 6);
  ctx.stroke();

  ctx.fillStyle = "rgba(255,0,0,0.95)";
  ctx.font = "12px system-ui";
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(String(idx), x + cell - 3, y + cell - 4);

  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}

function qColor(qLabel){
  // Approximate WurmNode colors (updated):
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

function drawLabel(ctx, x, y, ore, qLabel, color){
  // WurmNode-ish label box
  const padX = 10, padY = 8;
  const lineH = 16;

  ctx.font = "14px system-ui";
  const w1 = ctx.measureText(ore).width;
  const w2 = ctx.measureText(qLabel).width;
  const w = Math.max(w1, w2) + padX*2;
  const h = padY*2 + lineH*2;

  ctx.fillStyle = "rgba(0,0,0,0.65)";
  ctx.fillRect(x, y, w, h);

  ctx.fillStyle = "rgba(230,230,230,0.95)";
  ctx.fillText(ore, x + padX, y + padY + lineH - 3);

  ctx.fillStyle = color;
  ctx.fillText(qLabel, x + padX, y + padY + lineH*2 - 3);
}

function render(){
  const canvas = document.getElementById("mapCanvas");
  const ctx = canvas.getContext("2d");

  const {xmin,xmax,ymin,ymax} = getBounds();
  const gridW = (xmax-xmin+1);
  const gridH = (ymax-ymin+1);

  // Larger cells like WurmNode; adjust canvas to fit bounds (with max to avoid absurd sizes).
  const cell = 58; // big
  const margin = 26;
  const width = Math.min(2400, Math.max(900, gridW * cell + margin*2));
  const height = Math.min(1600, Math.max(650, gridH * cell + margin*2));

  if(canvas.width !== width) canvas.width = width;
  if(canvas.height !== height) canvas.height = height;

  ctx.fillStyle = "#0b0e14";
  ctx.fillRect(0,0,canvas.width, canvas.height);

  const ox = margin;
  const oy = margin;

  const px = (x)=> ox + (x - xmin) * cell;
  const py = (y)=> oy + (ymax - y) * cell;

  // Grid: thin lines + thicker major division every 4
  for(let x=xmin; x<=xmax; x++){
    const X = px(x);
    const major = ((x - xmin) % 4 === 0);
    ctx.strokeStyle = major ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.07)";
    ctx.lineWidth = major ? 2 : 1;
    ctx.beginPath(); ctx.moveTo(X, py(ymin)); ctx.lineTo(X, py(ymax)+cell); ctx.stroke();
  }
  for(let y=ymin; y<=ymax; y++){
    const Y = py(y);
    const major = ((ymax - y) % 4 === 0);
    ctx.strokeStyle = major ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.07)";
    ctx.lineWidth = major ? 2 : 1;
    ctx.beginPath(); ctx.moveTo(px(xmin), Y); ctx.lineTo(px(xmax)+cell, Y); ctx.stroke();
  }

  // unresolved candidates: hatched with overlap darkness + labels
  const intensity = new Map();
  const tileVeins = new Map(); // xy -> array of {ore,qLabel}
  const addIntensity = (xy, ore, qLabel)=>{
    intensity.set(xy, (intensity.get(xy)||0) + 1);
    if(!tileVeins.has(xy)) tileVeins.set(xy, []);
    tileVeins.get(xy).push({ore, qLabel});
  };

  for(const v of state.feasible.values()){
    for(const xy of v.set) addIntensity(xy, v.ore, v.qLabel);
  }

  let maxv = 1;
  for(const v of intensity.values()) maxv = Math.max(maxv, v);

  for(const [xy, v] of intensity.entries()){
    const {x,y} = parseXY(xy);
    const t = Math.max(0, Math.min(1, v/maxv));
    const g = Math.floor(230 * (1 - t));
    ctx.fillStyle = `rgb(${g},${g},${g})`;
    const X = px(x), Y = py(y);
    ctx.fillRect(X, Y, cell, cell);
    drawHatch(ctx, X, Y, cell);

    // label unresolved tile (first vein only to avoid clutter)
    const veins = tileVeins.get(xy);
    if(veins && veins.length){
      const vv = veins[0];
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(X+4, Y+4, cell-8, 30);

      ctx.font = "13px system-ui";
      ctx.fillStyle = "rgba(230,230,230,0.95)";
      ctx.fillText(vv.ore, X+8, Y+18);

      ctx.font = "13px system-ui";
      ctx.fillStyle = qColor(vv.qLabel);
      ctx.fillText(vv.qLabel, X+8, Y+34);
    }
  }
 red X + index
  for(let i=0; i<state.entries.length; i++){
    const e = state.entries[i];
    sourceMarker(ctx, px(e.x), py(e.y), cell, i+1);
  }

  // locked veins: magenta outline + label box
  ctx.font = "14px system-ui";
  for(const v of state.locked.values()){
    const {x,y} = parseXY(v.xy);
    ctx.strokeStyle = "rgba(255,0,255,1)";
    ctx.lineWidth = 4;
    ctx.strokeRect(px(x), py(y), cell, cell);

    const color = qColor(v.qLabel);
    drawLabel(ctx, px(x)+cell+10, py(y)+10, v.ore, v.qLabel, color);
  }
}

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

// ----------------------------
// UI Wiring
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

// initial draw
regenerate();

