/*
  Wurm Online - Advanced Shard Analyzer

  Coordinate convention (matches typical screen coords and WurmNode feel):
    - X: East  = +, West  = -
    - Y: South = +, North = -
  Example: if you walked 1 tile south from the source, enter Step Y = 1.
*/

(() => {
  'use strict';

  // -----------------------------
  // DOM helpers
  // -----------------------------
  const $ = (id) => document.getElementById(id);
  const $maybe = (id) => document.getElementById(id) || null;

  const el = {
    // stock UI ids from your index.html
    stepX: $('stepX'),
    stepY: $('stepY'),
    logText: $('logText'),
    addBtn: $('addBtn'),
    undoBtn: $maybe('undoBtn'),
    resetBtn: $('resetBtn'),
    downloadBtn: $('downloadBtn'),
    entriesList: $('entriesList'),
    stats: $maybe('stats'),
    canvas: $('mapCanvas'),
  };

  // -----------------------------
  // Constants / styling
  // -----------------------------
  const TILE = 72; // tile pixel size
  const PAD = 36;

  const GRID_MINOR_ALPHA = 0.18;
  const GRID_MAJOR_ALPHA = 0.38;

  // Dark background gradient (keep your current vibe)
  const BG_TOP = '#0c0f14';
  const BG_BOTTOM = '#06080c';

  const HATCH_ALPHA = 0.25;
  const HATCH_STROKE = 'rgba(255,255,255,0.12)';

  const LOCK_STROKE = '#ff00ff';
  const LOCK_STROKE_W = 3;

  const X_STROKE = '#ff2a2a';
  const X_STROKE_W = 3;

  const FONT_MAIN = '12px system-ui, -apple-system, Segoe UI, Roboto, Arial';
  const FONT_SUB = '12px system-ui, -apple-system, Segoe UI, Roboto, Arial';
  const FONT_SMALL = '11px system-ui, -apple-system, Segoe UI, Roboto, Arial';

  // QL bins -> label + color (matches your earlier scheme)
  const QL_BINS = [
    { lo: 95, hi: 99, label: '95-99', color: '#ffa500' },
    { lo: 80, hi: 94, label: '80-94', color: '#b04cff' },
    { lo: 60, hi: 79, label: '60-79', color: '#4aa3ff' },
    { lo: 40, hi: 59, label: '40-59', color: '#67d26e' },
    { lo: 20, hi: 39, label: '20-29', color: '#c9c9c9' }, // keep as in your samples (20-29)
  ];

  function qlToBin(ql) {
    for (const b of QL_BINS) {
      if (ql >= b.lo && ql <= b.hi) return b;
    }
    // if weird, clamp
    if (ql >= 95) return QL_BINS[0];
    if (ql >= 80) return QL_BINS[1];
    if (ql >= 60) return QL_BINS[2];
    if (ql >= 40) return QL_BINS[3];
    return QL_BINS[4];
  }

  // -----------------------------
  // State
  // -----------------------------
  const state = {
    entries: [], // [{n, stepX, stepY, obs:[...]}]
    // Veins are separate instances even if same ore+ql bin
    veins: [],   // [{id, ore, binLabel, binColor, candidates:Set<xy>, locked:null|{x,y}}]
    nextVeinId: 1,
    nextEntryNum: 1,
  };

  // -----------------------------
  // Parsing
  // -----------------------------
  // We support two line types:
  //  1) directional: "You will find <ore> <dir> from here. The quality is 92."
  //  2) exact:       "The <ore> is here. The quality is 92."
  //
  // NOTE: We treat each *line group* (same ore+bin at same step) as a constraint set.
  // Multiplicity is handled by matching new constraint sets to existing vein instances by overlap.
  //
  function parseDirectionalLine(line) {
    const re = /You will find (.+?) (north|south|east|west) from here\\.?\\s*(?:The quality is|Quality is)\\s*(\\d+)/i;
    const m = line.match(re);
    if (!m) return null;

    const oreRaw = m[1].trim();
    const dir = m[2].toLowerCase();
    const ql = Number.parseInt(m[3], 10);

    return { type: 'dir', ore: normalizeOre(oreRaw), dir, ql };
  }

  function parseExactLine(line) {
    const re = /The (.+?) is here\\.?\\s*(?:The quality is|Quality is)\\s*(\\d+)/i;
    const m = line.match(re);
    if (!m) return null;

    const oreRaw = m[1].trim();
    const ql = Number.parseInt(m[2], 10);

    return { type: 'exact', ore: normalizeOre(oreRaw), ql };
  }

  function normalizeOre(ore) {
    // Keep it simple and consistent
    return ore
      .replace(/\\s+/g, ' ')
      .replace(/\\b(shards?)\\b/gi, (s) => s.toLowerCase())
      .trim();
  }

  function parseLogText(text) {
    const lines = text
      .split(/\\r?\\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const obs = [];
    for (const line of lines) {
      const ex = parseExactLine(line);
      if (ex) { obs.push(ex); continue; }

      const d = parseDirectionalLine(line);
      if (d) { obs.push(d); continue; }
    }
    return obs;
  }

  // -----------------------------
  // Geometry / constraints
  // -----------------------------
  // We operate on an integer tile grid.
  // For a given source tile (sx,sy), directional constraints mean:
  //  - east:  (x > sx)
  //  - west:  (x < sx)
  //  - south: (y > sy)
  //  - north: (y < sy)
  //
  // Additionally, we apply a finite search radius so candidates don’t explode.
  // This radius should be comfortably larger than your likely search window.
  const SEARCH_RADIUS = 30;

  function xyKey(x, y) {
    return `${x},${y}`;
  }
  function parseXY(key) {
    const [xs, ys] = key.split(',');
    return { x: Number.parseInt(xs, 10), y: Number.parseInt(ys, 10) };
  }

  function candidatesForDirectional(sx, sy, dir) {
    const set = new Set();
    for (let y = sy - SEARCH_RADIUS; y <= sy + SEARCH_RADIUS; y++) {
      for (let x = sx - SEARCH_RADIUS; x <= sx + SEARCH_RADIUS; x++) {
        if (dir === 'east'  && x > sx) set.add(xyKey(x, y));
        if (dir === 'west'  && x < sx) set.add(xyKey(x, y));
        if (dir === 'south' && y > sy) set.add(xyKey(x, y));
        if (dir === 'north' && y < sy) set.add(xyKey(x, y));
      }
    }
    return set;
  }

  function candidatesForExact(sx, sy) {
    return new Set([xyKey(sx, sy)]);
  }

  function intersectSets(a, b) {
    const out = new Set();
    for (const k of a) {
      if (b.has(k)) out.add(k);
    }
    return out;
  }

  // -----------------------------
  // Multiplicity-aware vein matching
  // -----------------------------
  function baseKeyFor(ore, binLabel) {
    return `${ore}::${binLabel}`;
  }

  function newVein(ore, binLabel, binColor, candidates) {
    const id = `${baseKeyFor(ore, binLabel)}#${state.nextVeinId++}`;
    return { id, ore, binLabel, binColor, candidates: new Set(candidates), locked: null };
  }

  function tryMatchVein(ore, binLabel, candidateSet) {
    // Match only within same base key and by overlap.
    const base = baseKeyFor(ore, binLabel);
    let best = null;
    let bestOverlap = 0;

    for (const v of state.veins) {
      if (!v.id.startsWith(base)) continue;

      // If locked, match if new set includes it
      if (v.locked) {
        if (candidateSet.has(xyKey(v.locked.x, v.locked.y))) {
          return v;
        }
        continue;
      }

      // Overlap for unresolved
      const overlap = intersectSets(v.candidates, candidateSet).size;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = v;
      }
    }

    // Require a real overlap to consider it "same vein"
    if (best && bestOverlap > 0) return best;
    return null;
  }

  function applyObservationSet(stepX, stepY, observations) {
    // source coordinate is the step itself (you are walking relative to some origin)
    const sx = stepX;
    const sy = stepY;

    // Group observations by (ore, bin)
    const grouped = new Map(); // baseKey -> list of obs
    for (const o of observations) {
      const bin = qlToBin(o.ql);
      const key = baseKeyFor(o.ore, bin.label);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push({ ...o, binLabel: bin.label, binColor: bin.color });
    }

    // For each group, compute constraint candidates = intersection of all lines in that group
    for (const [gkey, list] of grouped.entries()) {
      const ore = list[0].ore;
      const binLabel = list[0].binLabel;
      const binColor = list[0].binColor;

      let cands = null;
      for (const o of list) {
        let s = null;
        if (o.type === 'exact') s = candidatesForExact(sx, sy);
        else s = candidatesForDirectional(sx, sy, o.dir);

        cands = cands ? intersectSets(cands, s) : s;
      }
      if (!cands) continue;

      // Find or create a vein instance (multiplicity upgrade)
      let vein = tryMatchVein(ore, binLabel, cands);
      if (!vein) {
        vein = newVein(ore, binLabel, binColor, cands);
        state.veins.push(vein);
      } else {
        // Narrow existing
        vein.candidates = intersectSets(vein.candidates, cands);
      }

      // Lock if unique
      if (!vein.locked && vein.candidates.size === 1) {
        const only = [...vein.candidates][0];
        const p = parseXY(only);
        vein.locked = { x: p.x, y: p.y };
      }

      // If locked, remove hatch behavior by reducing candidates to exactly that point
      if (vein.locked) {
        vein.candidates = new Set([xyKey(vein.locked.x, vein.locked.y)]);
      }
    }
  }

  function rebuildModel() {
    // wipe veins and rebuild from entries to keep deterministic behavior
    state.veins = [];
    state.nextVeinId = 1;

    for (const e of state.entries) {
      applyObservationSet(e.stepX, e.stepY, e.obs);
    }
  }

  // -----------------------------
  // View bounds
  // -----------------------------
  function computeBounds() {
    // Base bounds around entered source steps
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    const addPoint = (x, y) => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    };

    if (state.entries.length === 0) {
      // default 13x13
      return { minX: -6, maxX: 6, minY: -6, maxY: 6 };
    }

    for (const e of state.entries) addPoint(e.stepX, e.stepY);

    // expand by a reasonable margin for display
    const margin = 6;
    minX -= margin; maxX += margin;
    minY -= margin; maxY += margin;

    // Ensure candidates/locks are inside bounds too (so you don't clip)
    for (const v of state.veins) {
      for (const k of v.candidates) {
        const p = parseXY(k);
        addPoint(p.x, p.y);
      }
      if (v.locked) addPoint(v.locked.x, v.locked.y);
    }

    // Add a little padding after including candidates
    minX -= 1; maxX += 1; minY -= 1; maxY += 1;

    return { minX, maxX, minY, maxY };
  }

  // -----------------------------
  // Rendering
  // -----------------------------
  const ctx = el.canvas.getContext('2d');

  function setCanvasSize(bounds) {
    const wTiles = (bounds.maxX - bounds.minX + 1);
    const hTiles = (bounds.maxY - bounds.minY + 1);

    const w = PAD * 2 + wTiles * TILE;
    const h = PAD * 2 + hTiles * TILE;

    el.canvas.width = Math.round(w);
    el.canvas.height = Math.round(h);
  }

  function tileToPx(x, y, bounds) {
    const px = PAD + (x - bounds.minX) * TILE;
    const py = PAD + (y - bounds.minY) * TILE;
    return { px, py };
  }

  function drawBackground() {
    const g = ctx.createLinearGradient(0, 0, 0, el.canvas.height);
    g.addColorStop(0, BG_TOP);
    g.addColorStop(1, BG_BOTTOM);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, el.canvas.width, el.canvas.height);
  }

  function drawGrid(bounds) {
    const wTiles = (bounds.maxX - bounds.minX + 1);
    const hTiles = (bounds.maxY - bounds.minY + 1);

    // Minor lines
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgba(255,255,255,${GRID_MINOR_ALPHA})`;

    for (let i = 0; i <= wTiles; i++) {
      const x = PAD + i * TILE;
      ctx.beginPath();
      ctx.moveTo(x, PAD);
      ctx.lineTo(x, PAD + hTiles * TILE);
      ctx.stroke();
    }
    for (let j = 0; j <= hTiles; j++) {
      const y = PAD + j * TILE;
      ctx.beginPath();
      ctx.moveTo(PAD, y);
      ctx.lineTo(PAD + wTiles * TILE, y);
      ctx.stroke();
    }

    // Major lines every 5 tiles
    ctx.strokeStyle = `rgba(255,255,255,${GRID_MAJOR_ALPHA})`;
    ctx.lineWidth = 2;

    for (let x = bounds.minX; x <= bounds.maxX + 1; x++) {
      if (x % 5 !== 0) continue;
      const px = PAD + (x - bounds.minX) * TILE;
      ctx.beginPath();
      ctx.moveTo(px, PAD);
      ctx.lineTo(px, PAD + hTiles * TILE);
      ctx.stroke();
    }
    for (let y = bounds.minY; y <= bounds.maxY + 1; y++) {
      if (y % 5 !== 0) continue;
      const py = PAD + (y - bounds.minY) * TILE;
      ctx.beginPath();
      ctx.moveTo(PAD, py);
      ctx.lineTo(PAD + wTiles * TILE, py);
      ctx.stroke();
    }
  }

  function drawHatchRect(x, y, bounds) {
    const { px, py } = tileToPx(x, y, bounds);
    ctx.save();
    ctx.beginPath();
    ctx.rect(px, py, TILE, TILE);
    ctx.clip();

    ctx.globalAlpha = HATCH_ALPHA;
    ctx.strokeStyle = HATCH_STROKE;
    ctx.lineWidth = 2;

    // diagonal hatch
    const step = 10;
    for (let i = -TILE; i < TILE * 2; i += step) {
      ctx.beginPath();
      ctx.moveTo(px + i, py + TILE);
      ctx.lineTo(px + i + TILE, py);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawLockedOutline(x, y, bounds) {
    const { px, py } = tileToPx(x, y, bounds);
    ctx.strokeStyle = LOCK_STROKE;
    ctx.lineWidth = LOCK_STROKE_W;
    ctx.strokeRect(px + 2, py + 2, TILE - 4, TILE - 4);
  }

  function drawRedX(x, y, bounds, nLabel) {
    const { px, py } = tileToPx(x, y, bounds);
    const inset = 10;
    ctx.strokeStyle = X_STROKE;
    ctx.lineWidth = X_STROKE_W;

    ctx.beginPath();
    ctx.moveTo(px + inset, py + inset);
    ctx.lineTo(px + TILE - inset, py + TILE - inset);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(px + TILE - inset, py + inset);
    ctx.lineTo(px + inset, py + TILE - inset);
    ctx.stroke();

    // small index label near bottom-right of X, matching your sample
    ctx.fillStyle = X_STROKE;
    ctx.font = FONT_SMALL;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(String(nLabel), px + TILE - inset - 6, py + TILE - inset + 14);
  }

  function drawCenteredLabel(x, y, bounds, title, sub, subColor) {
    const { px, py } = tileToPx(x, y, bounds);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Title
    ctx.font = FONT_MAIN;
    ctx.fillStyle = '#d7dde6';
    ctx.fillText(title, px + TILE / 2, py + TILE / 2 - 8);

    // Sub (QL bin) in color
    ctx.font = FONT_SUB;
    ctx.fillStyle = subColor;
    ctx.fillText(sub, px + TILE / 2, py + TILE / 2 + 10);
  }

  function render() {
    const bounds = computeBounds();
    setCanvasSize(bounds);

    drawBackground();
    drawGrid(bounds);

    // 1) Draw candidate hatches + labels (unresolved only)
    for (const v of state.veins) {
      if (v.locked) continue; // NO hatch once locked
      if (v.candidates.size <= 1) continue;

      for (const k of v.candidates) {
        const p = parseXY(k);
        drawHatchRect(p.x, p.y, bounds);

        // center text inside each candidate tile
        drawCenteredLabel(
          p.x,
          p.y,
          bounds,
          `${qualityPrefix(v.binLabel)} ${titleCase(v.ore)}`.trim(),
          v.binLabel,
          v.binColor
        );
      }
    }

    // 2) Draw locked tiles (magenta outline + centered label, no hatch)
    for (const v of state.veins) {
      if (!v.locked) continue;
      const { x, y } = v.locked;
      drawLockedOutline(x, y, bounds);
      drawCenteredLabel(
        x,
        y,
        bounds,
        `${qualityPrefix(v.binLabel)} ${titleCase(v.ore)}`.trim(),
        v.binLabel,
        v.binColor
      );
    }

    // 3) Draw X marks for entry points (step locations)
    let i = 1;
    for (const e of state.entries) {
      drawRedX(e.stepX, e.stepY, bounds, i);
      i++;
    }
  }

  function qualityPrefix(binLabel) {
    // Map bins to your wording. Adjust if you want different adjectives.
    // Keep consistent with your exported samples.
    if (binLabel === '95-99') return 'Utmost Quality';
    if (binLabel === '80-94') return 'Very Good Quality';
    if (binLabel === '60-79') return 'Good Quality';
    if (binLabel === '40-59') return 'Normal Quality';
    if (binLabel === '20-29') return 'Poor Quality';
    return '';
  }

  function titleCase(s) {
    return s.replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // -----------------------------
  // UI lists / stats
  // -----------------------------
  function clearNode(n) {
    while (n.firstChild) n.removeChild(n.firstChild);
  }

  function updateLists() {
    // Entries
    clearNode(el.entriesList);
    for (const e of state.entries) {
      const li = document.createElement('li');
      li.textContent = `#${e.n}: stepX=${e.stepX}, stepY=${e.stepY} (${e.obs.length} line(s))`;
      el.entriesList.appendChild(li);
    }

    // Stats (for the stock UI)
    if (el.stats) {
      const lockedCount = state.veins.filter(v => !!v.locked).length;
      const unresolvedCount = state.veins.filter(v => !v.locked && v.candidates.size > 1).length;
      el.stats.textContent =
        `Entries: ${state.entries.length} | Veins: ${state.veins.length} | Locked: ${lockedCount} | Unresolved: ${unresolvedCount}`;
    }
  }

  function addEntry(stepX, stepY, logText) {
    const obs = parseLogText(logText);
    if (obs.length === 0) {
      alert('No recognizable lines found. Paste Wurm prospecting lines like “You will find … east from here. The quality is 92.”');
      return;
    }

    state.entries.push({
      n: state.nextEntryNum++,
      stepX,
      stepY,
      obs,
    });

    rebuildModel();
    updateLists();
    render();
  }

  function undoLast() {
    if (state.entries.length === 0) return;
    state.entries.pop();
    rebuildModel();
    updateLists();
    render();
  }

  function resetAll() {
    state.entries = [];
    state.veins = [];
    state.nextVeinId = 1;
    state.nextEntryNum = 1;
    updateLists();
    render();
  }

  // -----------------------------
  // Events
  // -----------------------------
  const handleAdd = () => {
    const stepX = Number.parseInt(el.stepX.value, 10);
    const stepY = Number.parseInt(el.stepY.value, 10);
    const text = el.logText.value || '';

    if (Number.isNaN(stepX) || Number.isNaN(stepY) || text.trim().length === 0) {
      alert('Please enter Step X, Step Y, and paste log text.');
      return;
    }

    addEntry(stepX, stepY, text);

    // Clear log box after successful add (optional, but nice UX)
    el.logText.value = '';
    el.logText.focus();
  };

  el.addBtn.addEventListener('click', handleAdd);

  if (el.undoBtn) {
    el.undoBtn.addEventListener('click', () => undoLast());
  }

  el.resetBtn.addEventListener('click', () => resetAll());

  el.downloadBtn.addEventListener('click', () => {
    const link = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    link.download = `wo_shard_map_${ts}.png`;
    link.href = el.canvas.toDataURL('image/png');
    link.click();
  });

  // -----------------------------
  // First render
  // -----------------------------
  updateLists();
  render();
})();
