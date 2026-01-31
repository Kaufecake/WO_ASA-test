/* Wurm Online – Advanced Shard Analyzer
   Full replacement app.js

   Adds:
   - "analyse the ore" sessions
   - "trace of something" => Unknown
   - If mineHint provides a specific QL (max quality), display that number instead of a band range
*/

const $ = (id) => document.getElementById(id);

const canvas = $("map");
const ctx = canvas.getContext("2d");

const entriesEl = $("entries");
const tpl = $("entryTpl");

const btnAdd = $("btnAdd");
const btnUndo = $("btnUndo");
const btnRedo = $("btnRedo");
const btnReset = $("btnReset");
const btnExport = $("btnExport");

const gridSizeEl = $("gridSize");
const tileSizeEl = $("tileSize");
const maxDistEl = $("maxDist");
const bgModeEl = $("bgMode");
const centerModeEl = $("centerMode");

// ---------- Quality bins / colors ----------
const QL_BINS = [
  { key: "20-29", lo: 20, hi: 29, color: "#b9b9b9" },
  { key: "30-39", lo: 30, hi: 39, color: "#ffffff" },
  { key: "40-59", lo: 40, hi: 59, color: "#39ff4a" },
  { key: "60-79", lo: 60, hi: 79, color: "#23a3ff" },
  { key: "80-94", lo: 80, hi: 94, color: "#b44cff" },
  { key: "95-99", lo: 95, hi: 99, color: "#ff9f1a" },
];

const UNKNOWN_COLOR = "#d0d4dc";

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function binForQL(q){
  for (const b of QL_BINS) if (q >= b.lo && q <= b.hi) return b;
  if (q < 20) return QL_BINS[0];
  return QL_BINS[QL_BINS.length - 1];
}

function binForAdjective(adj){
  const a = (adj || "").toLowerCase();
  if (a.includes("utmost")) return QL_BINS.find(b => b.key === "95-99");
  if (a.includes("very good")) return QL_BINS.find(b => b.key === "80-94");
  if (a.includes("good")) return QL_BINS.find(b => b.key === "60-79");
  if (a.includes("normal")) return QL_BINS.find(b => b.key === "40-59");
  if (a.includes("decent")) return QL_BINS.find(b => b.key === "30-39");
  if (a.includes("poor")) return QL_BINS.find(b => b.key === "20-29");
  return null;
}

// ---------- Directions parsing ----------
function normalizeDir(s){
  return (s || "")
    .toLowerCase()
    .replace(/[\.\)]/g, "")
    .replace(/\(/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function dirToVectors(dirStr){
  const d = normalizeDir(dirStr);

  const simple = new Set([
    "north","south","east","west",
    "northeast","northwest","southeast","southwest"
  ]);

  if (simple.has(d)){
    return (dx,dy) => matchSimpleDir(d, dx, dy);
  }

  const m = d.match(/^(north|south|east|west) of (north|south|east|west)$/);
  if (m){
    const a = m[1], b = m[2];

    if ((a === "north" && b === "east") || (a === "east" && b === "north")){
      return (dx,dy) => dx > 0 && dy > 0 && (a === "north" ? dx >= dy : dy >= dx);
    }
    if ((a === "north" && b === "west") || (a === "west" && b === "north")){
      return (dx,dy) => dx < 0 && dy > 0 && (a === "north" ? -dx >= dy : dy >= -dx);
    }
    if ((a === "south" && b === "east") || (a === "east" && b === "south")){
      return (dx,dy) => dx > 0 && dy < 0 && (a === "south" ? dx >= -dy : -dy >= dx);
    }
    if ((a === "south" && b === "west") || (a === "west" && b === "south")){
      return (dx,dy) => dx < 0 && dy < 0 && (a === "south" ? -dx >= -dy : -dy >= -dx);
    }

    return (_dx,_dy) => true;
  }

  if (d.includes("north") && d.includes("east")) return (dx,dy)=>dx>0 && dy>0;
  if (d.includes("north") && d.includes("west")) return (dx,dy)=>dx<0 && dy>0;
  if (d.includes("south") && d.includes("east")) return (dx,dy)=>dx>0 && dy<0;
  if (d.includes("south") && d.includes("west")) return (dx,dy)=>dx<0 && dy<0;
  if (d.includes("north")) return (dx,dy)=>dy>0 && dx===0;
  if (d.includes("south")) return (dx,dy)=>dy<0 && dx===0;
  if (d.includes("east")) return (dx,dy)=>dx>0 && dy===0;
  if (d.includes("west")) return (dx,dy)=>dx<0 && dy===0;

  return (_dx,_dy) => true;
}

function matchSimpleDir(d, dx, dy){
  if (dx === 0 && dy === 0) return false;
  switch(d){
    case "north": return dy > 0 && dx === 0;
    case "south": return dy < 0 && dx === 0;
    case "east":  return dx > 0 && dy === 0;
    case "west":  return dx < 0 && dy === 0;
    case "northeast": return dx > 0 && dy > 0;
    case "northwest": return dx < 0 && dy > 0;
    case "southeast": return dx > 0 && dy < 0;
    case "southwest": return dx < 0 && dy < 0;
    default: return false;
  }
}

// ---------- Distance band mapping for trace adjectives ----------
function distRangeForTraceWord(word){
  const w = (word||"").toLowerCase();
  if (w.includes("minuscule")) return [1, 3];
  if (w.includes("slight"))    return [2, 5];
  if (w.includes("vague"))     return [4, 8];
  if (w.includes("indistinct"))return [6, 12];
  return [3, 8];
}

function manhattan(dx,dy){ return Math.abs(dx) + Math.abs(dy); }

function candidateOffsetsForClue(directionPhrase, traceWord, maxDist){
  const [dLo, dHi0] = distRangeForTraceWord(traceWord);
  const dHi = Math.min(dHi0, maxDist);

  const dirPred = dirToVectors(directionPhrase);
  const out = [];

  for (let dx = -dHi; dx <= dHi; dx++){
    for (let dy = -dHi; dy <= dHi; dy++){
      if (dx === 0 && dy === 0) continue;
      const dist = manhattan(dx,dy);
      if (dist < dLo || dist > dHi) continue;
      if (!dirPred(dx,dy)) continue;
      out.push([dx,dy]);
    }
  }
  return out;
}

// ---------- Parsing ----------
function stripTimestamp(line){
  return line.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, "").trim();
}

function normalizeOreName(name){
  return (name||"").toLowerCase().trim();
}

function titleCase(s){
  return s.split(" ").filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
}

function parseLogToSession(logText){
  // Start triggers:
  // - You start to analyse/analyze the shard.
  // - You start to analyse/analyze the ore.
  // - You start to gather fragments of the rock.
  const lines = (logText || "")
    .split(/\r?\n/)
    .map(l => stripTimestamp(l))
    .filter(l => l.length > 0);

  let started = false;
  let sessionStartIndex = -1;

  for (let i=0;i<lines.length;i++){
    const l = lines[i].toLowerCase();
    if (
      l.includes("you start to analyse the shard") ||
      l.includes("you start to analyze the shard") ||
      l.includes("you start to analyse the ore") ||
      l.includes("you start to analyze the ore") ||
      l.includes("you start to gather fragments of the rock")
    ){
      started = true;
      sessionStartIndex = i;
      break;
    }
  }

  if (!started){
    return { mineHint: null, traces: [] };
  }

  // Look backwards for mining info (only if "You would mine <vein> here." and a band or max QL)
  let mineHint = null;
  const pre = lines.slice(0, sessionStartIndex + 1);

  let wouldMine = null;
  let maxQl = null;

  for (let i=Math.max(0, pre.length - 30); i<pre.length; i++){
    const l = pre[i];

    const m1 = l.match(/^you would mine (.+?) here\.$/i);
    if (m1){
      wouldMine = m1[1].trim();
    }

    const m2 = l.match(/^it has a max quality of (\d+)\.$/i);
    if (m2){
      maxQl = parseInt(m2[1], 10);
    }
  }

  if (wouldMine){
    const low = wouldMine.toLowerCase();
    const looksLikeShards = low.includes("shards");
    if (!looksLikeShards){
      const band = binForAdjective(low);
      const ore = low
        .replace(/(poor|decent|normal|good|very good|utmost)\s+quality\s+/g, "")
        .trim();

      if (band){
        mineHint = { oreName: normalizeOreName(ore), bandKey: band.key, specificQl: null };
      } else if (Number.isFinite(maxQl)){
        const b = binForQL(maxQl);
        mineHint = { oreName: normalizeOreName(ore), bandKey: b.key, specificQl: maxQl };
      }
    }
  }

  // Parse trace lines AFTER session start
  const traces = [];

  for (let i=sessionStartIndex; i<lines.length; i++){
    const l = lines[i];

    // 1) Unknown trace line:
    // "You spot an indistinct trace of something, but cannot quite make it out (east of north)."
    // Sometimes could be "You spot a slight trace of something..." etc.
    const unknown = l.match(/^you (spot|see|notice).+?\b(minuscule|slight|vague|indistinct)\b.+?\btrace\b of something.*\((.+?)\)\.?$/i);
    if (unknown){
      const traceWord = unknown[2].toLowerCase();
      const direction = (unknown[3] || "").trim();
      traces.push({
        oreName: "unknown",
        bandKey: null,      // no quality info
        traceWord,
        direction,
        specificQl: null
      });
      continue;
    }

    // 2) Normal ore trace with quality:
    // "You notice a vague trace of normal quality iron (east of north)."
    const m = l.match(/^you (spot|see|notice).+?\b(trace)\b of (.+?) \((.+?)\)\.?$/i);
    if (!m) continue;

    const tw = (l.match(/\b(minuscule|slight|vague|indistinct)\b/i) || [null, "vague"])[1];
    const oreDesc = (m[3] || "").trim();     // "utmost quality iron"
    const direction = (m[4] || "").trim();

    const band = binForAdjective(oreDesc);
    if (!band) continue;

    const ore = oreDesc
      .toLowerCase()
      .replace(/(poor|decent|normal|good|very good|utmost)\s+quality\s+/g, "")
      .trim();

    traces.push({
      oreName: normalizeOreName(ore),
      bandKey: band.key,
      traceWord: tw,
      direction,
      specificQl: null
    });
  }

  return { mineHint, traces };
}

// ---------- Connected components ----------
function keyOf(x,y){ return `${x},${y}`; }
function parseKey(k){
  const [a,b] = k.split(",").map(n => parseInt(n,10));
  return [a,b];
}

function componentsFromSet(setKeys){
  const unvisited = new Set(setKeys);
  const comps = [];
  const dirs = [[1,0],[-1,0],[0,1],[0,-1]];

  while (unvisited.size){
    const first = unvisited.values().next().value;
    unvisited.delete(first);

    const comp = [first];
    const q = [first];

    while (q.length){
      const cur = q.pop();
      const [x,y] = parseKey(cur);

      for (const [dx,dy] of dirs){
        const nk = keyOf(x+dx, y+dy);
        if (unvisited.has(nk)){
          unvisited.delete(nk);
          comp.push(nk);
          q.push(nk);
        }
      }
    }

    comps.push(comp);
  }

  return comps;
}

function centroidOfKeys(keys){
  let sx=0, sy=0;
  for (const k of keys){
    const [x,y] = parseKey(k);
    sx += x; sy += y;
  }
  return [sx/keys.length, sy/keys.length];
}

// ---------- Solver ----------
function intersectSets(a, b){
  const out = new Set();
  const [sm, lg] = a.size < b.size ? [a,b] : [b,a];
  for (const v of sm) if (lg.has(v)) out.add(v);
  return out;
}

function solve(entries, maxDist){
  const playerPos = [];
  let gx = 0, gy = 0;
  for (let i=0;i<entries.length;i++){
    if (i === 0){
      gx = 0; gy = 0;
    } else {
      gx += entries[i].dx;
      gy += entries[i].dy;
    }
    playerPos.push({x: gx, y: gy});
  }

  // Track known exact QLs per ore-band group (from mineHint)
  // key => exactQl
  const exactQlByKey = new Map();

  const perEntryCandidates = [];
  const perEntryVeinCount = [];

  for (let i=0;i<entries.length;i++){
    const sess = parseLogToSession(entries[i].logText);
    const px = playerPos[i].x;
    const py = playerPos[i].y;

    const group = new Map();

    function groupKey(oreName, bandKey){
      // For unknown bandKey use placeholder
      const bk = bandKey ?? "UNKNOWN_BAND";
      return `${oreName}__${bk}`;
    }

    // Mine hint => resolved at player position
    if (sess.mineHint){
      const k = groupKey(sess.mineHint.oreName, sess.mineHint.bandKey);
      group.set(k, new Set([keyOf(px, py)]));

      if (Number.isFinite(sess.mineHint.specificQl)){
        exactQlByKey.set(k, sess.mineHint.specificQl);
      }
    }

    // Traces
    for (const t of sess.traces){
      const k = groupKey(t.oreName, t.bandKey);

      const offsets = candidateOffsetsForClue(t.direction, t.traceWord, maxDist);
      const cand = new Set();
      for (const [dx,dy] of offsets){
        cand.add(keyOf(px+dx, py+dy));
      }

      if (!group.has(k)){
        group.set(k, cand);
      } else {
        group.set(k, intersectSets(group.get(k), cand));
      }
    }

    perEntryCandidates.push(group);
    perEntryVeinCount.push(group.size);
  }

  // Merge across entries by key: intersection
  const merged = new Map();
  const presentKeys = new Set();
  for (const g of perEntryCandidates){
    for (const k of g.keys()) presentKeys.add(k);
  }

  for (const k of presentKeys){
    let cur = null;
    for (const g of perEntryCandidates){
      if (!g.has(k)) continue;
      if (cur === null) cur = new Set(g.get(k));
      else cur = intersectSets(cur, g.get(k));
    }
    if (cur === null) cur = new Set();
    merged.set(k, cur);
  }

  // Build vein objects
  const veins = [];
  for (const [k, setKeys] of merged.entries()){
    const [oreName, bandKeyRaw] = k.split("__");

    const bandKey = (bandKeyRaw === "UNKNOWN_BAND") ? null : bandKeyRaw;

    // Attach exact QL if we have it
    const exactQl = exactQlByKey.has(k) ? exactQlByKey.get(k) : null;

    veins.push({
      oreName,
      bandKey,      // null for Unknown
      exactQl,      // number or null
      keys: setKeys,
    });
  }

  return {
    playerPos,
    perEntryVeinCount,
    veins,
  };
}

// ---------- Rendering ----------
function resizeCanvasToDisplaySize(){
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(600, Math.floor(rect.width * dpr));
  const h = Math.max(450, Math.floor(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h){
    canvas.width = w;
    canvas.height = h;
  }
}

function drawBackground(mode){
  if (mode === "light"){
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0,0,canvas.width,canvas.height);
  } else {
    const g = ctx.createRadialGradient(
      canvas.width*0.3, canvas.height*0.05, canvas.width*0.1,
      canvas.width*0.5, canvas.height*0.6, canvas.width*0.9
    );
    g.addColorStop(0, "#101621");
    g.addColorStop(1, "#070a10");
    ctx.fillStyle = g;
    ctx.fillRect(0,0,canvas.width,canvas.height);
  }
}

function drawUniformGrid(tilePx, gridSize){
  const w = canvas.width, h = canvas.height;

  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = bgModeEl.value === "light" ? "rgba(0,0,0,0.12)" : "rgba(255,255,255,0.10)";

  const mapPx = gridSize * tilePx;
  const ox = Math.floor((w - mapPx) / 2);
  const oy = Math.floor((h - mapPx) / 2);

  ctx.strokeRect(ox, oy, mapPx, mapPx);

  for (let i=1;i<gridSize;i++){
    const x = ox + i*tilePx;
    const y = oy + i*tilePx;
    ctx.beginPath(); ctx.moveTo(x, oy); ctx.lineTo(x, oy+mapPx); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ox, y); ctx.lineTo(ox+mapPx, y); ctx.stroke();
  }

  ctx.restore();

  return { ox, oy, mapPx };
}

function worldToCanvas(x,y, originWorld, tilePx, gridSize, ox, oy){
  const half = Math.floor(gridSize / 2);
  const gx = x - (originWorld.x - half);
  const gy = (originWorld.y + half) - y;
  const cx = ox + gx * tilePx;
  const cy = oy + gy * tilePx;
  return { cx, cy };
}

function hatchCell(cx, cy, tilePx){
  ctx.save();
  ctx.beginPath();
  ctx.rect(cx, cy, tilePx, tilePx);
  ctx.clip();

  ctx.lineWidth = 2;
  ctx.strokeStyle = bgModeEl.value === "light" ? "rgba(0,0,0,0.12)" : "rgba(255,255,255,0.12)";

  const step = 10;
  for (let i=-tilePx; i<tilePx*2; i+=step){
    ctx.beginPath();
    ctx.moveTo(cx + i, cy + tilePx);
    ctx.lineTo(cx + i + tilePx, cy);
    ctx.stroke();
  }
  ctx.restore();
}

function drawSourceMarker(cx, cy, tilePx, idx){
  const midX = cx + tilePx/2;
  const midY = cy + tilePx/2;
  const r = tilePx * 0.22;

  ctx.save();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#ff2a2a";
  ctx.beginPath();
  ctx.moveTo(midX - r, midY - r);
  ctx.lineTo(midX + r, midY + r);
  ctx.moveTo(midX - r, midY + r);
  ctx.lineTo(midX + r, midY - r);
  ctx.stroke();

  ctx.fillStyle = "#ff2a2a";
  ctx.font = `${Math.max(12, tilePx*0.18)}px ui-sans-serif, system-ui`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(String(idx), midX + r*0.9, midY + r*0.2);
  ctx.restore();
}

function drawLabelAt(cx, cy, tilePx, oreName, bandKey, exactQl){
  const isUnknown = (oreName === "unknown");

  let band = null;
  if (!isUnknown && bandKey){
    band = QL_BINS.find(b => b.key === bandKey) || null;
  }

  const nameLine = isUnknown ? "Unknown" : titleCase(oreName);

  // What to show on line 2:
  // - If exactQl is known => show the number (e.g., 96)
  // - Else if band exists => show band key (e.g., 95-99)
  // - Else (Unknown) => no second line
  const secondLine = Number.isFinite(exactQl) ? String(exactQl) : (band ? band.key : "");
  const secondColor = isUnknown ? UNKNOWN_COLOR : (band ? band.color : UNKNOWN_COLOR);

  ctx.save();

  // Plate behind text (NOT hatched behind the name)
  const padX = tilePx * 0.10;
  const padY = tilePx * 0.10;
  const boxW = tilePx - padX*2;
  const boxH = tilePx - padY*2;

  if (bgModeEl.value === "light"){
    ctx.fillStyle = "rgba(255,255,255,0.82)";
    ctx.strokeStyle = "rgba(0,0,0,0.12)";
  } else {
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
  }

  roundRect(ctx, cx + padX, cy + padY, boxW, boxH, 10);
  ctx.fill();
  ctx.stroke();

  const font1 = Math.max(12, tilePx*0.18);
  const font2 = Math.max(12, tilePx*0.22);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.fillStyle = bgModeEl.value === "light" ? "#111" : "#e7ecf4";
  ctx.font = `700 ${font1}px ui-sans-serif, system-ui`;

  // If Unknown, center it a little higher (no second line)
  const y1 = secondLine ? (cy + tilePx*0.44) : (cy + tilePx*0.52);
  ctx.fillText(nameLine, cx + tilePx/2, y1);

  if (secondLine){
    ctx.fillStyle = secondColor;
    ctx.font = `900 ${font2}px ui-sans-serif, system-ui`;
    ctx.fillText(secondLine, cx + tilePx/2, cy + tilePx*0.66);
  }

  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r){
  const rr = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x+rr,y);
  ctx.arcTo(x+w,y, x+w,y+h, rr);
  ctx.arcTo(x+w,y+h, x,y+h, rr);
  ctx.arcTo(x,y+h, x,y, rr);
  ctx.arcTo(x,y, x+w,y, rr);
  ctx.closePath();
}

function render(state){
  resizeCanvasToDisplaySize();

  const gridSize = clamp(parseInt(gridSizeEl.value,10)||60, 10, 300);
  const tilePx = clamp(parseInt(tileSizeEl.value,10)||64, 24, 140);

  drawBackground(bgModeEl.value);

  const { ox, oy } = drawUniformGrid(tilePx, gridSize);

  let originWorld = {x:0,y:0};
  if (centerModeEl.value === "bounds" && state){
    const pts = [];
    if (state.playerPos){
      for (const p of state.playerPos) pts.push([p.x,p.y]);
    }
    if (state.veins){
      for (const v of state.veins){
        for (const k of v.keys){
          const [x,y] = parseKey(k);
          pts.push([x,y]);
        }
      }
    }
    if (pts.length){
      let minX=pts[0][0], maxX=pts[0][0], minY=pts[0][1], maxY=pts[0][1];
      for (const [x,y] of pts){
        minX=Math.min(minX,x); maxX=Math.max(maxX,x);
        minY=Math.min(minY,y); maxY=Math.max(maxY,y);
      }
      originWorld = { x: (minX+maxX)/2, y: (minY+maxY)/2 };
    }
  }

  // Sources
  if (state && state.playerPos){
    for (let i=0;i<state.playerPos.length;i++){
      const p = state.playerPos[i];
      const { cx, cy } = worldToCanvas(p.x, p.y, originWorld, tilePx, gridSize, ox, oy);
      if (cx < ox || cy < oy || cx > ox + gridSize*tilePx || cy > oy + gridSize*tilePx) continue;
      drawSourceMarker(cx, cy, tilePx, i+1);
    }
  }

  // Veins
  if (state && state.veins){
    for (const v of state.veins){
      if (!v.keys || v.keys.size === 0) continue;

      const comps = componentsFromSet(v.keys);

      for (const comp of comps){
        if (comp.length === 1){
          // resolved -> no hatch
          const [wx, wy] = parseKey(comp[0]);
          const { cx, cy } = worldToCanvas(wx, wy, originWorld, tilePx, gridSize, ox, oy);
          if (cx < ox || cy < oy || cx > ox + gridSize*tilePx || cy > oy + gridSize*tilePx) continue;
          drawLabelAt(cx, cy, tilePx, v.oreName, v.bandKey, v.exactQl);
        } else {
          // ambiguous -> hatch cells, label center
          for (const k of comp){
            const [wx, wy] = parseKey(k);
            const { cx, cy } = worldToCanvas(wx, wy, originWorld, tilePx, gridSize, ox, oy);
            if (cx < ox || cy < oy || cx > ox + gridSize*tilePx || cy > oy + gridSize*tilePx) continue;
            hatchCell(cx, cy, tilePx);
          }

          const [mx,my] = centroidOfKeys(comp);
          const snapX = Math.round(mx);
          const snapY = Math.round(my);
          const { cx, cy } = worldToCanvas(snapX, snapY, originWorld, tilePx, gridSize, ox, oy);
          if (cx < ox || cy < oy || cx > ox + gridSize*tilePx || cy > oy + gridSize*tilePx) continue;
          drawLabelAt(cx, cy, tilePx, v.oreName, v.bandKey, v.exactQl);
        }
      }
    }
  }
}

// ---------- State / history ----------
let model = {
  entries: [
    { dx: 0, dy: 0, logText: "" }
  ],
};

let history = [];
let historyIndex = -1;

function pushHistory(){
  const snapshot = JSON.parse(JSON.stringify(model));
  history = history.slice(0, historyIndex + 1);
  history.push(snapshot);
  historyIndex++;
  updateUndoRedo();
}

function restoreHistory(idx){
  if (idx < 0 || idx >= history.length) return;
  model = JSON.parse(JSON.stringify(history[idx]));
  historyIndex = idx;
  updateUndoRedo();
  rebuildEntriesUI();
  recomputeAndRender();
}

function updateUndoRedo(){
  btnUndo.disabled = historyIndex <= 0;
  btnRedo.disabled = historyIndex >= history.length - 1;
}

// ---------- UI ----------
function rebuildEntriesUI(){
  entriesEl.innerHTML = "";

  model.entries.forEach((e, i) => {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.querySelector(".entryIndex").textContent = String(i+1);

    const east = node.querySelector(".stepEast");
    const north = node.querySelector(".stepNorth");
    const log = node.querySelector(".log");
    const removeBtn = node.querySelector(".btnRemove");

    east.value = e.dx;
    north.value = e.dy;
    log.value = e.logText;

    function onChange(){
      const dx = parseInt(east.value,10);
      const dy = parseInt(north.value,10);
      model.entries[i].dx = Number.isFinite(dx) ? dx : 0;
      model.entries[i].dy = Number.isFinite(dy) ? dy : 0;
      model.entries[i].logText = log.value || "";
      pushHistory();
      recomputeAndRender();
    }

    east.addEventListener("input", onChange);
    north.addEventListener("input", onChange);
    log.addEventListener("input", onChange);

    removeBtn.addEventListener("click", () => {
      model.entries.splice(i,1);
      if (model.entries.length === 0) model.entries.push({dx:0,dy:0,logText:""});
      pushHistory();
      rebuildEntriesUI();
      recomputeAndRender();
    });

    entriesEl.appendChild(node);
  });
}

async function expandPastebinIfNeeded(text){
  const t = (text||"").trim();
  if (!t) return "";
  if (!/^https?:\/\//i.test(t)) return t;

  let url = t;
  if (/pastebin\.com\/(?!raw\/)/i.test(url)){
    const id = url.split("/").pop().split("?")[0];
    url = `https://pastebin.com/raw/${id}`;
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch: ${url}`);
  return await res.text();
}

let lastComputed = null;

async function recomputeAndRender(){
  const maxDist = clamp(parseInt(maxDistEl.value,10) || 12, 3, 80);

  const solverEntries = [];
  for (const e of model.entries){
    let logText = e.logText || "";
    try{
      logText = await expandPastebinIfNeeded(logText);
    }catch(_err){
      // keep original
    }
    solverEntries.push({ dx: e.dx, dy: e.dy, logText });
  }

  const state = solve(solverEntries, maxDist);
  lastComputed = state;

  const entryNodes = Array.from(entriesEl.querySelectorAll(".entry"));
  for (let i=0;i<entryNodes.length;i++){
    const node = entryNodes[i];
    const tilePos = node.querySelector(".tilePos");
    const veinCount = node.querySelector(".veinCount");

    const p = state.playerPos[i] || {x:0,y:0};
    tilePos.textContent = `(${p.x}, ${p.y})`;
    veinCount.textContent = String(state.perEntryVeinCount[i] || 0);
  }

  render(state);
}

// ---------- Buttons ----------
btnAdd.addEventListener("click", () => {
  model.entries.push({ dx: 0, dy: 0, logText: "" });
  pushHistory();
  rebuildEntriesUI();
  recomputeAndRender();
});

btnUndo.addEventListener("click", () => restoreHistory(historyIndex - 1));
btnRedo.addEventListener("click", () => restoreHistory(historyIndex + 1));

btnReset.addEventListener("click", () => {
  model = { entries: [ { dx:0, dy:0, logText:"" } ] };
  pushHistory();
  rebuildEntriesUI();
  recomputeAndRender();
});

btnExport.addEventListener("click", () => {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement("a");
    const ts = new Date().toISOString().replace(/[:.]/g,"-");
    a.download = `wo_shard_map_${ts}.png`;
    a.href = URL.createObjectURL(blob);
    document.body.appendChild(a);
    a.click();
    URL.revokeObjectURL(a.href);
    a.remove();
  }, "image/png");
});

for (const el of [gridSizeEl, tileSizeEl, maxDistEl, bgModeEl, centerModeEl]){
  el.addEventListener("input", () => recomputeAndRender());
  el.addEventListener("change", () => recomputeAndRender());
}

window.addEventListener("resize", () => render(lastComputed));

// ---------- Init ----------
pushHistory();
rebuildEntriesUI();
render(null);
recomputeAndRender();
