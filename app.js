/*
  Wurm Online - Advanced Shard Analyzer
  FULL REPLACEMENT app.js

  Updates in this version:
  - Parses REAL Wurm log format like:
      "You spot a slight trace of utmost quality iron (north of east)."
      "You see a minuscule trace of very good quality iron (south of west)."
      "You spot an indistinct trace of normal quality iron (northeast)."
  - Ignores log text UNTIL:
      "You start to analyse the shard."  (underground)
      OR
      "You start to gather fragments of the rock." (surface)
  - Pre-"analyse" text is ONLY used if it indicates:
      "You would mine <something> here." AND then a line like "It has a max quality of 78."
    (and it’s not stone shards)
  - Quality bands (poor/normal/good/very good/utmost) map to colored number ranges.
  - If a specific quality number is given, the label shows that number (colored by its bin).
  - Ambiguous (>1 candidate tile) => hatch tiles + centered label.
    Locked (1 tile) => NO hatch, magenta outline + centered label.
*/

(() => {
  'use strict';

  // -----------------------------
  // DOM
  // -----------------------------
  const $ = (id) => document.getElementById(id);
  const el = {
    stepX: $('stepX'),
    stepY: $('stepY'),
    logText: $('logText'),
    addBtn: $('addBtn'),
    undoBtn: document.getElementById('undoBtn') || null,
    resetBtn: $('resetBtn'),
    downloadBtn: $('downloadBtn'),
    entriesList: $('entriesList'),
    stats: document.getElementById('stats') || null,
    canvas: $('mapCanvas'),
  };

  // -----------------------------
  // Constants / style
  // -----------------------------
  const TILE = 72;      // tile pixel size (big enough for centered labels)
  const PAD = 36;

  const BG_TOP = '#0c0f14';
  const BG_BOTTOM = '#06080c';

  const GRID_MINOR_ALPHA = 0.18;
  const GRID_MAJOR_ALPHA = 0.38;

  const HATCH_ALPHA = 0.25;
  const HATCH_STROKE = 'rgba(255,255,255,0.12)';

  const LOCK_STROKE = '#ff00ff';
  const LOCK_STROKE_W = 3;

  const X_STROKE = '#ff2a2a';
  const X_STROKE_W = 3;

  const FONT_TITLE = '12px system-ui, -apple-system, Segoe UI, Roboto, Arial';
  const FONT_SUB = '12px system-ui, -apple-system, Segoe UI, Roboto, Arial';
  const FONT_SMALL = '11px system-ui, -apple-system, Segoe UI, Roboto, Arial';

  // Coordinate convention:
  // X: East = +, West = -
  // Y: South = +, North = -
  // "northeast" => x>sx AND y<sy
  // "southwest" => x<sx AND y>sy
  const SEARCH_RADIUS = 30;

  // QL bins
  const QL_BINS = [
    { lo: 95, hi: 999, label: '95-99', color: '#ffa500' },
    { lo: 80, hi: 94, label: '80-94', color: '#b04cff' },
    { lo: 60, hi: 79, label: '60-79', color: '#4aa3ff' },
    { lo: 40, hi: 59, label: '40-59', color: '#67d26e' },
    { lo: 0,  hi: 39, label: '20-29', color: '#c9c9c9' }, // keep your displayed label
  ];

  function qlToBin(ql) {
    for (const b of QL_BINS) {
      if (ql >= b.lo && ql <= b.hi) return b;
    }
    return QL_BINS[QL_BINS.length - 1];
  }

  const BAND_TO_BIN = {
    'utmost': { label: '95-99' },
    'very good': { label: '80-94' },
    'good': { label: '60-79' },
    'normal': { label: '40-59' },
    'poor': { label: '20-29' },
  };

  function binLabelToColor(label) {
    const b = QL_BINS.find(x => x.label === label);
    return b ? b.color : '#c9c9c9';
  }

  // -----------------------------
  // State
  // -----------------------------
  const state = {
    entries: [], // {n, stepX, stepY, obs:[...] }
    veins: [],   // vein instances (multiplicity-safe)
    nextVeinId: 1,
    nextEntryNum: 1,
  };

  // -----------------------------
  // Helpers
  // -----------------------------
  function xyKey(x, y) { return `${x},${y}`; }
  function parseXY(key) {
    const [xs, ys] = key.split(',');
    return { x: parseInt(xs, 10), y: parseInt(ys, 10) };
  }
  function intersectSets(a, b) {
    const out = new Set();
    for (const k of a) if (b.has(k)) out.add(k);
    return out;
  }

  function normalizeOreName(raw) {
    return raw
      .replace(/\s+/g, ' ')
      .replace(/\b(ore|shards?)\b/gi, (m) => m.toLowerCase())
      .trim();
  }

  function titleCase(s) {
    return s.replace(/\b\w/g, c => c.toUpperCase());
  }

  // -----------------------------
  // Direction parsing (Wurm log)
  // -----------------------------
  // Accept:
  //   (west) (east) (north) (south)
  //   (northeast) (northwest) (southeast) (southwest)
  //   (north of east) => northeast
  //   (south of west) => southwest
  function normalizeDir(dirRaw) {
    let d = dirRaw.toLowerCase().trim();
    d = d.replace(/\s+/g, ' ');

    if (d === 'north of east') return 'northeast';
    if (d === 'east of north') return 'northeast';

    if (d === 'north of west') return 'northwest';
    if (d === 'west of north') return 'northwest';

    if (d === 'south of east') return 'southeast';
    if (d === 'east of south') return 'southeast';

    if (d === 'south of west') return 'southwest';
    if (d === 'west of south') return 'southwest';

    return d;
  }

  function candidatesForDir(sx, sy, dir) {
    const set = new Set();
    const addIf = (x, y, cond) => { if (cond) set.add(xyKey(x, y)); };

    for (let y = sy - SEARCH_RADIUS; y <= sy + SEARCH_RADIUS; y++) {
      for (let x = sx - SEARCH_RADIUS; x <= sx + SEARCH_RADIUS; x++) {
        const east  = x > sx;
        const west  = x < sx;
        const north = y < sy; // y decreases to go north
        const south = y > sy;

        switch (dir) {
          case 'east': addIf(x, y, east); break;
          case 'west': addIf(x, y, west); break;
          case 'north': addIf(x, y, north); break;
          case 'south': addIf(x, y, south); break;
          case 'northeast': addIf(x, y, east && north); break;
          case 'northwest': addIf(x, y, west && north); break;
          case 'southeast': addIf(x, y, east && south); break;
          case 'southwest': addIf(x, y, west && south); break;
          default:
            // unknown direction => no constraint (but keep bounded)
            set.add(xyKey(x, y));
            break;
        }
      }
    }
    return set;
  }

  function candidatesForExact(sx, sy) {
    return new Set([xyKey(sx, sy)]);
  }

  // -----------------------------
  // Log gating (ignore until trigger)
  // -----------------------------
  const TRIGGER_ANALYZE = 'you start to analyse the shard';
  const TRIGGER_GATHER  = 'you start to gather fragments of the rock';

  function sliceRelevantLines(fullText) {
    const lines = fullText.split(/\r?\n/);

    // Find first trigger occurrence
    let startIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const t = stripTimestamp(lines[i]).toLowerCase();
      if (t.includes(TRIGGER_ANALYZE) || t.includes(TRIGGER_GATHER)) {
        startIdx = i;
        break;
      }
    }
    if (startIdx === -1) return { preAnalyze: [], analyzeBlock: [] };

    // Find analyze trigger if present AFTER startIdx
    let analyzeIdx = -1;
    for (let i = startIdx; i < lines.length; i++) {
      const t = stripTimestamp(lines[i]).toLowerCase();
      if (t.includes(TRIGGER_ANALYZE)) { analyzeIdx = i; break; }
    }

    // If underground analyze exists: preAnalyze is from startIdx..analyzeIdx-1, analyzeBlock from analyzeIdx..end
    // If no analyze trigger, analyzeBlock = from startIdx..end
    if (analyzeIdx !== -1) {
      return {
        preAnalyze: lines.slice(startIdx, analyzeIdx),
        analyzeBlock: lines.slice(analyzeIdx),
      };
    }

    return {
      preAnalyze: [],
      analyzeBlock: lines.slice(startIdx),
    };
  }

  function stripTimestamp(line) {
    // removes leading "[02:49:53]" pattern if present
    return line.replace(/^\s*\[\d{2}:\d{2}:\d{2}\]\s*/, '').trim();
  }

  // -----------------------------
  // Parsing observations
  // -----------------------------
  // Observation forms we support:
  // A) Trace direction + band:
  //    "You spot a slight trace of utmost quality iron (north of east)."
  //    "You see a minuscule trace of very good quality iron (south of west)."
  //    "You spot an indistinct trace of normal quality iron (northeast)."
  //
  // B) “Would mine here” + max quality (pre-analyze only):
  //    "You would mine iron ore here."
  //    "It has a max quality of 78."
  //
  // Output obs objects:
  //   { type:'dir', ore, dir, subText, subColor, binLabel }
  //   { type:'exact', ore, x,y implied by step, subText, subColor, binLabel }
  function parseAnalyzeBlock(lines) {
    const obs = [];

    for (const rawLine of lines) {
      const line = stripTimestamp(rawLine);
      const lower = line.toLowerCase();

      // Trace lines
      // Example: "You spot a slight trace of utmost quality iron (north of east)."
      const m = line.match(/trace of (utmost|normal|poor|good|very good) quality (.+?)\s*\((.+?)\)\.?$/i);
      if (m) {
        const bandWord = m[1].toLowerCase();
        const ore = normalizeOreName(m[2]);
        const dir = normalizeDir(m[3]);

        const binLabel = BAND_TO_BIN[bandWord]?.label || '20-29';
        const subColor = binLabelToColor(binLabel);

        obs.push({
          type: 'dir',
          ore,
          dir,
          binLabel,
          subText: binLabel,     // band => show number range under ore name
          subColor,
        });
        continue;
      }

      // Some logs may include the band without "quality" keyword; keep a fallback:
      const m2 = line.match(/trace of (utmost|normal|poor|good|very good)\s+(.+?)\s*\((.+?)\)\.?$/i);
      if (m2) {
        const bandWord = m2[1].toLowerCase();
        const ore = normalizeOreName(m2[2]);
        const dir = normalizeDir(m2[3]);

        const binLabel = BAND_TO_BIN[bandWord]?.label || '20-29';
        const subColor = binLabelToColor(binLabel);

        obs.push({
          type: 'dir',
          ore,
          dir,
          binLabel,
          subText: binLabel,
          subColor,
        });
        continue;
      }
    }

    return obs;
  }

  function parsePreAnalyzeMining(lines) {
    // Only use if it indicates "You would mine <something> here." AND a following max quality.
    // Ignore stone shards.
    let minedThing = null;
    let maxQl = null;

    for (const rawLine of lines) {
      const line = stripTimestamp(rawLine);

      const mineM = line.match(/You would mine (.+?) here\.?/i);
      if (mineM) {
        minedThing = normalizeOreName(mineM[1]);
        continue;
      }

      const qM = line.match(/max quality of\s*(\d+)/i);
      if (qM) {
        maxQl = parseInt(qM[1], 10);
        continue;
      }
    }

    if (!minedThing || maxQl === null || Number.isNaN(maxQl)) return [];

    // If it’s just stone shards, ignore
    if (minedThing.toLowerCase().includes('stone shards')) return [];

    const bin = qlToBin(maxQl);

    // If specific ql is called out, show that number (not the band range)
    return [{
      type: 'exact',
      ore: minedThing,
      binLabel: bin.label,
      subText: String(maxQl),
      subColor: bin.color,
    }];
  }

  function parseLogText(fullText) {
    const { preAnalyze, analyzeBlock } = sliceRelevantLines(fullText);

    const preObs = parsePreAnalyzeMining(preAnalyze);
    const analyzeObs = parseAnalyzeBlock(analyzeBlock);

    // Combine
    return [...preObs, ...analyzeObs];
  }

  // -----------------------------
  // Multiplicity-safe vein model
  // -----------------------------
  function baseKeyFor(ore, binLabel) {
    // binLabel groups by displayed range (or bin for numeric)
    return `${ore}::${binLabel}`;
  }

  function newVein(ore, binLabel, subColor, candidates) {
    const id = `${baseKeyFor(ore, binLabel)}#${state.nextVeinId++}`;
    return { id, ore, binLabel, subColor, candidates: new Set(candidates), locked: null };
  }

  function tryMatchVein(ore, binLabel, candidateSet) {
    const base = baseKeyFor(ore, binLabel);
    let best = null;
    let bestOverlap = 0;

    for (const v of state.veins) {
      if (!v.id.startsWith(base)) continue;

      if (v.locked) {
        if (candidateSet.has(xyKey(v.locked.x, v.locked.y))) return v;
        continue;
      }

      const overlap = intersectSets(v.candidates, candidateSet).size;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = v;
      }
    }

    if (best && bestOverlap > 0) return best;
    return null;
  }

  function applyObservationSet(stepX, stepY, observations) {
    const sx = stepX;
    const sy = stepY;

    // Group by (ore, binLabel)
    const grouped = new Map();
    for (const o of observations) {
      const key = baseKeyFor(o.ore, o.binLabel);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(o);
    }

    for (const [gkey, list] of grouped.entries()) {
      const ore = list[0].ore;
      const binLabel = list[0].binLabel;
      const subColor = list[0].subColor;

      // For a group, intersect all constraints in that group
      let cands = null;
      for (const o of list) {
        let s;
        if (o.type === 'exact') s = candidatesForExact(sx, sy);
        else s = candidatesForDir(sx, sy, o.dir);

        cands = cands ? intersectSets(cands, s) : s;
      }
      if (!cands) continue;

      // Multiplicity matching
      let vein = tryMatchVein(ore, binLabel, cands);
      if (!vein) {
        vein = newVein(ore, binLabel, subColor, cands);
        state.veins.push(vein);
      } else {
        vein.candidates = intersectSets(vein.candidates, cands);
      }

      // Lock if unique
      if (!vein.locked && vein.candidates.size === 1) {
        const only = [...vein.candidates][0];
        const p = parseXY(only);
        vein.locked = { x: p.x, y: p.y };
      }

      // If locked, keep only that tile (ensures hatch disappears)
      if (vein.locked) {
        vein.candidates = new Set([xyKey(vein.locked.x, vein.locked.y)]);
      }
    }
  }

  function rebuildModel() {
    state.veins = [];
    state.nextVeinId = 1;

    for (const e of state.entries) {
      applyObservationSet(e.stepX, e.stepY, e.obs);
    }
  }

  // -----------------------------
  // Bounds / rendering
  // -----------------------------
  const ctx = el.canvas.getContext('2d');

  function computeBounds() {
    if (state.entries.length === 0) {
      return { minX: -6, maxX: 6, minY: -6, maxY: 6 };
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const add = (x, y) => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    };

    for (const e of state.entries) add(e.stepX, e.stepY);

    // include candidates/locks to avoid clipping
    for (const v of state.veins) {
      for (const k of v.candidates) {
        const p = parseXY(k);
        add(p.x, p.y);
      }
      if (v.locked) add(v.locked.x, v.locked.y);
    }

    // pad
    minX -= 7; maxX += 7;
    minY -= 7; maxY += 7;

    return { minX, maxX, minY, maxY };
  }

  function setCanvasSize(bounds) {
    const wTiles = (bounds.maxX - bounds.minX + 1);
    const hTiles = (bounds.maxY - bounds.minY + 1);

    el.canvas.width = Math.round(PAD * 2 + wTiles * TILE);
    el.canvas.height = Math.round(PAD * 2 + hTiles * TILE);
  }

  function tileToPx(x, y, bounds) {
    return {
      px: PAD + (x - bounds.minX) * TILE,
      py: PAD + (y - bounds.minY) * TILE,
    };
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

    // minor
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

    // major every 5
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(255,255,255,${GRID_MAJOR_ALPHA})`;

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

    ctx.fillStyle = X_STROKE;
    ctx.font = FONT_SMALL;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(String(nLabel), px + TILE - inset - 6, py + TILE - inset + 14);
  }

  function drawCenteredLabel(x, y, bounds, ore, subText, subColor) {
    const { px, py } = tileToPx(x, y, bounds);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.font = FONT_TITLE;
    ctx.fillStyle = '#d7dde6';
    ctx.fillText(titleCase(ore), px + TILE / 2, py + TILE / 2 - 8);

    ctx.font = FONT_SUB;
    ctx.fillStyle = subColor;
    ctx.fillText(subText, px + TILE / 2, py + TILE / 2 + 10);
  }

  function render() {
    const bounds = computeBounds();
    setCanvasSize(bounds);

    drawBackground();
    drawGrid(bounds);

    // unresolved => hatch + label on each candidate tile
    for (const v of state.veins) {
      if (v.locked) continue;
      if (v.candidates.size <= 1) continue;

      for (const k of v.candidates) {
        const p = parseXY(k);
        drawHatchRect(p.x, p.y, bounds);
        // show bin label (range) under ore name for band-type veins,
        // and numeric quality under ore name for exact-quality mining lines
        drawCenteredLabel(p.x, p.y, bounds, v.ore, v.binLabel, v.subColor);
      }
    }

    // locked => magenta outline + centered label, no hatch
    for (const v of state.veins) {
      if (!v.locked) continue;
      const { x, y } = v.locked;
      drawLockedOutline(x, y, bounds);
      drawCenteredLabel(x, y, bounds, v.ore, v.binLabel, v.subColor);
    }

    // entry X markers (step locations)
    let i = 1;
    for (const e of state.entries) {
      drawRedX(e.stepX, e.stepY, bounds, i++);
    }
  }

  // -----------------------------
  // UI
  // -----------------------------
  function clearNode(n) { while (n.firstChild) n.removeChild(n.firstChild); }

  function updateLists() {
    clearNode(el.entriesList);
    for (const e of state.entries) {
      const li = document.createElement('li');
      li.textContent = `#${e.n}: stepX=${e.stepX}, stepY=${e.stepY} (${e.obs.length} obs)`;
      el.entriesList.appendChild(li);
    }

    if (el.stats) {
      const locked = state.veins.filter(v => !!v.locked).length;
      const unresolved = state.veins.filter(v => !v.locked && v.candidates.size > 1).length;
      el.stats.textContent = `Entries: ${state.entries.length} | Veins: ${state.veins.length} | Locked: ${locked} | Unresolved: ${unresolved}`;
    }
  }

  function addEntry(stepX, stepY, logText) {
    const obs = parseLogText(logText);

    if (obs.length === 0) {
      alert(
        'No usable shard info found.\n\n' +
        'This parser starts reading only after:\n' +
        ' - "You start to analyse the shard."\n' +
        ' OR\n' +
        ' - "You start to gather fragments of the rock."\n\n' +
        'And then looks for lines like:\n' +
        ' - "trace of utmost quality iron (north of east)."\n' +
        ' - "You would mine <ore> here." + "max quality of 78."'
      );
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

    // clear after add
    el.logText.value = '';
    el.logText.focus();
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

  // wire
  el.addBtn.addEventListener('click', () => {
    const stepX = parseInt(el.stepX.value, 10);
    const stepY = parseInt(el.stepY.value, 10);
    const text = el.logText.value || '';

    if (Number.isNaN(stepX) || Number.isNaN(stepY) || text.trim().length === 0) {
      alert('Please enter Step X, Step Y, and paste log text.');
      return;
    }

    addEntry(stepX, stepY, text);
  });

  if (el.undoBtn) el.undoBtn.addEventListener('click', undoLast);
  el.resetBtn.addEventListener('click', resetAll);

  el.downloadBtn.addEventListener('click', () => {
    const link = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    link.download = `wo_shard_map_${ts}.png`;
    link.href = el.canvas.toDataURL('image/png');
    link.click();
  });

  // initial render so the base grid shows before any entries
  updateLists();
  render();
})();
