// ============================
// Helpers: direction buckets (16) + ring candidates (distance 1..6)
// ============================

const CARD = { north:[0,1], south:[0,-1], east:[1,0], west:[-1,0] };

function norm2(x,y){ return Math.sqrt(x*x+y*y) || 1; }

function normalizeDirText(s){
  return s.trim().toLowerCase().replace(/-/g," ").replace(/\s+/g," ");
}

function dirSector(dx, dy){
  if(dx===0 && dy===0) return "CENTER";
  const ax = Math.abs(dx), ay = Math.abs(dy);

  // Cardinal
  if(dx===0) return dy>0 ? "N" : "S";
  if(dy===0) return dx>0 ? "E" : "W";

  // Diagonal
  if(ax===ay){
    if(dx>0 && dy>0) return "NE";
    if(dx>0 && dy<0) return "SE";
    if(dx<0 && dy<0) return "SW";
    if(dx<0 && dy>0) return "NW";
  }

  // 8 "of" buckets
  if(ay > ax){
    // mostly vertical => E/W of N/S
    if(dy>0) return dx>0 ? "E of N" : "W of N";
    return dx>0 ? "E of S" : "W of S";
  } else {
    // mostly horizontal => N/S of E/W
    if(dx>0) return dy>0 ? "N of E" : "S of E";
    return dy>0 ? "N of W" : "S of W";
  }
}

function ringCandidates(px, py, d){
  // Chebyshev ring at distance d (square ring)
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

// ============================
// Analyse text parsing
// ============================

// Strength → distance (1..6)
function strengthToDistance(line){
  const s = line.toLowerCase();
  // Wurmpedia: trace(1), slight(2), faint(3), minuscule(4), vague(5), indistinct(6)
  if(/\b(indistinct)\b/.test(s)) return 6;
  if(/\b(vague)\b/.test(s)) return 5;
  if(/\b(minuscule)\b/.test(s)) return 4;
  if(/\b(faint)\b/.test(s)) return 3;
  if(/\b(slight)\b/.test(s)) return 2;
  if(/\b(trace|traces)\b/.test(s)) return 1;
  return null;
}

// Quality bins (fallback if you don’t have numeric quality in text)
function qualityBinFromLine(line){
  const s = line.toLowerCase();
  // If numeric quality appears anywhere (e.g. 97.12), bin it:
  const m = s.match(/\b(\d{1,3}(?:\.\d+)?)\b/);
  if(m){
    const q = parseFloat(m[1]);
    if(q >= 95) return "95-99";
    if(q >= 80) return "80-94";
    if(q >= 60) return "60-79";
    if(q >= 40) return "40-59";
    if(q >= 20) return "20-39";
    return "1-19";
  }
  // Adjective fallback
  if(/\butmost\b/.test(s)) return "95-99";
  if(/\bvery good\b/.test(s)) return "80-94";
  if(/\bgood\b/.test(s)) return "60-79";
  if(/\bnormal\b/.test(s)) return "40-59";
  if(/\bpoor\b/.test(s)) return "20-39";
  return "unknown";
}

// Parse ore + direction from typical line: "You find faint traces of iron (north of east)."
function parseDirectionalLine(line){
  const s = line.trim();
  const m = s.match(/traces?\s+of\s+([a-z ]+?)\s*\(([^)]+)\)/i);
  if(!m) return null;
  const ore = m[1].trim().toLowerCase().replace(/\s+/g," ");
  const dir = m[2].trim();
  const d = strengthToDistance(line);
  if(!d) return null;
  const qbin = qualityBinFromLine(line); // used for vein key
  return { ore, qbin, d, dir };
}

// Exact tile line: "You would mine iron here."
function parseExactLine(line){
  const m = line.match(/you would mine\s+([a-z ]+?)\s+here/i);
  if(!m) return null;
  const ore = m[1].trim().toLowerCase().replace(/\s+/g," ");
  if(ore.includes("stone shards")) return null; // ignore common filler
  const qbin = qualityBinFromLine(line);
  return { ore, qbin };
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

// ============================
// Solver state
// ============================

const state = {
  entries: [], // {x,y,text}
  locked: new Map(), // veinKey -> "x,y"
  feasible: new Map(), // veinKey -> Set("x,y")
};

function veinKey(ore, qbin){
  // Matches your screenshots: "Iron 95-99"
  return `${ore} ${qbin}`;
}

function setIntersect(a, b){
  const out = new Set();
  for(const v of a) if(b.has(v)) out.add(v);
  return out;
}

// Apply a single entry (step position + pasted log)
function applyEntry(entry){
  const {x, y, text} = entry;
  const { directional, exact } = parseLog(text);

  // exact locks
  for(const ex of exact){
    const key = veinKey(ex.ore, ex.qbin);
    if(state.locked.has(key)) continue;
    state.locked.set(key, `${x},${y}`);
    state.feasible.delete(key); // locked overrides feasible
  }

  // group directional lines per veinKey within this entry
  const grouped = new Map();
  for(const dl of directional){
    const key = veinKey(dl.ore, dl.qbin);
    if(state.locked.has(key)) continue;
    if(!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(dl);
  }

  // For each vein, create entry-local feasible set via intersection of its lines
  for(const [key, lines] of grouped.entries()){
    let S = null;
    for(const ln of lines){
      const C = candidatesForLine(x, y, ln.d, ln.dir);
      S = (S === null) ? C : setIntersect(S, C);
    }
    if(S === null) continue;

    // intersect with global feasible if already present
    if(state.feasible.has(key)){
      S = setIntersect(state.feasible.get(key), S);
    }

    // lock if unique
    if(S.size === 1){
      const only = [...S][0];
      state.locked.set(key, only);
      state.feasible.delete(key);
    } else {
      state.feasible.set(key, S);
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

// ============================
// Rendering
// ============================

function parseXY(s){
  const [x,y] = s.split(",").map(v=>parseInt(v,10));
  return {x,y};
}

function getBounds(){
  let xs = [], ys = [];
  for(const xy of state.locked.values()){
    const {x,y} = parseXY(xy);
    xs.push(x); ys.push(y);
  }
  for(const set of state.feasible.values()){
    for(const xy of set){
      const {x,y} = parseXY(xy);
      xs.push(x); ys.push(y);
    }
  }
  for(const e of state.entries){
    xs.push(e.x); ys.push(e.y);
  }
  if(xs.length===0) return {xmin:-10,xmax:10,ymin:-10,ymax:10};
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymin = Math.min(...ys), ymax = Math.max(...ys);
  return { xmin:xmin-4, xmax:xmax+4, ymin:ymin-4, ymax:ymax+4 };
}

function render(layerKey="ALL"){
  const canvas = document.getElementById("mapCanvas");
  const ctx = canvas.getContext("2d");

  // clear
  ctx.fillStyle = "#0b0e14";
  ctx.fillRect(0,0,canvas.width, canvas.height);

  const {xmin,xmax,ymin,ymax} = getBounds();

  // cell sizing to fit
  const gridW = (xmax-xmin+1);
  const gridH = (ymax-ymin+1);
  const cell = Math.max(10, Math.min(24, Math.floor(Math.min(
    (canvas.width-60)/gridW,
    (canvas.height-60)/gridH
  ))));
  const ox = 30;
  const oy = 30;

  function px(x){ return ox + (x - xmin) * cell; }
  function py(y){ return oy + (ymax - y) * cell; } // invert y

  // faint grid
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  for(let x=xmin; x<=xmax; x++){
    const X = px(x);
    ctx.beginPath(); ctx.moveTo(X, py(ymin)); ctx.lineTo(X, py(ymax)+cell); ctx.stroke();
  }
  for(let y=ymin; y<=ymax; y++){
    const Y = py(y);
    ctx.beginPath(); ctx.moveTo(px(xmin), Y); ctx.lineTo(px(xmax)+cell, Y); ctx.stroke();
  }

  // build intensity map for current layer
  const intensity = new Map(); // "x,y" -> count
  function addIntensity(xy, w){
    intensity.set(xy, (intensity.get(xy)||0) + w);
  }

  if(layerKey === "ALL"){
    // feasible tiles add +1 each time they appear in a feasible set
    for(const set of state.feasible.values()){
      for(const xy of set) addIntensity(xy, 1);
    }
    // locked tiles add big weight
    for(const xy of state.locked.values()) addIntensity(xy, 20);
  } else {
    if(state.locked.has(layerKey)){
      addIntensity(state.locked.get(layerKey), 50);
    } else if(state.feasible.has(layerKey)){
      for(const xy of state.feasible.get(layerKey)) addIntensity(xy, 2);
    }
  }

  // normalize
  let maxv = 1;
  for(const v of intensity.values()) maxv = Math.max(maxv, v);

  // draw heat cells (grayscale)
  for(const [xy, v] of intensity.entries()){
    const {x,y} = parseXY(xy);
    const t = Math.max(0, Math.min(1, v/maxv));
    const g = Math.floor(255 * (1 - t));
    ctx.fillStyle = `rgb(${g},${g},${g})`;
    ctx.fillRect(px(x), py(y), cell, cell);
  }

  // draw entry "sources"
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = "12px system-ui";
  for(const e of state.entries){
    ctx.strokeStyle = "rgba(255,0,0,0.9)";
    ctx.lineWidth = 2;
    ctx.strokeRect(px(e.x), py(e.y), cell, cell);
    ctx.fillText("Source", px(e.x)+2, py(e.y)-4);
  }

  // draw locked labels
  ctx.font = "12px system-ui";
  for(const [key, xy] of state.locked.entries()){
    const {x,y} = parseXY(xy);
    ctx.strokeStyle = "rgba(255,0,255,1)";
    ctx.lineWidth = 3;
    ctx.strokeRect(px(x), py(y), cell, cell);

    ctx.fillStyle = "rgba(0,0,0,0.65)";
    const label = key;
    const w = ctx.measureText(label).width + 10;
    const X = px(x)+cell+6, Y = py(y)+cell/2;
    ctx.fillRect(X, Y-14, w, 20);
    ctx.fillStyle = "rgba(255,0,255,1)";
    ctx.fillText(label, X+5, Y);
  }

  // title
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.font = "14px system-ui";
  ctx.fillText(`Layer: ${layerKey}`, 12, 18);
}

function refreshLayerSelect(){
  const sel = document.getElementById("layerSelect");
  const current = sel.value || "ALL";
  const keys = new Set(["ALL"]);
  for(const k of state.locked.keys()) keys.add(k);
  for(const k of state.feasible.keys()) keys.add(k);

  // rebuild options
  sel.innerHTML = "";
  [...keys].sort().forEach(k=>{
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = k;
    sel.appendChild(opt);
  });
  sel.value = keys.has(current) ? current : "ALL";
}

function updateStats(){
  const stats = document.getElementById("stats");
  stats.innerHTML =
    `Entries: ${state.entries.length}<br>` +
    `Locked veins: ${state.locked.size}<br>` +
    `Unresolved veins: ${state.feasible.size}<br>` +
    `Tip: If a vein resolves to exactly one tile, it locks and won't move.`;
}

// ============================
// UI wiring
// ============================

function regenerate(){
  rebuildAll();
  refreshLayerSelect();
  updateStats();
  const layer = document.getElementById("layerSelect").value || "ALL";
  render(layer);
}

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

document.getElementById("layerSelect").addEventListener("change", ()=>{
  render(document.getElementById("layerSelect").value || "ALL");
});

document.getElementById("viewBtn").addEventListener("click", ()=>{
  // just re-render (acts as “view map”)
  render(document.getElementById("layerSelect").value || "ALL");
});

document.getElementById("downloadBtn").addEventListener("click", ()=>{
  const canvas = document.getElementById("mapCanvas");
  const a = document.createElement("a");
  a.download = "wurm-vein-map.png";
  a.href = canvas.toDataURL("image/png");
  a.click();
});

// initial draw
regenerate();
