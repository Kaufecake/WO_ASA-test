/* Wurm Online – Advanced Shard Analyzer (app.js) v5
   Fixes:
   - WurmNode-like candidate regions: FILLED wedges/rectangles (not ring-perimeter L-shapes)
   - Robust DOM lookup (prevents UI break / paste issues due to id mismatches)
   - StepX/StepY treated as DELTAS
   - Grid always pads >= 6 tiles beyond farthest feasible cell / source
   - Uniform grid only (no major gridlines)
*/

document.addEventListener("DOMContentLoaded", () => {
  const jsStatus = document.querySelector("#jsStatus");
  if (jsStatus) jsStatus.textContent = "loaded";

  (function () {
  // ---------- Robust DOM lookup ----------
  function $(sel) { return document.querySelector(sel); }

  const canvas =
    $("#mapCanvas") ||
    $("#canvas") ||
    document.querySelector("canvas");

  const ctx = canvas ? canvas.getContext("2d") : null;

  const stepXEl =
    $("#stepX") ||
    $("#dx") ||
    $("#step_x") ||
    document.querySelector('input[name="stepX"]') ||
    document.querySelector('input[type="number"]');

  const stepYEl =
    $("#stepY") ||
    $("#dy") ||
    $("#step_y") ||
    document.querySelector('input[name="stepY"]') ||
    (document.querySelectorAll('input[type="number"]')[1] || null);

  const logTextEl =
    $("#logText") ||
    $("#log") ||
    $("#logInput") ||
    $("#paste") ||
    document.querySelector("textarea");

  const addBtn =
    $("#addBtn") ||
    $("#add") ||
    document.querySelector('button[data-action="add"]') ||
    Array.from(document.querySelectorAll("button")).find(b => /add/i.test(b.textContent));

  const undoBtn =
    $("#undoBtn") ||
    $("#undo") ||
    document.querySelector('button[data-action="undo"]') ||
    Array.from(document.querySelectorAll("button")).find(b => /undo/i.test(b.textContent));

  const resetBtn =
    $("#resetBtn") ||
    $("#reset") ||
    document.querySelector('button[data-action="reset"]') ||
    Array.from(document.querySelectorAll("button")).find(b => /reset/i.test(b.textContent));

  const downloadBtn =
    $("#downloadBtn") ||
    $("#download") ||
    document.querySelector('button[data-action="download"]') ||
    Array.from(document.querySelectorAll("button")).find(b => /download/i.test(b.textContent));

  const statsEl =
    $("#stats") ||
    $("#status") ||
    document.querySelector(".stats") ||
    document.querySelector(".status");

  if (!canvas || !ctx || !logTextEl) {
    console.warn("[WO Shard Analyzer] Missing required elements (canvas/textarea). Script will not run.");
    return;
  }

  // ---------- Constants / helpers ----------
  const STORAGE_KEY = "wo_shard_analyzer_state_v5";
  const PAD_TILES = 6;

  const QUALITY_BANDS = [
    { key: "poor",      label: "20-29", color: "#9aa0a6" },
    { key: "normal",    label: "40-59", color: "#3ddc84" },
    { key: "good",      label: "60-79", color: "#4ea1ff" },
    { key: "very_good", label: "80-94", color: "#b36bff" },
    { key: "utmost",    label: "95-99", color: "#ffb020" }
  ];

  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function parseIntSafe(v, fallback = 0) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
  }
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
  function titleCase(s) {
    return s.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1));
  }

  function qlColorForNumber(n) {
    if (!Number.isFinite(n)) return "#cfd8dc";
    if (n >= 95) return QUALITY_BANDS.find(b => b.key === "utmost").color;
    if (n >= 80) return QUALITY_BANDS.find(b => b.key === "very_good").color;
    if (n >= 60) return QUALITY_BANDS.find(b => b.key === "good").color;
    if (n >= 40) return QUALITY_BANDS.find(b => b.key === "normal").color;
    return QUALITY_BANDS.find(b => b.key === "poor").color;
  }

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

  function oreNormalize(raw) {
    if (!raw) return null;
    let t = raw.toLowerCase().trim();
    t = t.replace(/\s+ore\b/g, "");
    t = t.replace(/\s+vein\b/g, "");
    t = t.replace(/\s+here\b/g, "");
    // Ignore “stone shards” / shards context entirely for mining lock behavior:
    if (t.includes("stone shards")) return null;
    if (t.includes("shards")) return null;
    t = t.replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
    return t || null;
  }

  // ---------- Direction parsing ----------
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
    if (DIR_MAP[p]) return { type: "dir", ...DIR_MAP[p] };

    const m = p.match(/(north|south|east|west)\s+of\s+(north|south|east|west)/i);
    if (m) {
      const v1 = DIR_MAP[m[1].toLowerCase()];
      const v2 = DIR_MAP[m[2].toLowerCase()];
      const dx = clamp(v1.dx + v2.dx, -1, 1);
      const dy = clamp(v1.dy + v2.dy, -1, 1);
      return { type: "dir", dx, dy };
    }
    return null;
  }

  // ---------- Strength -> distance ----------
  // Key change: distances tuned to give “area wedges” that resemble WurmNode’s output scale.
  // Adjust these if you want the wedge tighter/looser.
  function strengthToDistance(strengthWord) {
    if (!strengthWord) return 6;
    const s = strengthWord.toLowerCase();
    if (s.includes("slight"))     return 6;
    if (s.includes("faint"))      return 8;
    if (s.includes("minuscule"))  return 8;
    if (s.includes("vague"))      return 10;
    if (s.includes("indistinct")) return 12;
    return 6;
  }

  // ---------- WurmNode-like candidate regions (FILLED, not perimeter-only) ----------
  function matchesCardinal(dx, dy, dir) {
    if (dir.dx === 1 && dir.dy === 0) return dx > 0;  // east half-plane
    if (dir.dx === -1 && dir.dy === 0) return dx < 0; // west
    if (dir.dx === 0 && dir.dy === 1) return dy > 0;  // north
    if (dir.dx === 0 && dir.dy === -1) return dy < 0; // south
    return false;
  }

  function matchesDiagonal(dx, dy, dir) {
    if (dir.dx === 1 && dir.dy === 1) return dx > 0 && dy > 0;   // NE
    if (dir.dx === -1 && dir.dy === 1) return dx < 0 && dy > 0;  // NW
    if (dir.dx === 1 && dir.dy === -1) return dx > 0 && dy < 0;  // SE
    if (dir.dx === -1 && dir.dy === -1) return dx < 0 && dy < 0; // SW
    return false;
  }

  // Filled region:
  // - Cardinal: rectangle out to distance d, with +/-d lateral spread (matches typical “cone/strip” feel)
  // - Diagonal: filled triangle in the octant using Manhattan constraint |dx|+|dy| <= d
  function wedgeCandidates(source, d, dir) {
    const out = new Set();
    if (!d || d < 1 || !dir) return out;

    const sx = source.x, sy = source.y;

    // Cardinal directions => rectangle
    if ((dir.dx === 1 || dir.dx === -1) && dir.dy === 0) {
      // East/West: forward distance up to d, lateral spread up to d
      for (let dx = 1; dx <= d; dx++) {
        const realDx = dx * dir.dx;
        for (let dy = -d; dy <= d; dy++) {
          out.add(coordKey(sx + realDx, sy + dy));
        }
      }
      return out;
    }

    if ((dir.dy === 1 || dir.dy === -1) && dir.dx === 0) {
      // North/South: forward distance up to d, lateral spread up to d
      for (let dy = 1; dy <= d; dy++) {
        const realDy = dy * dir.dy;
        for (let dx = -d; dx <= d; dx++) {
          out.add(coordKey(sx + dx, sy + realDy));
        }
      }
      return out;
    }

    // Diagonals => filled triangle in octant
    for (let dx = -d; dx <= d; dx++) {
      for (let dy = -d; dy <= d; dy++) {
        if (dx === 0 && dy === 0) continue;
        if (!matchesDiagonal(dx, dy, dir)) continue;
        if ((Math.abs(dx) + Math.abs(dy)) > d) continue; // triangle boundary
        out.add(coordKey(sx + dx, sy + dy));
      }
    }
    return out;
  }

  // ---------- Parsing ----------
  function extractStrengthWord(line) {
    const s = line.toLowerCase();
    const words = ["indistinct", "vague", "minuscule", "faint", "slight"];
    for (const w of words) if (s.includes(w)) return w;
    return null;
  }

  function parseOreAndAdjFromDescriptor(descRaw) {
    if (!descRaw) return null;
    const d = descRaw.toLowerCase().trim();

    // “indistinct trace of something, but cannot quite make it out”
    if (d.includes("something") && d.includes("cannot quite make it out")) {
      return { ore: "Unknown", adj: null };
    }

    let adj = null;
    if (d.includes("utmost quality")) adj = "utmost";
    else if (d.includes("very good quality")) adj = "very good";
    else if (d.includes("good quality")) adj = "good";
    else if (d.includes("normal quality")) adj = "normal";
    else if (d.includes("poor quality")) adj = "poor";

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

    const tokens = orePart.split(" ").filter(Boolean);
    const ore = tokens.length ? tokens[tokens.length - 1] : null;
    if (!ore) return null;

    const norm = oreNormalize(ore);
    return { ore: norm || ore, adj };
  }

  function parseLogBlock(rawText) {
    const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    let started = false;
    let mineOre = null;
    let mineMaxQl = null;

    const traces = [];

    // Start rule you asked for:
    // - Underground: ignore until “You start to analyse...”
    // - Surface: also accept “You start to gather fragments...”
    const startRegex = /(you start to gather fragments of the rock\.)|(you start to analys(e|z)e the (shard|ore)\.)/i;
    const endRegex = /you finish analys(e|z)ing the (shard|ore)\./i;

    const mineRegex = /you would mine (.+?) here\./i;
    const maxQlRegex = /it has a max quality of (\d+)\./i;

    // More permissive: any “… trace of <descriptor> (<dir>).”
    const traceRegex = /\btrace of\s+(.+?)\s*\((.+?)\)\./i;

    for (const line of lines) {
      if (!started) {
        if (startRegex.test(line)) started = true;
        else continue;
      }

      if (endRegex.test(line)) break;

      // Mining context (used ONLY if it’s actually ore, not shards)
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

      const mTrace = line.match(traceRegex);
      if (mTrace) {
        const strength = extractStrengthWord(line);
        const descriptor = mTrace[1].trim();
        const dirPhrase = mTrace[2].trim();

        const dir = parseDirectionPhrase(dirPhrase);
        if (!dir) continue;

        const parsed = parseOreAndAdjFromDescriptor(descriptor);
        if (!parsed) continue;

        traces.push({
          ore: parsed.ore || "Unknown",
          adj: parsed.adj,
          strengthWord: strength,
          dir
        });
      }
    }

    if (!started) return null;
    return { mineOre, mineMaxQl, traces };
  }

  // ---------- State ----------
  let state = { entries: [], nextVeinId: 1 };

  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
  }
  function loadState() {
    try {
      const s = localStorage.getItem(STORAGE_KEY);
      if (!s) return;
      const obj = JSON.parse(s);
      if (!obj || !Array.isArray(obj.entries)) return;
      state = obj;
      if (!Number.isFinite(state.nextVeinId)) state.nextVeinId = 1;
    } catch (_) {}
  }

  // ---------- Multiplicity / solver ----------
  function bestMatchingVein(veins, ore, qlDisplay, candidateSet) {
    let best = null, bestScore = 0;
    for (const v of veins) {
      if (v.ore !== ore) continue;
      if ((v.qlDisplay || "") !== (qlDisplay || "")) continue;
      if (!v.feasible || v.feasible.size === 0) continue;

      let overlap = 0;
      for (const k of candidateSet) if (v.feasible.has(k)) overlap++;
      if (overlap > bestScore) { bestScore = overlap; best = v; }
    }
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
    const vNew = createVeinInstance(ore, qlDisplay, qlColor, [k]);
    vNew.locked = true;
    vNew.lockedCoord = { x, y };
    veins.push(vNew);
  }

  function incorporateCandidates(veins, ore, qlDisplay, qlColor, candidateSet) {
    const match = bestMatchingVein(veins, ore, qlDisplay, candidateSet);
    if (!match) {
      veins.push(createVeinInstance(ore, qlDisplay, qlColor, candidateSet));
      return;
    }
    match.feasible = setIntersect(match.feasible, candidateSet);
    if (match.feasible.size === 1) {
      const only = [...match.feasible][0];
      const c = parseCoordKey(only);
      match.locked = true;
      match.lockedCoord = { x: c.x, y: c.y };
    }
  }

  function rebuildVeinsFromEntries() {
    const veins = [];

    for (const entry of state.entries) {
      const source = { x: entry.x, y: entry.y };
      const parsed = entry.parsed;

      // Lock at source ONLY if mining ore + numeric max QL
      if (parsed.mineOre && Number.isFinite(parsed.mineMaxQl)) {
        const ore = parsed.mineOre;
        const ql = parsed.mineMaxQl;
        lockVeinAt(veins, ore, String(ql), qlColorForNumber(ql), source.x, source.y);
      }

      const groups = new Map(); // key => candidateSet

      for (const t of parsed.traces) {
        const ore = t.ore || "Unknown";

        const band = bandForAdj(t.adj);
        const qlDisplay = band ? band.label : "";
        const qlColor = band ? band.color : "#cfd8dc";

        const d = strengthToDistance(t.strengthWord);
        const cand = wedgeCandidates(source, d, t.dir);
        if (cand.size === 0) continue;

        const key = `${ore}||${qlDisplay}||${qlColor}`;
        if (!groups.has(key)) groups.set(key, cand);
        else groups.set(key, setIntersect(groups.get(key), cand));
      }

      for (const [key, candSet] of groups.entries()) {
        if (!candSet || candSet.size === 0) continue;
        const [ore, qlDisplay, qlColor] = key.split("||");
        incorporateCandidates(veins, ore, qlDisplay, qlColor, candSet);
      }
    }

    return veins;
  }

  // ---------- Rendering ----------
  function drawBackground() {
    const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    g.addColorStop(0, "#0b0f14");
    g.addColorStop(1, "#070a0f");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function computeBounds(veins) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

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
      minX = Math.min(minX, e.x);
      minY = Math.min(minY, e.y);
      maxX = Math.max(maxX, e.x);
      maxY = Math.max(maxY, e.y);
    }

    if (!Number.isFinite(minX)) {
      minX = -10; minY = -10; maxX = 10; maxY = 10;
    }

    minX -= PAD_TILES; minY -= PAD_TILES;
    maxX += PAD_TILES; maxY += PAD_TILES;

    return { minX, minY, maxX, maxY };
  }

  function tileToPx(x, y, bounds, cell, margin) {
    const px = margin + (x - bounds.minX) * cell;
    const py = margin + (bounds.maxY - y) * cell;
    return { px, py };
  }

  function drawUniformGrid(bounds, cell, margin) {
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    const cols = bounds.maxX - bounds.minX + 1;
    const rows = bounds.maxY - bounds.minY + 1;

    for (let i = 0; i <= cols; i++) {
      const x = margin + i * cell;
      ctx.beginPath();
      ctx.moveTo(x, margin);
      ctx.lineTo(x, margin + rows * cell);
      ctx.stroke();
    }

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

  function roundRect(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
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

    ctx.fillStyle = "rgba(0,0,0,0.55)";
    roundRect(x, y, boxW, boxH, 8);
    ctx.fill();

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

  function drawVeins(bounds, cell, margin, veins) {
    for (const v of veins) {
      const oreName = v.ore === "Unknown" ? "Unknown" : titleCase(v.ore);
      const qlText = v.qlDisplay || "";

      if (v.locked && v.feasible.size === 1) {
        const only = [...v.feasible][0];
        const c = parseCoordKey(only);
        const { px, py } = tileToPx(c.x, c.y, bounds, cell, margin);
        drawLabelCentered(oreName, qlText, px + cell / 2, py + cell / 2, v.qlColor);
        continue;
      }

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

      if (Number.isFinite(minPx)) {
        drawLabelCentered(oreName, qlText, (minPx + maxPx) / 2, (minPy + maxPy) / 2, v.qlColor);
      }
    }
  }

  function drawSources(bounds, cell, margin) {
    for (let i = 0; i < state.entries.length; i++) {
      const e = state.entries[i];
      const { px, py } = tileToPx(e.x, e.y, bounds, cell, margin);
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

  function render() {
    const veins = rebuildVeinsFromEntries();
    drawBackground();

    const bounds = computeBounds(veins);
    const cols = bounds.maxX - bounds.minX + 1;
    const rows = bounds.maxY - bounds.minY + 1;

    const margin = 30;
    const usableW = canvas.width - margin * 2;
    const usableH = canvas.height - margin * 2;
    const cell = Math.max(8, Math.floor(Math.min(usableW / cols, usableH / rows)));

    drawUniformGrid(bounds, cell, margin);
    drawVeins(bounds, cell, margin, veins);
    drawSources(bounds, cell, margin);

    if (statsEl) {
      const locked = veins.filter(v => v.locked).length;
      statsEl.innerHTML = `
        <div><b>Entries:</b> ${state.entries.length}</div>
        <div><b>Vein instances:</b> ${veins.length} (locked: ${locked}, unresolved: ${veins.length - locked})</div>
        <div><b>Bounds padding:</b> ${PAD_TILES} tiles</div>
      `;
    }
  }

  // ---------- UX ----------
  function currentPosition() {
    if (state.entries.length === 0) return { x: 0, y: 0 };
    const last = state.entries[state.entries.length - 1];
    return { x: last.x, y: last.y };
  }

  function addEntry() {
    const dx = parseIntSafe(stepXEl ? stepXEl.value : 0, 0);
    const dy = parseIntSafe(stepYEl ? stepYEl.value : 0, 0);

    const raw = (logTextEl.value || "").trim();
    if (!raw) { alert("Paste a log block first."); return; }

    const parsed = parseLogBlock(raw);
    if (!parsed) {
      alert("No usable session found. Paste must include 'You start to gather fragments...' or 'You start to analyse/analyze the shard/ore.'");
      return;
    }

    const cur = currentPosition();
    const x = cur.x + dx;
    const y = cur.y + dy;

    state.entries.push({ x, y, dx, dy, parsed, raw });
    saveState();

    logTextEl.value = "";
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

  if (addBtn) addBtn.addEventListener("click", addEntry);
  if (undoBtn) undoBtn.addEventListener("click", undoEntry);
  if (resetBtn) resetBtn.addEventListener("click", resetAll);
  if (downloadBtn) downloadBtn.addEventListener("click", downloadPNG);

  loadState();
  render();
  })();
});
