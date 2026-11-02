

const G = window.GLIMPSE;
const state = { dataset: "pima", query: null, custom: null, point: null, plane: null,
                rules: {}, view: "everyone", lens: null, fromMap: false };
const RULES_KEY = "glimpse-rules:";

// The map page and the details page share this script. A section a page doesn't have
// renders into a detached element instead.
const detached = {};
const el = (id) => document.getElementById(id) ||
  (detached[id] = detached[id] || document.createElement("div"));
const HAS_MAP = !!document.getElementById("plot-linear");
const HAS_DELTA = !!document.getElementById("plot-delta");
const plotDivs = { linear: el("plot-linear"), mlp: el("plot-mlp") };
const deltaDiv = el("plot-delta");
let plotsReady = false;
let formDataset = null;
let lastScene = null;
let currentUser = null;
let loading = false;
let savedEntries = [];
let panelItems = [];
const PENDING_KEY = "glimpse-pending-save";
const VIEW_KEY = "glimpse-map-view";
const GRAPH_KEY = "glimpse-old-graph";
const AROUND_KEY = "glimpse-map-around";
const LENS_KEY = "glimpse-dev-lens";          // developer option: "eclipse" or unset (PCA)
let sceneSeq = 0;
const DISPUTED_SHARE = 0.15;      // "most disputed" = this share with the widest ranges
let mapView = "both";
let mapStyle = "density";        // "density" (everyone), "classes" (one per class) or "datapoints"
let showDisputed = false;

const pct = (v) => (v * 100).toFixed(0) + "%";
const f3 = (v) => (v == null ? "  n/a" : v.toFixed(3));

function fmtVal(v, integer) {
  if (v == null || isNaN(v)) return "—";
  if (integer) return (Math.round(v) + 0).toLocaleString();
  const a = Math.abs(v);
  if (a >= 1000) return (Math.round(v) + 0).toLocaleString();
  return (Number(v.toFixed(a >= 100 ? 0 : a >= 10 ? 1 : 2)) + 0)
    .toString();
}
const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

const isDark = () => G.isDark();
const pal = () => G.mapColors();

function themeColors() {
  return isDark()
    ? { paper: "#1c2027", plot: "#1c2027", font: "#e6e6ea",
        legendBg: "rgba(28,32,39,0.82)", legendBorder: "#333a45", zero: "#8a8f99" }
    : { paper: "#ffffff", plot: "#ffffff", font: "#222222",
        legendBg: "rgba(255,255,255,0.75)", legendBorder: "#cccccc", zero: "#888888" };
}

document.addEventListener("glimpse-theme", () => {
  if (plotsReady && lastScene) {
    redrawPlots(lastScene);
    renderWays(lastScene);
    renderLegend(lastScene);
  }
});

function polyTraces(lines, color, width, opacity, name, showlegend, dash) {
  const traces = lines.map((ln) => ({
    type: "scatter", mode: "lines", x: ln.x, y: ln.y,
    line: { color, width, dash: dash || "solid" }, opacity, showlegend: false, hoverinfo: "skip",
  }));
  if (showlegend)
    traces.push({ type: "scatter", mode: "lines", x: [null], y: [null],
                  line: { color, width: 3, dash: dash || "solid" }, name, hoverinfo: "skip" });
  return traces;
}

function markerTrace(pt, color, name, symbol, size) {
  return {
    type: "scatter", mode: "markers", x: [pt.x], y: [pt.y],
    marker: { size, color, symbol, opacity: 0.95,
              line: { color: pal().outline, width: 1 } },
    name, showlegend: false,
    hovertemplate: `${name}<extra></extra>`,
  };
}

function buildPanelTraces(scene, which) {
  const panel = scene.panels[which];
  const legend = which === "linear";
  const traces = [];
  const f = panel.field;
  const tc = themeColors(), P = pal();

  traces.push({
    type: "heatmap", x: f.x, y: f.y, z: f.z,
    zmin: 0, zmax: 1, colorscale: P.field, zsmooth: "best",
    opacity: mapStyle === "datapoints" ? 0.6 : P.fieldOpacity, hoverinfo: "none",
    showscale: which === colorbarPanel(),
    colorbar: { title: { text: `chance of ${scene.class_names[1]}`, side: "right",
                         font: { color: tc.font } },
                tickfont: { color: tc.font },
                thickness: 12, len: 0.9, x: 1.02 },
  });

  // The flexible model's lines curl into loops far from the data, where nobody is;
  // draw those stretches faint so they don't compete with the part that matters.
  const fan = which === "mlp" ? splitByPeople(panel.fan, scene, which) : { in: panel.fan, out: [] };
  const worst = which === "mlp" ? splitByPeople(panel.worst, scene, which) : { in: panel.worst, out: [] };
  traces.push(...polyTraces(fan.in, P.fan, 1, 0.18, "other good models", legend));
  traces.push(...polyTraces(fan.out, P.fan, 1, 0.05, "other good models", false));

  if (mapStyle === "datapoints") traces.push(...dotTraces(scene, which, legend));
  else if (mapStyle === "classes") traces.push(...classDensityTraces(scene, which));
  else traces.push(densityTrace(scene, which));

  traces.push(...polyTraces(panel.boundary, P.line, 2.6, 1,
                            "model's line", legend));
  traces.push(...polyTraces(worst.in, P.worst, 2.6, 1, "strictest good model", legend, "dash"));
  traces.push(...polyTraces(worst.out, P.worst, 1.6, 0.3, "strictest good model", false, "dash"));

  const q = scene.query, cf = panel.cfs;
  const qName = q.from_map ? "Person at this spot"
              : q.custom ? "Your values" : `Sample person #${q.id}`;
  traces.push({
    type: "scatter", mode: "markers", x: [q.x], y: [q.y],
    marker: { size: q.custom ? 17 : 15, color: P.you,
              symbol: "star", opacity: 1, line: { color: P.outline, width: 1.2 } },
    name: "person", showlegend: false, customdata: [q.id],
    hovertemplate: `${qName}<extra></extra>`,
  });
  if (quickOk(scene, which))
    traces.push(markerTrace(cf.standard, P.quick, "quick change", "x", 11));
  if (sparseOk(scene, which) && scene.panels[which].metrics.pred_bad)
    traces.push(markerTrace(cf.sparse, P.line, "fewest changes", "diamond", 10));
  if (safeOk(scene, which))
    traces.push(markerTrace(cf.ellice, P.safe, "safe change", "square", 10));
  traces.push({
    type: "scatter", mode: "markers", x: [null], y: [null], name: "what if",
    marker: { size: 16, symbol: "star-open", color: P.whatif, line: { width: 2 } },
    showlegend: false, hovertemplate: "What if<extra></extra>",
  });
  return traces;
}

// Whether the search found a change that convinces every good model. When it
// didn't (it can't, e.g. on Credit with the locked values), nothing is shown as "safe".
const safeOk = (scene, which) => scene.panels[which].metrics.safe_ok !== false;
const quickOk = (scene, which) => scene.panels[which].metrics.quick_ok !== false;
const sparseOk = (scene, which) => scene.panels[which].metrics.sparse_ok !== false;
const kindOk = (scene, which, kind) =>
  ({ safe: safeOk, sparse: sparseOk }[kind] || quickOk)(scene, which);
// The per-value column for a kind: "linear" (safe), "linear_quick", "linear_sparse".
const kindKey = (which, kind) => (kind === "safe" ? which : `${which}_${kind}`);
const KIND_NAME = { quick: "Smallest change", sparse: "Fewest changes", safe: "Holds across models" };
// Where the map's arrow points: the safe change if there is one, else the quick one,
// else nowhere.
const arrowTarget = (scene, which) =>
  safeOk(scene, which) ? scene.panels[which].cfs.ellice
    : quickOk(scene, which) ? scene.panels[which].cfs.standard : null;

// The people on one panel: the shared map, or this model's slice around the person.
function panelPoints(scene, which) {
  const panel = scene.panels[which];
  if (!panel.xy) return scene.points;
  return panel._pts || (panel._pts =
    scene.points.map((p, i) => ({ ...p, x: panel.xy[i][0], y: panel.xy[i][1] })));
}

// The dot map ("old GLIMPSE graph"): one dot per person, with a hover card.
function dotTraces(scene, which, legend) {
  const pts = panelPoints(scene, which);
  const kf = scene.key_features || [];
  const [goodName, badName] = scene.class_names;
  const card = (p) => {
    const vals = kf.map((f, i) =>
      `${G.esc(f.label)} ${fmtVal(p.v[i], f.integer)}${f.unit ? " " + G.esc(f.unit) : ""}`);
    return `<b>${p.p >= 0.5 ? G.esc(badName) : G.esc(goodName)}</b> · ` +
      `${pct(p.p)} chance of ${G.esc(badName)}<br>` +
      `models say ${pct(p.lo)}–${pct(p.hi)}<br>${vals.join(" · ")}`;
  };
  const traces = [];
  const P = pal();
  for (const [c, color, label] of [[0, P.good, goodName], [1, P.bad, badName]]) {
    const sel = pts.filter((p) => p.outcome === c);
    traces.push({
      type: "scatter", mode: "markers",
      x: sel.map((p) => p.x), y: sel.map((p) => p.y),
      customdata: sel.map((p) => p.id), meta: "people", text: sel.map(card),
      marker: { size: 5, color, opacity: 0.8, line: { color: isDark() ? "#111" : "#fff", width: 0.4 } },
      name: label, showlegend: legend,
      hovertemplate: "%{text}<extra></extra>",
    });
  }
  if (showDisputed) {
    const sel = disputed(pts);
    traces.push({
      type: "scatter", mode: "markers", x: sel.map((p) => p.x), y: sel.map((p) => p.y),
      marker: { size: 11, color: "rgba(0,0,0,0)",
                line: { color: isDark() ? "#ffd166" : "#8a5a00", width: 1.6 } },
      name: "most disputed", showlegend: false, hoverinfo: "skip",
    });
  }
  return traces;
}

// The people the models disagree about most: the widest chance ranges.
function disputed(pts) {
  const n = Math.max(1, Math.round(pts.length * DISPUTED_SHARE));
  return [...pts].sort((a, b) => (b.hi - b.lo) - (a.hi - a.lo)).slice(0, n);
}

// The density map: where people are, without showing any one of them.
// A smooth estimate (Gaussian kernel, Scott's bandwidth) on a grid, shaded by how
// many people live inside each band: the darkest band holds the densest 20% of
// people, the outer line 80%. Neutral ink, so it never competes with the blue and
// orange background; see-through outside the bands.
const DENS_GRID = 110;            // grid cells per side
const DENS_BANDS = [0.2, 0.4, 0.6, 0.8];
function densityGrid(scene, which, outcome) {
  const key = `${scene.panels[which].xy ? which : "all"}:${outcome ?? "everyone"}`;
  scene._density = scene._density || {};
  if (scene._density[key]) return scene._density[key];
  const pts = panelPoints(scene, which).filter((p) => outcome == null || p.outcome === outcome);
  if (pts.length < 3) return (scene._density[key] = null);
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const n = xs.length;
  const spread = (v) => {
    const s = [...v].sort((a, b) => a - b), mean = v.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(n - 1, 1));
    const iqr = (quantile(s, 0.75) - quantile(s, 0.25)) / 1.349;
    return Math.max(iqr > 0 ? Math.min(sd, iqr) : sd, 1e-6);
  };
  const scott = Math.pow(n, -1 / 6);
  const hx = spread(xs) * scott, hy = spread(ys) * scott;
  const axis = (v, h) => {
    const lo = Math.min(...v) - 3 * h, hi = Math.max(...v) + 3 * h;
    return Array.from({ length: DENS_GRID }, (_, i) => lo + (hi - lo) * i / (DENS_GRID - 1));
  };
  const gx = axis(xs, hx), gy = axis(ys, hy);
  const dx = gx[1] - gx[0], dy = gy[1] - gy[0];
  const z = gy.map(() => new Float64Array(DENS_GRID));
  // Each person only reaches cells within 3 bandwidths.
  const rx = Math.ceil(3 * hx / dx), ry = Math.ceil(3 * hy / dy);
  for (let k = 0; k < n; k++) {
    const ci = Math.round((xs[k] - gx[0]) / dx), cj = Math.round((ys[k] - gy[0]) / dy);
    for (let j = Math.max(0, cj - ry); j <= Math.min(DENS_GRID - 1, cj + ry); j++) {
      const ey = ((gy[j] - ys[k]) / hy) ** 2;
      for (let i = Math.max(0, ci - rx); i <= Math.min(DENS_GRID - 1, ci + rx); i++)
        z[j][i] += Math.exp(-0.5 * (((gx[i] - xs[k]) / hx) ** 2 + ey));
    }
  }
  // The density at each person, read off the grid, sorted: a cell's "depth" is the
  // share of people living somewhere less crowded than it.
  const at = (x, y) => {
    const fi = (x - gx[0]) / dx, fj = (y - gy[0]) / dy;
    const i = Math.min(DENS_GRID - 2, Math.floor(fi)), j = Math.min(DENS_GRID - 2, Math.floor(fj));
    const a = fi - i, b = fj - j;
    return (1 - a) * (1 - b) * z[j][i] + a * (1 - b) * z[j][i + 1] +
           (1 - a) * b * z[j + 1][i] + a * b * z[j + 1][i + 1];
  };
  const own = xs.map((x, k) => at(x, ys[k])).sort((a, b) => a - b);
  const depth = (v) => {
    let lo = 0, hi = n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (own[m] < v) lo = m + 1; else hi = m; }
    return lo / n;
  };
  scene._density[key] = { x: gx, y: gy, z: z.map((row) => Array.from(row, depth)) };
  return scene._density[key];
}

function densityTrace(scene, which) {
  const c = pal().density;
  const d = densityGrid(scene, which);
  return {
    type: "contour", x: d.x, y: d.y, z: d.z, zmin: 0, zmax: 1,
    contours: { start: DENS_BANDS[0], end: DENS_BANDS[DENS_BANDS.length - 1],
                size: DENS_BANDS[1] - DENS_BANDS[0], coloring: "fill", showlines: true },
    colorscale: [[0, `rgba(${c},0)`], [0.2, `rgba(${c},0)`], [0.2001, `rgba(${c},0.07)`],
                 [0.4, `rgba(${c},0.13)`], [0.6, `rgba(${c},0.19)`], [0.8, `rgba(${c},0.25)`],
                 [1, `rgba(${c},0.25)`]],
    line: { color: `rgba(${c},0.55)`, width: 1, smoothing: 1.3 },
    showscale: false, hoverinfo: "skip", name: "people",
  };
}

// Cut lines into the stretches inside the area where people are (outside the density's
// outer band, i.e. where fewer than 5% of people live) and the stretches outside it.
const PEOPLE_EDGE = 0.05;
function splitByPeople(lines, scene, which) {
  const d = densityGrid(scene, which);
  const out = { in: [], out: [] };
  if (!d) return { in: lines, out: [] };
  const nx = d.x.length, ny = d.y.length, dx = d.x[1] - d.x[0], dy = d.y[1] - d.y[0];
  const inside = (x, y) => {
    const i = Math.round((x - d.x[0]) / dx), j = Math.round((y - d.y[0]) / dy);
    return i >= 0 && j >= 0 && i < nx && j < ny && d.z[j][i] > PEOPLE_EDGE;
  };
  for (const ln of lines) {
    let cur = null, curIn = null;
    for (let k = 0; k < ln.x.length; k++) {
      const here = inside(ln.x[k], ln.y[k]);
      if (cur && here !== curIn) {           // close the stretch, sharing the joint point
        cur.x.push(ln.x[k]); cur.y.push(ln.y[k]);
        (curIn ? out.in : out.out).push(cur);
        cur = null;
      }
      if (!cur) { cur = { x: [], y: [] }; curIn = here; if (k) { cur.x.push(ln.x[k - 1]); cur.y.push(ln.y[k - 1]); } }
      cur.x.push(ln.x[k]); cur.y.push(ln.y[k]);
    }
    if (cur && cur.x.length > 1) (curIn ? out.in : out.out).push(cur);
  }
  return out;
}

// Density per class: where the people of each outcome are, in that outcome's colour.
// Same bands as above, but within each group: the darkest band holds the group's most
// crowded 20%, the outer line 80%. Drawn mostly as lines so the two groups can overlap.
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(",");
function classDensityTraces(scene, which) {
  const P = pal();
  return [[0, P.good], [1, P.bad]].map(([outcome, color]) => {
    const d = densityGrid(scene, which, outcome);
    if (!d) return null;
    const c = rgbOf(color);
    return {
      type: "contour", x: d.x, y: d.y, z: d.z, zmin: 0, zmax: 1,
      contours: { start: DENS_BANDS[0], end: DENS_BANDS[DENS_BANDS.length - 1],
                  size: DENS_BANDS[1] - DENS_BANDS[0], coloring: "fill", showlines: true },
      colorscale: [[0, `rgba(${c},0)`], [0.2, `rgba(${c},0)`], [0.2001, `rgba(${c},0.06)`],
                   [0.4, `rgba(${c},0.11)`], [0.6, `rgba(${c},0.16)`], [0.8, `rgba(${c},0.22)`],
                   [1, `rgba(${c},0.22)`]],
      line: { color: `rgba(${c},0.95)`, width: 1.3, smoothing: 1.3 },
      showscale: false, hoverinfo: "skip", name: `outcome ${outcome}`,
    };
  }).filter(Boolean);
}

// Axis ranges. Both axes use constrain "domain", so Plotly keeps equal scale by
// shrinking the plot area, never by changing these ranges. A map click keeps the
// current view: the star lands under the pointer and the map does not shift.
function viewRanges(div, scene, which) {
  // An "around" map is rebuilt for each person, so it is always framed afresh.
  const fl = div._fullLayout, key = `${scene.dataset}:${scene.view}:${scene.lens.key}`;
  if (scene.view !== "around" && scene.query.from_map && fl && fl.xaxis &&
      div.dataset.view === key)
    return [fl.xaxis.range.slice(), fl.yaxis.range.slice()];
  div.dataset.view = key;
  return defaultRanges(scene, which);
}

// The starting view frames where most people are (2nd to 98th percentile), so a
// few extreme people don't squeeze everyone into a corner; you and your change
// are always in view.
const FRAME_PCT = 0.02;
function quantile(sorted, f) {
  const i = (sorted.length - 1) * f, lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo);
}
function defaultRanges(scene, which) {
  const q = scene.query, to = arrowTarget(scene, which) || q, pts = panelPoints(scene, which);
  const px = pts.map((p) => p.x).sort((a, b) => a - b);
  const py = pts.map((p) => p.y).sort((a, b) => a - b);
  const xs = [quantile(px, FRAME_PCT), quantile(px, 1 - FRAME_PCT), q.x, to.x];
  const ys = [quantile(py, FRAME_PCT), quantile(py, 1 - FRAME_PCT), q.y, to.y];
  const grow = (lo, hi) => [lo - 0.08 * (hi - lo), hi + 0.08 * (hi - lo)];
  return [grow(Math.min(...xs), Math.max(...xs)), grow(Math.min(...ys), Math.max(...ys))];
}

function panelLayout(scene, which) {
  const q = scene.query, cf = scene.panels[which].cfs;
  const [xr, yr] = viewRanges(plotDivs[which], scene, which);
  const tc = themeColors(), around = scene.view === "around";
  scene._rev = scene._rev || ++sceneSeq;
  return {
    paper_bgcolor: tc.paper, plot_bgcolor: tc.plot, font: { color: tc.font },
    margin: { l: 8, r: which === "mlp" ? 4 : 10, t: 6, b: around ? 24 : 8 },
    xaxis: { showticklabels: false, ticks: "", range: xr, zeroline: false, constrain: "domain",
             color: tc.font,
             title: around ? { text: "toward the suggested change →", standoff: 4,
                               font: { size: 11, color: tc.font } } : undefined },
    yaxis: { showticklabels: false, ticks: "", range: yr, zeroline: false, constrain: "domain",
             scaleanchor: "x", scaleratio: 1, color: tc.font },
    legend: { x: 0.02, y: 0.98, bgcolor: tc.legendBg,
              font: { size: 10, color: tc.font }, bordercolor: tc.legendBorder,
              borderwidth: 1 },
    showlegend: false, hovermode: "closest",
    // a dot is only picked when the pointer is on it; anywhere else is a spot
    hoverdistance: DOT_PX,
    // keep the user's zoom while clicking around the same dataset; an "around" map
    // is new for each person
    uirevision: around ? `around:${scene._rev}` : `${scene.dataset}:${scene.lens.key}`,
    annotations: arrowTarget(scene, which) ? [{
      x: arrowTarget(scene, which).x, y: arrowTarget(scene, which).y, ax: q.x, ay: q.y,
      xref: "x", yref: "y", axref: "x", ayref: "y",
      showarrow: true, arrowhead: 3, arrowsize: 1.2, arrowwidth: 1.6,
      arrowcolor: pal().arrow, opacity: 0.9, text: "",
    }] : [],
  };
}

function deltaTraces(scene) {
  const rows = [...scene.deltas].sort((a, b) =>
    Math.max(Math.abs(b.linear.delta_std), Math.abs(b.mlp.delta_std)) -
    Math.max(Math.abs(a.linear.delta_std), Math.abs(a.mlp.delta_std)))
    .slice(0, 12).reverse();

  const label = (r) => (r.missing ? r.label + " ✱" : r.label);
  const P = pal();
  const mk = (which, color, name) => ({
    type: "bar", orientation: "h", name,
    y: rows.map(label), x: rows.map((r) => r[which].delta_std),
    marker: { color: rows.map((r) => (r.immutable ? P.immutable : color)),
              pattern: { shape: rows.map((r) => (r.immutable ? "/" : "")), size: 6 },
              opacity: 0.9 },
    customdata: rows.map((r) => [
      fmtVal(r.x0_real, r.integer), fmtVal(r[which].cf_real, r.integer),
      Math.round(r.pct_x0), Math.round(r[which].pct_cf),
      r.immutable ? " · can't change" : "",
    ]),
    hovertemplate:
      "%{y}: %{customdata[0]} → %{customdata[1]}<br>" +
      "rank %{customdata[2]}% → %{customdata[3]}%{customdata[4]}" +
      "<extra>" + name + "</extra>",
  });
  return [mk("linear", P.deltaLin, "simple model"),
          mk("mlp", P.deltaMlp, "flexible model")];
}

function deltaLayout() {
  const tc = themeColors();
  return {
    paper_bgcolor: tc.paper, plot_bgcolor: tc.plot, font: { color: tc.font },
    margin: { l: 190, r: 20, t: 8, b: 40 }, barmode: "group",
    xaxis: { title: "size of change (standardized)", color: tc.font,
             zeroline: true, zerolinecolor: tc.zero, zerolinewidth: 1.5 },
    yaxis: { automargin: true, color: tc.font },
    legend: { x: 0.99, y: 0.02, xanchor: "right",
              bgcolor: tc.legendBg, bordercolor: tc.legendBorder,
              borderwidth: 1, font: { size: 11, color: tc.font } },
  };
}

function renderLensNote(scene) {
  const L = scene.lens, q = L.quality;
  if (scene.view === "around") {
    el("lens-note").innerHTML = `<b>Around this person:</b> each model's map is a flat slice ` +
      `through the person that holds both of its suggested changes. Distances from ★ to ✕ ` +
      `and ▪ are true distances, and the colours and lines are the models' exact answers on ` +
      `the slice. <span class="sub">Other people are placed by how they differ from this ` +
      `person along the slice.</span>`;
    return;
  }
  el("lens-note").innerHTML =
    `<b>${L.label} map:</b> ${L.blurb} ` +
    `<span class="sub">Keeps who-is-near-whom about ` +
    `<b>${Math.round(q.trust * 100)}%</b> faithful` +
    `${L.is_linear ? " and is exactly reversible" : ""}.</span>`;
}

function renderLegend(scene) {
  const [g, b] = scene.class_names, P = pal();
  const people = mapStyle === "datapoints"
    ? `<li><span class="dot" style="background:${P.good}"></span> ${G.esc(g)}` +
      ` <span class="dot" style="background:${P.bad}"></span> ${G.esc(b)}</li>`
    : mapStyle === "classes"
    ? `<li><span class="sw ring" style="color:${P.good}"></span> ${G.esc(g)} people` +
      ` <span class="sw ring" style="color:${P.bad}"></span> ${G.esc(b)} people ` +
      `${G.tip("Each colour shows where the people with that outcome are. Within each group, " +
        "the darkest band holds its most crowded 20%; the outer line holds 80%.")}</li>`
    : `<li><span class="sw" style="background:rgba(${P.density},0.25)"></span> Many people ` +
      `${G.tip("Shading shows where people are. The darkest band holds the most crowded 20% of people; " +
        "each lighter band adds another 20%, and the outer line holds 80%.")}</li>`;
  el("legend").innerHTML = [
    `<li><span class="sw" style="background:${P.field[0][1]}"></span> ${G.esc(g)} side` +
      ` <span class="sw" style="background:${P.field[4][1]}"></span> ${G.esc(b)} side</li>`,
    people,
    `<li><span class="sw line" style="background:${P.line}"></span> Model’s line</li>`,
    `<li><span class="sw line" style="background:${P.fan}"></span> Other good models</li>`,
    `<li><span class="sw line dash" style="color:${P.worst}"></span> Strictest model (dashed)</li>`,
    `<li>★ This person · ✕ Smallest change · ◆ Fewest changes · ▪ Holds across models</li>`,
    `<li>${G.tip("Background: the simple model’s chance of " + b + ". " +
      "Line: where it flips. Other good models: models that fit the data about as well. " +
      "Strictest: the good model hardest to convince at the ▪ change (the ▪ sits just " +
      "past its line). Smallest change: least total change for this " +
      "model. Fewest changes: touches as few values as possible. Holds across models: " +
      "flips every good model. All of these are changes to the numbers the models see, " +
      "not advice.")}</li>`,
    `<li><a href="/tutorial.html#map">How to read the map</a></li>`,
  ].join("");
}

// Whose numbers these are: a real record from the data, values someone typed, or a
// spot on the map.
function whoLine(q) {
  if (q.from_map) return "A spot on the map · an estimated person, not a real record";
  if (q.custom) return "Your entered values";
  return `Sample person #${q.id} · a real record from the data`;
}

// What went in: how many values were typed vs filled in, and which typed ones the
// models never saw anything like.
function inputsNote(scene) {
  const q = scene.query;
  if (q.from_map)
    return q.impossible && q.impossible.length
      ? `<span class="warn">No real person has these values: ${q.impossible.map(G.esc).join(", ")}.</span>`
      : "";
  if (!q.custom) return "";
  const items = displayRows(scene);
  const typed = items.filter((it) => !(it.kind === "group" ? it.missing : it.r.missing)).length;
  const filled = items.length - typed;
  let note = `You entered ${typed} of ${items.length} values.` +
    (filled ? ` The other ${filled} use typical values (✱ in the details).` : "");
  if (q.outside && q.outside.length)
    note += ` <span class="warn">Outside what the models learned from: ` +
      `${q.outside.map(G.esc).join(", ")}. Treat this result with extra caution.</span>`;
  return note;
}

function renderVerdict(scene) {
  const q = scene.query;
  el("verdict-who").textContent = whoLine(q);
  const [goodName, badName] = scene.class_names;
  const lm = scene.panels.linear.metrics;
  const predName = lm.pred_bad ? badName : goodName;
  el("verdict").className = lm.pred_bad ? "bad" : "good";
  const topic = G.TOPICS[state.dataset] || {};
  el("verdict-inputs").innerHTML = inputsNote(scene);
  el("verdict-inputs").hidden = !el("verdict-inputs").innerHTML;
  el("verdict-limits").innerHTML = `Research demo: a prediction from models trained on ` +
    `${G.esc(topic.source || "one public dataset")}. ${G.esc(topic.limit || "Not advice.")} ` +
    `<a href="/tutorial.html#limits">Limits</a>`;

  const close = lm.p_bad_best_x0 < 0.5 && lm.p_bad_worst_x0 > 0.5;
  el("verdict-headline").innerHTML =
    `<span class="vlead">Model prediction</span>` +
    `<span class="vhead">${G.esc(predName)}</span>` +
    `<span class="badge ${close ? "close" : "clear"}">` +
    `${close ? "⚠ Close call · models disagree" : "✓ Clear · models agree"}</span>`;

  clearSummary();
  el("verdict-models").innerHTML = ["linear", "mlp"].map((which) => {
    const m = scene.panels[which].metrics;
    const name = which === "linear" ? "Simple model" : "Flexible model";
    const lo = Math.round(m.p_bad_best_x0 * 100);
    const hi = Math.round(m.p_bad_worst_x0 * 100);
    const erm = Math.round(m.p_bad_erm_x0 * 100);
    const side = m.pred_bad ? badName : goodName;
    return `<div class="vmodel ${m.pred_bad ? "bad" : "good"}">
      <div class="vlabel">${name} predicts</div>
      <div class="vpred">${G.esc(side)}</div>
      <div class="vrange"><b class="vchance">${erm}%</b> chance of ${G.esc(badName)}
        ${G.tip(`The dot is the best guess. The shaded band is what other models that ` +
          `fit the data about as well say. If the band crosses 50%, they disagree.`, "right")}</div>
      <div class="vothers sub">Other good models: ${lo}–${hi}%</div>
      ${G.rangeBar(lo, hi, erm, goodName, badName)}
    </div>`;
  }).join("");
}

// ---- plain-language summary, written on demand by a small Hugging Face model. Where
// the model isn't installed (the hosted site), the server answers from the page's own
// wording and a few fixed explanations, and the page says so up front.

let summarySeq = 0;
let summaryAI = null;          // null until known; false: built-in answers only

async function checkSummaryAI() {
  const note = document.getElementById("ask-note");
  if (!note) return;
  try { summaryAI = (await (await fetch("/api/summarize")).json()).ai === true; }
  catch (e) { summaryAI = false; }
  note.textContent = summaryAI
    ? "Answers are written by a small AI model from the numbers on this page."
    : "The AI model isn’t available on this site, so answers come from GLIMPSE’s built-in " +
      "explanations and the numbers on this page.";
}

function clearSummary() {
  summarySeq++;
  const btn = document.getElementById("summarize-btn");
  const ask = document.getElementById("ask-btn");
  const log = document.getElementById("ask-log");
  const input = document.getElementById("ask-input");
  if (btn) { btn.disabled = false; btn.textContent = "Summarize"; }
  if (ask) { ask.disabled = false; ask.textContent = "Ask"; }
  if (log) { log.replaceChildren(); log.hidden = true; }
  if (input) input.value = "";
}

function startTurn(question) {
  const log = document.getElementById("ask-log");
  if (!log) return null;
  log.hidden = false;
  const item = document.createElement("div");
  item.className = "ask-turn";
  if (question) {
    const q = document.createElement("p");
    q.className = "ask-q";
    q.textContent = question;
    item.appendChild(q);
  }
  const answer = document.createElement("p");
  answer.className = "summary-text";
  answer.textContent = summaryAI === false ? "…"
    : "Loading a small model. The first time can take a minute.";
  const note = document.createElement("p");
  note.className = "sub";
  note.hidden = true;
  item.append(answer, note);
  log.appendChild(item);
  return { answer, note };
}

function setAskBusy(busy, label) {
  const btn = document.getElementById("summarize-btn");
  const ask = document.getElementById("ask-btn");
  if (btn) { btn.disabled = busy; if (!busy) btn.textContent = "Summarize"; }
  if (ask) { ask.disabled = busy; if (!busy) ask.textContent = "Ask"; }
  if (busy && label === "Summarizing…" && btn) btn.textContent = label;
  if (busy && label === "Asking…" && ask) ask.textContent = label;
}

function resultBrief(scene) {
  const [goodName, badName] = scene.class_names;
  const q = scene.query;
  const who = q.from_map ? "An estimated person at this map spot"
            : q.custom ? "Your entered values" : `Sample person ${q.id}`;
  const models = ["linear", "mlp"].map((which) => {
    const m = scene.panels[which].metrics;
    const name = which === "linear" ? "The simple model" : "The flexible model";
    const side = m.pred_bad ? badName : goodName;
    const chance = Math.round(m.p_bad_erm_x0 * 100);
    const lo = Math.round(m.p_bad_best_x0 * 100);
    const hi = Math.round(m.p_bad_worst_x0 * 100);
    return `${name} predicts ${side}, with a ${chance}% chance of ${badName}; ` +
      `other good models of its kind range from ${lo}% to ${hi}%.`;
  }).join(" ");
  const lm = scene.panels.linear.metrics;
  const close = lm.p_bad_best_x0 < 0.5 && lm.p_bad_worst_x0 > 0.5;
  const agree = close
    ? "The good models disagree, so this is a close call."
    : "The good models agree.";
  const rows = (scene.drivers && scene.drivers.linear && scene.drivers.linear.rows) || [];
  const drivers = rows.filter((r) => Math.abs(r.push) > 0.005).slice(0, 3).map((r) => r.label);
  const drove = drivers.length
    ? ` The values that push the simple model most are ${drivers.join(", ")}.` : "";
  let change = "";
  if (!lm.pred_bad)
    change = ` The simple model already predicts ${goodName}.`;
  else if (kindOk(scene, "linear", "quick")) {
    const bits = topChanges(scene, "linear", "quick", 3).map((c) =>
      `${c.label} from ${c.before} to ${c.after}${c.unit ? " " + c.unit : ""}`);
    if (bits.length)
      change = " The smallest change that would flip the simple model moves " + bits.join(", ") +
        ". That describes the model, not advice.";
  }
  return `${who}. ${models} ${agree}${drove}${change}`;
}

async function askModel(question) {
  if (!lastScene) return;
  const seq = ++summarySeq;
  const turn = startTurn(question);
  if (!turn) return;
  setAskBusy(true, question ? "Asking…" : "Summarizing…");
  try {
    const resp = await fetch("/api/summarize", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(question
        ? { text: resultBrief(lastScene), question }
        : { text: resultBrief(lastScene) }),
    });
    const body = await resp.json();
    if (seq !== summarySeq) return;
    if (!resp.ok) throw new Error(body.error || "request failed");
    turn.answer.textContent = body.summary;
    turn.note.hidden = false;
    turn.note.textContent = {
      model: `Written by ${body.model}. Research summary only.`,
      page: "Taken from the numbers on this page.",
      "built-in": "A built-in explanation, not written by an AI model.",
    }[body.source] || "The model’s answer was left out because it did not stay with the " +
      "numbers on this page.";
    if (question) {
      const input = document.getElementById("ask-input");
      if (input) input.value = "";
    }
  } catch (e) {
    if (seq !== summarySeq) return;
    turn.answer.textContent = e.message || "Couldn’t answer. Try again.";
  } finally {
    if (seq === summarySeq) setAskBusy(false);
  }
}
const summarizeBtn = document.getElementById("summarize-btn");
if (summarizeBtn) summarizeBtn.addEventListener("click", () => askModel(""));
const askForm = document.getElementById("ask-form");
if (askForm) askForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = (document.getElementById("ask-input").value || "").trim();
  if (q) askModel(q);
});

// You vs everyone: where each value sits among all people in the data.
let compareAll = false;
function renderCompare(scene) {
  const rank = new Map((scene.importance || []).map((n, i) => [n, i]));
  const rows = scene.deltas.filter((r) => !r.group)
    .sort((a, b) => (rank.get(a.name) ?? 1e9) - (rank.get(b.name) ?? 1e9));
  const shown = compareAll ? rows : rows.slice(0, 6);
  const q = scene.query;
  const who = q.custom || q.from_map ? "You" : "This person";
  const title = el("compare-h").firstChild;
  if (title) title.textContent = q.from_map ? "How this spot compares " :
    q.custom ? "How you compare " : "How this person compares ";
  el("compare-list").innerHTML = shown.map((r) => {
    const pctl = Math.round(r.pct_x0);
    const where = pctl >= 50 ? `higher than ${pctl}%` : `lower than ${100 - pctl}%`;
    const unit = r.unit ? " " + G.esc(r.unit) : "";
    return `<li class="cmp${r.immutable ? " cmp-fixed" : ""}">
      <div class="cmp-top"><span class="cmp-name">${G.esc(r.label)}` +
      `${r.immutable ? " " + G.LOCK : ""}${ONE_WAY[r.rule] || ""}` +
      `${r.missing ? ' <span class="miss-mark" title="typical value used">✱</span>' : ""}</span>
        <span class="cmp-val">${fmtVal(r.x0_real, r.integer)}${unit}</span></div>
      <div class="cmp-bar" role="img" aria-label="${G.esc(r.label)}: ${where} of people">
        <i style="left:${Math.min(98, Math.max(0, pctl))}%"></i></div>
      <div class="cmp-txt sub">${where} of people</div></li>`;
  }).join("");
  const more = el("compare-more");
  more.hidden = rows.length <= 6;
  more.textContent = compareAll ? "Show fewer" : `Show all ${rows.length}`;
  el("compare").dataset.who = who;
}
el("compare-more").addEventListener("click", () => {
  compareAll = !compareAll;
  if (lastScene) renderCompare(lastScene);
});

// ---- what would change it: smallest / fewest / holds-across-models tabs, change cards,
// what-if, plan

let recoKind = "quick";     // "quick" smallest / "sparse" fewest values: this model; "safe": every good model
const SMALL_SHIFT = 20;     // percentile points; a smaller move among people is a "small shift"

// The top changes for one model: [{row or group, before, after, unit, shift}].
function topChanges(scene, which, kind, n) {
  const key = kindKey(which, kind);
  const items = [];
  for (const it of displayRows(scene)) {
    if (it.kind === "group") {
      if (it.immutable) continue;
      const members = scene.deltas.filter((x) => x.group && x.group_label === it.label);
      const after = members.find((x) => x[key].cf_real >= 0.5);
      const cat = after ? after.value_label : "none";
      if (cat === it.youCat) continue;
      items.push({ label: it.label, before: it.youCat, after: cat, unit: "", shift: 50,
                   mag: Math.max(...members.map((x) => Math.abs(x[key].delta_std))), group: true });
      continue;
    }
    const r = it.r, d = r[key];
    if (r.immutable || Math.abs(d.delta_std) <= 0.05) continue;
    // A change too small to show (e.g. 1.3 inquiries shown as 1) says nothing.
    if (fmtVal(r.x0_real, r.integer) === fmtVal(d.cf_real, r.integer)) continue;
    items.push({ name: r.name, label: r.label, unit: r.unit || "", integer: r.integer,
                 before: fmtVal(r.x0_real, r.integer), after: fmtVal(d.cf_real, r.integer),
                 afterValue: d.cf_real, up: d.delta_real > 0,
                 shift: Math.abs(d.pct_cf - r.pct_x0), mag: Math.abs(d.delta_std) });
  }
  return items.sort((a, b) => b.mag - a.mag).slice(0, n);
}

// How far a change moves the value among the people in the data. It says nothing about
// how hard the change is, or whether a person can make it.
function shiftBadge(c) {
  if (c.group) return "";
  const n = Math.round(c.shift), small = c.shift <= SMALL_SHIFT;
  const what = `Moves this value past ${n}% of the people in the data. This measures ` +
    `how unusual the new value is, not how hard it is to change or whether it can be changed.`;
  return `<span class="effort ${small ? "easy" : "hard"}" title="${G.esc(what)}">` +
    `${small ? "small shift" : "large shift"}<span class="sr-only">: ${G.esc(what)}</span></span>`;
}

function changeCard(c) {
  const arrow = c.group ? "→" : c.up ? "▲" : "▼";
  return `<li class="chg-card">
    <div class="chg-top"><span class="chg-arrow ${c.group ? "" : c.up ? "up" : "down"}"
      aria-hidden="true">${arrow}</span><b>${G.esc(c.label)}</b>
      ${shiftBadge(c)}</div>
    <div class="chg-vals">${G.esc(c.before)} → <b>${G.esc(c.after)}</b>
      ${c.unit ? `<span class="sub">${G.esc(c.unit)}</span>` : ""}</div></li>`;
}

function renderRecommend(scene) {
  const [goodName] = scene.class_names;
  renderRules(scene);
  for (const t of document.querySelectorAll(".reco-tabs [role=tab]"))
    t.setAttribute("aria-selected", String(t.dataset.kind === recoKind));

  el("reco-lists").innerHTML = ["linear", "mlp"].map((which) => {
    const m = scene.panels[which].metrics;
    const name = which === "linear" ? "Simple model" : "Flexible model";
    if (!m.pred_bad)
      return `<div class="reco-col"><div class="reco-h">${name}</div>
        <p class="reco-ok">✓ This model already predicts ${G.esc(goodName)}.</p></div>`;
    if (!kindOk(scene, which, recoKind))
      return `<div class="reco-col"><div class="reco-h">${name}</div>
        <p class="reco-none">${recoKind === "safe"
          ? `No change within the allowed values flips every good model.
             <button type="button" class="link-btn" data-kind="quick">See the smallest change</button>`
          : "No change within realistic values flips this model."}</p></div>`;
    const cards = topChanges(scene, which, recoKind, 3);
    return `<div class="reco-col"><div class="reco-h">${name}</div>
      <ul class="chg-cards">${cards.map(changeCard).join("") ||
        "<li class='sub'>No single change is enough.</li>"}</ul></div>`;
  }).join("");
  renderPlan(scene);
}

function setRecoKind(kind) {
  recoKind = kind;
  if (lastScene) {
    renderRecommend(lastScene);
    renderChanges(lastScene);
  }
}
// ---- three ways to change it (map page): smallest, fewest values, safest

let waysModel = "linear";

function renderWays(scene) {
  if (!document.getElementById("ways-list")) return;
  const which = waysModel, m = scene.panels[which].metrics;
  const [goodName, badName] = scene.class_names;
  for (const b of el("ways-toggle").querySelectorAll("button"))
    b.setAttribute("aria-pressed", String(b.dataset.model === which));
  if (!m.pred_bad) {
    el("ways-list").innerHTML = `<li class="way-ok">✓ This model already predicts ` +
      `${G.esc(goodName)}.</li>`;
    return;
  }
  const values = (n) => `${n} value${n === 1 ? "" : "s"}`;
  const ways = [
    { kind: "quick", icon: "✕", what: (n) => `Least total change · ${values(n)}`, after: m.p_bad_quick },
    { kind: "sparse", icon: "◆", what: (n) => `Changes only ${values(n)}` +
        (m.sparse_safe ? " · also flips every good model" : ""), after: m.p_bad_sparse },
    { kind: "safe", icon: "▪", what: (n) => `Flips every good model, not just this one · ${values(n)}`,
      after: m.p_bad_erm_cf },
  ];
  el("ways-list").innerHTML = ways.map((w) => {
    const head = `<div class="way-top"><span class="way-ico" aria-hidden="true">${w.icon}</span>` +
      `<b>${KIND_NAME[w.kind]}</b>`;
    if (!kindOk(scene, which, w.kind))
      return `<li class="way">${head}</div>
        <div class="sub">None found with what you can change.</div></li>`;
    const all = topChanges(scene, which, w.kind, 99);
    const lines = all.slice(0, 3).map((c) => `${G.esc(c.label)} ${G.esc(c.before)} → ` +
      `<b>${G.esc(c.after)}</b>${c.unit ? ` <span class="sub">${G.esc(c.unit)}</span>` : ""}`);
    return `<li class="way">${head}
        <span class="way-after" title="Chance of ${G.esc(badName)} after this change">→ ${pct(w.after)}</span></div>
      <div class="way-what sub">${w.what(all.length)}</div>
      <div class="way-vals">${lines.join("<br>") || "<span class='sub'>Changes too small to show.</span>"}` +
      `${all.length > 3 ? ` <span class="sub">+${all.length - 3} more</span>` : ""}</div></li>`;
  }).join("");
}
el("ways-toggle").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-model]");
  if (!b || !lastScene) return;
  waysModel = b.dataset.model;
  renderWays(lastScene);
});
el("ways-tip").innerHTML = G.tip("Smallest: the least total change. Fewest changes: touches as " +
  "few values as possible. Holds across models: flips every model that fits the data about as " +
  "well. The % is the model's chance after the change. Values you can't change are never " +
  "touched. These describe the models, not what would happen in real life.", "right");

// ---- what drove it: how much each value pushes this prediction, compared with an
// average person, with the range across the good models

const DRIVERS_SHOWN = 5;
let driversModel = "linear", driversAll = false;

function renderDrivers(scene) {
  const d = scene.drivers && scene.drivers[driversModel];
  if (!d) return;
  const [goodName, badName] = scene.class_names;
  const byName = new Map(scene.deltas.map((r) => [r.name, r]));
  const rows = d.rows.filter((r) => Math.abs(r.push) > 0.005 || r.hi - r.lo > 0.01);
  const shown = driversAll ? rows : rows.slice(0, DRIVERS_SHOWN);
  const scale = Math.max(1e-6, ...shown.map((r) => Math.max(Math.abs(r.lo), Math.abs(r.hi))));
  const at = (v) => 50 + 50 * v / scale;            // % across the bar; 50 = no push
  el("drivers-list").innerHTML = shown.map((r) => {
    const v = byName.get(r.name) || {};
    const toBad = r.push > 0, split = r.lo < 0 && r.hi > 0;
    const side = toBad ? `▲ toward ${G.esc(badName)}` : `▼ toward ${G.esc(goodName)}`;
    const mark = v.rule === "fixed" ? " " + G.LOCK : ONE_WAY[v.rule] || "";
    const label = `${r.label}: pushes toward ${toBad ? badName : goodName}` +
      (split ? "; good models disagree on the direction" : "");
    return `<li class="drv">
      <div class="drv-top"><span class="drv-name">${G.esc(r.label)}${mark}</span>
        <span class="drv-val">${v.x0_real == null ? "" : fmtVal(v.x0_real, v.integer)}` +
        `${v.unit ? " " + G.esc(v.unit) : ""}</span></div>
      <div class="drv-track" role="img" aria-label="${G.esc(label)}"
           title="score ${r.push > 0 ? "+" : ""}${r.push.toFixed(2)} (good models: ${r.lo.toFixed(2)} to ${r.hi.toFixed(2)})">
        <span class="drv-mid"></span>
        <span class="drv-bar ${toBad ? "bad" : "good"}"
              style="left:${Math.min(at(0), at(r.push))}%;width:${Math.max(Math.abs(at(r.push) - 50), 0.6)}%"></span>
        <span class="drv-range" style="left:${at(r.lo)}%;width:${at(r.hi) - at(r.lo)}%"></span>
      </div>
      <div class="drv-note sub">${side}` +
        `${split ? ' <span class="drv-split" title="Some good models say this value pushes the other way">models disagree</span>' : ""}</div></li>`;
  }).join("");
  const more = el("drivers-more");
  more.hidden = rows.length <= DRIVERS_SHOWN;
  more.textContent = driversAll ? "Show fewer" : `Show all ${rows.length}`;
  for (const b of el("drivers-toggle").querySelectorAll("button"))
    b.setAttribute("aria-pressed", String(b.dataset.model === driversModel));
}
el("drivers-toggle").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-model]");
  if (!b || !lastScene) return;
  driversModel = b.dataset.model;
  renderDrivers(lastScene);
});
el("drivers-more").addEventListener("click", () => {
  driversAll = !driversAll;
  if (lastScene) renderDrivers(lastScene);
});
el("drivers-tip").innerHTML = G.tip("Compared with an average person: how much each value " +
  "pushes the model toward one answer. The thin line shows what the other good models say; " +
  "when it crosses the middle, good models disagree on which way that value pushes.", "right");

// ---- what can you change: free / only up / only down / can't change, per value

const RULE_TEXT = { free: "Free", up: "Only up", down: "Only down", fixed: "Can’t change" };
const RULE_ICON = { up: "↑", down: "↓" };
const ONE_WAY = {
  up: ' <span class="one-way" title="Can only go up, so never suggested lower">↑</span>',
  down: ' <span class="one-way" title="Can only go down, so never suggested higher">↓</span>',
};

function ruleChip(r) {
  const icon = r.rule === "fixed" ? G.LOCK : RULE_ICON[r.rule] || "";
  return `<span class="rule-chip rule-${r.rule}">${icon} ${G.esc(r.label)}</span>`;
}

function renderRules(scene) {
  const rows = scene.deltas.filter((r) => !r.group);
  const limited = rows.filter((r) => r.rule !== "free");
  el("rules-summary").innerHTML = limited.length
    ? limited.map(ruleChip).join("") : `<span class="sub">Everything can change</span>`;
  el("rules-list").innerHTML = rows.map((r) => `<label class="rule-row">
      <span class="rule-name">${G.esc(r.label)}</span>
      <select data-name="${G.esc(r.name)}" aria-label="${G.esc(r.label)}: what can change">
        ${Object.entries(RULE_TEXT).map(([k, t]) =>
          `<option value="${k}" ${k === r.rule ? "selected" : ""}>${t}</option>`).join("")}
      </select></label>`).join("");
}

function loadRules() {
  try { state.rules = JSON.parse(localStorage.getItem(RULES_KEY + state.dataset) || "{}"); }
  catch (e) { state.rules = {}; }
}
function saveRules() {
  try { localStorage.setItem(RULES_KEY + state.dataset, JSON.stringify(state.rules)); } catch (e) {}
}

el("rules-list").addEventListener("change", (e) => {
  const sel = e.target.closest("select[data-name]");
  if (!sel || loading) return;
  state.rules[sel.dataset.name] = sel.value;
  saveRules();
  refresh();
});
el("rules-reset").addEventListener("click", () => {
  state.rules = {};
  saveRules();
  refresh();
});
el("rules-tip").innerHTML = G.tip("Tell GLIMPSE what you can change. Suggestions never touch " +
  "“Can’t change” values, and “Only up” / “Only down” values only move that way.", "right");

for (const t of document.querySelectorAll(".reco-tabs [role=tab]"))
  t.addEventListener("click", () => setRecoKind(t.dataset.kind));
el("reco-lists").addEventListener("click", (e) => {
  const b = e.target.closest("[data-kind]");
  if (b) setRecoKind(b.dataset.kind);
});

// The current person's values in real units (blanks filled with typical values).
function personValues(scene) {
  return Object.fromEntries(scene.deltas.map((r) => [r.name, r.x0_real]));
}

async function predict(values) {
  const resp = await fetch("/api/people", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataset: state.dataset, people: [values], lens: state.lens,
                           from_map: state.fromMap }),
  });
  const body = await resp.json();
  if (!resp.ok) throw new Error(body.error || "prediction failed");
  return { person: body.people[0], classNames: body.class_names };
}

function chanceLine(scene, before, after) {
  const bad = G.esc(scene.class_names[1]);
  const b = Math.round(before.p * 100), a = Math.round(after.p * 100);
  const moved = a - b;
  const dir = moved === 0 ? "no change" : `${moved > 0 ? "▲ up" : "▼ down"} ${Math.abs(moved)} points`;
  return `<b>${b}% → ${a}%</b> chance of ${bad} <span class="sub">(${dir} · models say ` +
    `${Math.round(after.lo * 100)}–${Math.round(after.hi * 100)}%)</span>`;
}

// ---- what if: drag a value, the chance and a ghost star update live

let whatifTimer = null, whatifValues = null;

function whatifFeatures(scene) {
  const rank = new Map((scene.importance || []).map((n, i) => [n, i]));
  const meta = new Map(scene.features.map((f) => [f.name, f]));
  return scene.deltas
    .filter((r) => !r.group && !r.immutable && meta.has(r.name))
    // freely changeable values first, then one-way ones (like age), each by importance
    .sort((a, b) => (a.rule !== "free") - (b.rule !== "free") ||
      (rank.get(a.name) ?? 1e9) - (rank.get(b.name) ?? 1e9))
    .slice(0, 4)
    .map((r) => ({ r, f: meta.get(r.name) }));
}

function renderWhatif(scene) {
  whatifValues = personValues(scene);
  el("whatif-sliders").innerHTML = whatifFeatures(scene).map(({ r, f }) => {
    let lo = Math.min(f.p5 ?? f.min, r.x0_real), hi = Math.max(f.p95 ?? f.max, r.x0_real);
    if (r.rule === "up") lo = r.x0_real;          // only up: can't drag below where you are
    if (r.rule === "down") hi = r.x0_real;
    const step = f.integer ? 1 : (hi - lo) / 100;
    return `<div class="wi-row" data-name="${G.esc(r.name)}" data-int="${f.integer}"
      data-min="${f.min}" data-max="${f.max}">
      <span class="wi-name">${G.esc(r.label)}</span>
      <input type="range" min="${lo}" max="${hi}" step="${step}" value="${r.x0_real}"
             aria-label="${G.esc(r.label)} slider">
      <span class="wi-val"><input type="number" class="wi-num" step="${f.integer ? 1 : "any"}"
             value="${fmtVal(r.x0_real, f.integer).replace(/,/g, "")}" aria-label="${G.esc(r.label)} value">
        ${f.unit ? `<span class="sub">${G.esc(f.unit)}</span>` : ""}</span></div>`;
  }).join("");
  el("whatif-result").innerHTML = `<span class="sub">Drag a slider.</span>`;
  moveGhost(null);
}

// Drag a slider or type in the number box; each keeps the other in step.
el("whatif-sliders").addEventListener("input", (e) => {
  const row = e.target.closest(".wi-row");
  if (!row || !lastScene) return;
  const slider = row.querySelector("input[type=range]"), box = row.querySelector(".wi-num");
  const isInt = row.dataset.int === "true";
  let v;
  if (e.target === slider) {
    v = Number(slider.value);
    box.value = fmtVal(v, isInt).replace(/,/g, "");
  } else {
    if (box.value.trim() === "" || !isFinite(Number(box.value))) return;
    v = Number(box.value);
    // A typed value past the slider's ends stretches the slider to fit.
    if (v < Number(slider.min)) slider.min = v;
    if (v > Number(slider.max)) slider.max = v;
    slider.value = v;
  }
  const out = v < Number(row.dataset.min) || v > Number(row.dataset.max);
  box.classList.toggle("out", out);
  box.title = out ? `Outside the data (${row.dataset.min}–${row.dataset.max})` : "";
  whatifValues[row.dataset.name] = isInt ? Math.round(v) : v;
  clearTimeout(whatifTimer);
  whatifTimer = setTimeout(runWhatif, e.target === slider ? 120 : 350);
});
// Enter in a number box updates right away instead of submitting anything.
el("whatif-sliders").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !e.target.classList.contains("wi-num")) return;
  e.preventDefault();
  clearTimeout(whatifTimer);
  runWhatif();
});

async function runWhatif() {
  const scene = lastScene;
  try {
    const { person } = await predict(whatifValues);
    if (scene !== lastScene) return;
    const before = scene.panels.linear.metrics;
    el("whatif-result").innerHTML = "Simple model: " + chanceLine(scene,
      { p: before.p_bad_erm_x0 }, person.linear);
    moveGhost(person);
  } catch (e) {
    el("whatif-result").textContent = e.message || "Couldn’t update. Try again.";
  }
}

// A hollow star on the maps shows where the what-if person would sit.
function moveGhost(person) {
  if (!plotsReady) return;
  for (const [which, div] of Object.entries(plotDivs)) {
    const i = (div.data || []).findIndex((t) => t.name === "what if");
    if (i < 0) continue;
    const at = person && ghostSpot(which, person);
    Plotly.restyle(div, { x: [[at ? at.x : null]], y: [[at ? at.y : null]] }, [i]);
  }
}

// Where a person sits on one panel: their shared-map spot, or projected onto this
// model's "around" slice.
function ghostSpot(which, person) {
  const scene = lastScene, plane = scene && scene.panels[which].plane;
  if (!plane) return person;
  const z = [0, 0];
  scene.deltas.forEach((r, j) => {
    const v = (person.values[r.name] - scene.std.mean[j]) / scene.std.scale[j] - plane.origin[j];
    z[0] += plane.axes[0][j] * v;
    z[1] += plane.axes[1][j] * v;
  });
  return { x: z[0], y: z[1] };
}

el("whatif-reset").addEventListener("click", () => { if (lastScene) renderWhatif(lastScene); });
el("whatif-apply").addEventListener("click", () => {
  if (!whatifValues) return;
  state.custom = { ...whatifValues };
  state.point = null;
  state.fromMap = false;
  restoreForm();
  refresh();
});

// ---- my plan: tick the changes you'll make, see the result, save it

function planKey(scene) {
  const q = scene.query;
  return `glimpse-plan:${state.dataset}:${q.custom ? "you" : q.id}`;
}

function renderPlan(scene) {
  const noSafe = !kindOk(scene, "linear", recoKind);
  const items = scene.panels.linear.metrics.pred_bad && !noSafe
    ? topChanges(scene, "linear", recoKind, 5) : [];
  let ticked = null;
  try { ticked = JSON.parse(localStorage.getItem(planKey(scene)) || "null"); } catch (e) {}
  el("plan-list").innerHTML = items.length ? items.map((c, i) => {
    const on = ticked ? ticked.includes(c.label) : i < 2;
    return `<li><label class="plan-item"><input type="checkbox" data-i="${i}" ${on ? "checked" : ""}>
      <span><b>${G.esc(c.label)}</b> ${G.esc(c.before)} → <b>${G.esc(c.after)}</b>
      ${c.unit ? G.esc(c.unit) : ""}</span></label></li>`;
  }).join("") : `<li class="sub">${noSafe ? (recoKind === "safe"
    ? "No change holds across models for the simple model. Switch to Smallest change to plan."
    : "No realistic change flips the simple model.")
    : "Nothing to plan: already " + G.esc(scene.class_names[0]) + "."}</li>`;
  el("plan-list").dataset.items = JSON.stringify(items);
  el("plan-save").disabled = !items.length;
  el("plan-msg").textContent = "";
  el("plan-compare").hidden = true;
  updatePlan();
}

function planValues() {
  const items = JSON.parse(el("plan-list").dataset.items || "[]");
  const values = personValues(lastScene), picked = [];
  for (const cb of el("plan-list").querySelectorAll("input:checked")) {
    const c = items[+cb.dataset.i];
    picked.push(c.label);
    if (!c.group) values[c.name] = c.integer ? Math.round(c.afterValue) : c.afterValue;
    else for (const r of lastScene.deltas.filter((x) => x.group_label === c.label))
      values[r.name] = r[kindKey("linear", recoKind)].cf_real >= 0.5 ? 1 : 0;
  }
  return { values, picked };
}

let planTimer = null;
function updatePlan() {
  if (!lastScene) return;
  const { picked } = planValues();
  if (el("plan-list").querySelector("input")) {
    try { localStorage.setItem(planKey(lastScene), JSON.stringify(picked)); } catch (e) {}
  }
  if (!picked.length) {
    el("plan-result").innerHTML = el("plan-list").querySelector("input")
      ? `<span class="sub">Tick what you’ll change.</span>` : "";
    return;
  }
  clearTimeout(planTimer);
  planTimer = setTimeout(async () => {
    const scene = lastScene;
    try {
      const { person } = await predict(planValues().values);
      if (scene !== lastScene) return;
      el("plan-result").innerHTML = "With this plan: " + chanceLine(scene,
        { p: scene.panels.linear.metrics.p_bad_erm_x0 }, person.linear);
    } catch (e) {
      el("plan-result").textContent = "Couldn’t update. Try again.";
    }
  }, 120);
}
el("plan-list").addEventListener("change", updatePlan);

el("plan-save").addEventListener("click", async () => {
  if (!lastScene) return;
  const { values, picked } = planValues();
  if (!picked.length) { el("plan-msg").textContent = "Tick at least one change."; return; }
  if (!currentUser) { goSignInToSave(values); return; }
  const when = new Date().toLocaleDateString([], { month: "short", day: "numeric" });
  const resp = await fetch("/api/saved", {
    method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
    body: JSON.stringify({ dataset: state.dataset, name: `Plan, ${when}`, values }),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) { el("plan-msg").textContent = body.error || "Couldn’t save the plan."; return; }
  el("plan-msg").textContent = `Saved “${body.saved.name}”.`;
  el("plan-compare").href = `/compare.html?dataset=${encodeURIComponent(state.dataset)}` +
    `&you=${handoff(lastScene)}&b=${body.saved.id}`;
  el("plan-compare").hidden = false;
  refreshSaved();
});

// Entered values go to the next page through this tab's own storage, never the address,
// so they stay out of browser history and copied links. The link says ?you=tab.
const HANDOFF_KEY = "glimpse-you";
function handoff(scene) {
  // Typed values go as typed, so blanks stay blanks (and are counted as filled in).
  const values = scene.query.custom && state.custom ? state.custom : personValues(scene);
  try {
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({
      dataset: state.dataset, values, fromMap: !!scene.query.from_map }));
  } catch (e) {}
  return "tab";
}
function takeHandoff() {
  try { return JSON.parse(sessionStorage.getItem(HANDOFF_KEY) || "null"); } catch (e) { return null; }
}

// Build rows for the counterfactual comparison.
function displayRows(scene) {
  const items = [], seen = {};
  for (const r of scene.deltas) {
    if (r.group) {
      if (!seen[r.group]) {
        const members = scene.deltas.filter((x) => x.group === r.group);
        const g = groupRow(r.group_label, members);
        seen[r.group] = g;
        items.push(g);
      }
    } else {
      items.push({ kind: "plain", r,
        key: Math.max(Math.abs(r.linear.delta_std), Math.abs(r.mlp.delta_std)) });
    }
  }
  return items;
}

function groupRow(label, members) {
  const active = (val) => {
    const m = members.find((x) => val(x) >= 0.5);
    return m ? m.value_label : "none";
  };
  const youCat = active((x) => x.x0_real);
  const per = {};
  for (const which of ["linear", "mlp", "linear_quick", "mlp_quick", "linear_sparse", "mlp_sparse"]) {
    const cat = active((x) => x[which].cf_real);
    per[which] = { cat, changed: cat !== youCat,
      mag: Math.max(...members.map((x) => Math.abs(x[which].delta_std))) };
  }
  return { kind: "group", label, youCat, per,
    immutable: members.some((x) => x.immutable),
    missing: members.some((x) => x.missing),
    key: Math.max(...members.map((x) =>
      Math.max(Math.abs(x.linear.delta_std), Math.abs(x.mlp.delta_std)))) };
}

function renderChanges(scene) {
  const rows = displayRows(scene).sort((a, b) => b.key - a.key);
  // Columns follow the Smallest / Fewest / Safest tab; "—" where none exists.
  const col = (which) => kindKey(which, recoKind);
  const none = (which) => !kindOk(scene, which, recoKind);

  const plainCell = (r, which) => {
    if (r.immutable) return `<td class="fixed">${G.LOCK} can’t change</td>`;
    if (none(which)) return `<td class="same">—</td>`;
    const d = r[col(which)];
    if (Math.abs(d.delta_std) <= 0.02) return `<td class="same">same</td>`;
    const up = d.delta_real > 0, unit = r.unit ? " " + r.unit : "";
    return `<td class="${up ? "up" : "down"}">` +
      `<span class="arrow">${up ? "▲" : "▼"}</span>` +
      `${fmtVal(d.cf_real, r.integer)}${unit}` +
      ` <span class="sub">(${up ? "+" : ""}${fmtVal(d.delta_real, r.integer)})</span></td>`;
  };
  const groupCell = (g, which) => {
    if (g.immutable) return `<td class="fixed">${G.LOCK} can’t change</td>`;
    if (none(which)) return `<td class="same">—</td>`;
    const p = g.per[col(which)];
    if (!p.changed) return `<td class="same">same</td>`;
    return `<td class="up"><span class="arrow">→</span>${esc(p.cat)}</td>`;
  };

  const trs = rows.map((it) => {
    if (it.kind === "group") {
      const miss = it.missing ? ' <span class="miss-mark" title="typical value used">✱</span>' : "";
      return `<tr class="${it.immutable ? "immrow" : ""}">` +
        `<td class="fname-cell">${esc(it.label)}${miss}</td>` +
        `<td class="youval">${esc(it.youCat)}</td>` +
        `${groupCell(it, "linear")}${groupCell(it, "mlp")}</tr>`;
    }
    const r = it.r;
    const miss = r.missing ? ' <span class="miss-mark" title="typical value used">✱</span>' : "";
    const unit = r.unit ? ` <span class="sub">(${r.unit})</span>` : "";
    return `<tr class="${r.immutable ? "immrow" : ""}">` +
      `<td class="fname-cell">${r.label}${miss}${unit}</td>` +
      `<td class="youval">${fmtVal(r.x0_real, r.integer)}</td>` +
      `${plainCell(r, "linear")}${plainCell(r, "mlp")}</tr>`;
  }).join("");

  el("changes-table").innerHTML =
    `<table class="chg"><thead><tr>` +
    `<th>Value</th><th>Now</th>` +
    `<th>After, ${KIND_NAME[recoKind].toLowerCase()} (simple)</th>` +
    `<th>After, ${KIND_NAME[recoKind].toLowerCase()} (flexible)</th>` +
    `</tr></thead><tbody>${trs}</tbody></table>`;
}

function metricsText(scene) {
  const lines = [];
  const q = scene.lens.quality;
  lines.push(
    `lens    ${scene.lens.label}  |  recon L1 ${q.recon.toFixed(3)}` +
    `  trustworthiness ${q.trust.toFixed(3)}  roundtrip ${q.rt.toFixed(3)}` +
    `  (held-out 20%; affine lens, roundtrip 0 exactly)`);
  for (const which of ["linear", "mlp"]) {
    const p = scene.panels[which], m = p.metrics;
    lines.push(
      `${which.padEnd(6)}  acc ${p.acc.toFixed(3)}  AUC ${p.auc.toFixed(3)}` +
      `  |  P(bad) person: best ${pct(m.p_bad_best_x0)} · ERM ${pct(m.p_bad_erm_x0)} · worst ${pct(m.p_bad_worst_x0)}` +
      `   robust CF: ERM ${pct(m.p_bad_erm_cf)} → worst ${pct(m.p_bad_worst_cf)}` +
      `  |  robust margin (Cor. 1) ${m.robust_margin_cf >= 0 ? "+" : ""}${m.robust_margin_cf.toFixed(3)}` +
      ` ${m.robust_margin_cf >= 0 ? "✓robust" : "✗NOT robust"}` +
      `  |  cost std ${f3(m.cost_std)}  robust ${f3(m.cost_rob)}`);
    lines.push(
      `        2D dist CF→boundary: ERM ${f3(m.d2_cf_to_erm)}  worst ${f3(m.d2_cf_to_worst)}` +
      `  ${m.worst_closer ? "✓ orange sits closer (as it must)"
                          : "⚠ orange looks FARTHER in projection — 2D reading of the curved boundary is distorted"}` +
      (m.already_robust ? "  |  note: person already robustly good" : ""));
  }
  const a = scene.panels.linear.metrics, b = scene.panels.mlp.metrics;
  lines.push(
    `Δ       robust cost simple ${f3(a.cost_rob)} vs flexible ${f3(b.cost_rob)}` +
    `  |  eps ${scene.eps} fixed — one knob at a time: model, lens, or person`);
  return lines.join("\n");
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Collapse one-hot columns into one form field.
function formGroups(features) {
  const items = [], seen = {};
  for (const f of features) {
    if (f.group) {
      if (!seen[f.group]) {
        const members = features.filter((x) => x.group === f.group);
        const share = members.reduce((s, m) => s + (m.group_share || 0), 0);
        const g = { type: "group", key: f.group, label: f.group_label,
                    members, baselineShare: Math.max(0, 1 - share) };
        seen[f.group] = g;
        items.push(g);
      }
    } else {
      items.push({ type: "field", f });
    }
  }
  return items;
}

function fieldHTML(f) {
  const unit = f.unit ? ` <span class="unit">(${f.unit})</span>` : "";
  const imm = f.immutable
    ? ` <span class="imm-tag" title="Can’t change, so never recommended">${G.LOCK}</span>`
    : ONE_WAY[f.monotone] || "";
  const hint = f.desc ? " " + G.tip(f.desc) : "";
  const warnId = "warn-" + f.name.replace(/[^\w-]/g, "_");
  return `<label class="you-row" data-min="${f.min}" data-max="${f.max}"
                 data-p5="${f.p5}" data-p95="${f.p95}"
                 data-median="${f.median}" data-int="${f.integer}"
                 data-pmin="${f.possible_min ?? ""}" data-pmax="${f.possible_max ?? ""}"
                 data-above="${!!f.above_min}" data-whole="${!!f.whole}">
    <span class="fname">${f.label}${unit}${imm}${hint}</span>
    <input type="number" step="${f.integer ? 1 : "any"}" name="${f.name}"
           aria-label="${G.esc(f.label + (f.unit ? ` (${f.unit})` : ""))}" aria-describedby="${warnId}"
           placeholder="${fmtVal(f.median, f.integer)} typical">
    <span class="fwarn" id="${warnId}" aria-live="polite"></span>
  </label>`;
}

function groupHTML(g) {
  const imm = g.members.some((m) => m.immutable)
    ? ` <span class="imm-tag" title="Can’t change, so never recommended">${G.LOCK}</span>`
    : "";
  const hasNone = g.baselineShare > 0.02;
  let modal = "", best = g.baselineShare;
  for (const m of g.members)
    if ((m.group_share || 0) > best) { best = m.group_share; modal = m.name; }
  if (modal === "" && hasNone) modal = "__none__";
  const opts = [`<option value="">typical</option>`];
  if (hasNone) opts.push(`<option value="__none__">none of these</option>`);
  for (const m of g.members)
    opts.push(`<option value="${esc(m.name)}">${esc(m.value_label)}</option>`);
  return `<label class="you-row group-row">
    <span class="fname">${esc(g.label)}${imm}</span>
    <select class="you-group" data-modal="${esc(modal)}">${opts.join("")}</select>
  </label>`;
}

function groupMembers(sel) {
  return [...sel.options].map((o) => o.value).filter((v) => v && v !== "__none__");
}

function buildForm(scene) {
  if (formDataset === state.dataset) return;
  formDataset = state.dataset;
  el("you-fields").innerHTML = formGroups(scene.features)
    .map((it) => (it.type === "group" ? groupHTML(it) : fieldHTML(it.f)))
    .join("");
  for (const inp of el("you-fields").querySelectorAll("input"))
    inp.addEventListener("input", checkRange);
  if (state.custom) restoreForm();
}

function restoreForm() {
  for (const inp of el("you-fields").querySelectorAll("input")) {
    const v = state.custom[inp.name];
    inp.value = v == null ? "" : v;
    inp.dispatchEvent(new Event("input"));
  }
  for (const sel of el("you-fields").querySelectorAll("select.you-group")) {
    const members = groupMembers(sel);
    const vals = members.map((nm) => state.custom[nm]);
    let picked = "";
    if (vals.length && vals.every((v) => v === 0))
      picked = sel.querySelector('option[value="__none__"]') ? "__none__" : "";
    else {
      const one = members.find((nm) => state.custom[nm] === 1);
      if (one) picked = one;
    }
    sel.value = picked;
  }
  el("you-details").open = true;
}

// Why no real person could have this value, or "". The server checks the same rules.
function impossibleReason(v, row) {
  const d = row.dataset;
  const lo = d.pmin === "" ? null : Number(d.pmin), hi = d.pmax === "" ? null : Number(d.pmax);
  if (lo != null && (d.above === "true" ? v <= lo : v < lo - 1e-6))
    return d.above === "true" ? `must be more than ${lo}` : `can’t be below ${lo}`;
  if (hi != null && v > hi) return `can’t be above ${hi}`;
  if (d.whole === "true" && Math.abs(v - Math.round(v)) > 1e-4) return "must be a whole number";
  return "";
}

// A value no one can have is refused; one the data has never seen is allowed, with a note.
function checkRange(e) {
  const inp = e.target, row = inp.closest(".you-row");
  const warn = row.querySelector(".fwarn");
  const v = inp.value === "" ? null : Number(inp.value);
  const min = +row.dataset.min, max = +row.dataset.max;
  const isInt = row.dataset.int === "true";
  const reason = v == null || isNaN(v) ? "" : impossibleReason(v, row);
  row.classList.toggle("bad", !!reason);
  inp.setAttribute("aria-invalid", String(!!reason));
  if (v == null || isNaN(v)) { warn.textContent = ""; row.classList.remove("out"); return; }
  if (reason) {
    warn.textContent = `Not possible: ${reason}`;
    row.classList.remove("out");
  } else if (v < min || v > max) {
    warn.textContent = `Outside the data (${fmtVal(min, isInt)}–${fmtVal(max, isInt)}): ` +
      `the models haven’t seen values like this`;
    row.classList.add("out");
  } else { warn.textContent = ""; row.classList.remove("out"); }
}

function readForm() {
  const custom = {};
  for (const inp of el("you-fields").querySelectorAll("input"))
    custom[inp.name] = inp.value === "" ? null : Number(inp.value);
  for (const sel of el("you-fields").querySelectorAll("select.you-group")) {
    const choice = sel.value;
    for (const nm of groupMembers(sel))
      custom[nm] = choice === "" ? null
                 : choice === "__none__" ? 0
                 : (nm === choice ? 1 : 0);
  }
  return custom;
}

function updatePanel(scene) {
  renderLensNote(scene);
  renderLegend(scene);
  renderVerdict(scene);
  renderCompare(scene);
  renderDrivers(scene);
  renderRecommend(scene);
  renderWhatif(scene);
  const q = scene.query, you = handoff(scene);
  el("compare-typical").href = `/compare.html?dataset=${encodeURIComponent(state.dataset)}` +
    `&you=${you}`;
  const who = `dataset=${encodeURIComponent(state.dataset)}&` +
    (q.custom ? `you=${you}` : `query=${q.id}`);
  el("details-link").href = `/details.html?${who}`;
  el("map-link").href = `/app.html?${who}`;
  renderWays(scene);
  renderChanges(scene);

  el("d-std-lin").textContent = scene.panels.linear.cfs.standard.distance.toFixed(3);
  el("d-ell-lin").textContent = safeOk(scene, "linear")
    ? scene.panels.linear.cfs.ellice.distance.toFixed(3) : "none";
  el("d-std-mlp").textContent = scene.panels.mlp.cfs.standard.distance.toFixed(3);
  el("d-ell-mlp").textContent = safeOk(scene, "mlp")
    ? scene.panels.mlp.cfs.ellice.distance.toFixed(3) : "none";

  const rows = scene.deltas.map((r) =>
    `<tr><td>${r.label}</td><td>${fmtVal(r.x0_real, r.integer)}` +
    `${r.unit ? " " + r.unit : ""}</td>` +
    `<td class="miss">${r.missing ? "imputed" : ""}</td></tr>`).join("");
  el("detail").innerHTML =
    `<table><tr><th>feature</th><th>value</th><th></th></tr>${rows}</table>`;

  el("metrics").textContent = metricsText(scene);
  el("delta-caption").textContent =
    "Grey = can’t change · ✱ = " + (q.custom ? "left blank, typical value used" : "missing, typical value used");
}

function redrawPlots(scene) {
  const config = { responsive: true, displayModeBar: false };
  if (HAS_MAP)
    for (const which of ["linear", "mlp"])
      Plotly.react(plotDivs[which], buildPanelTraces(scene, which),
                   panelLayout(scene, which), config);
  if (HAS_DELTA) Plotly.react(deltaDiv, deltaTraces(scene), deltaLayout(), config);
}

async function refresh() {
  loading = true;
  try { await drawScene(); } finally { loading = false; }
}

async function drawScene() {
  Object.values(plotDivs).forEach((d) => d.classList.add("loading"));
  el("busy").textContent = "Loading… the first time can take up to a minute.";

  let resp;
  if (state.point) {
    resp = await fetch("/api/scene", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset: state.dataset, point: state.point, plane: state.plane,
                             rules: state.rules, view: state.view, lens: state.lens }),
    });
  } else if (state.custom) {
    resp = await fetch("/api/scene", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset: state.dataset, custom: state.custom, rules: state.rules,
                             view: state.view, lens: state.lens, from_map: state.fromMap }),
    });
  } else {
    const url = new URL("/api/scene", location.origin);
    url.searchParams.set("dataset", state.dataset);
    if (state.query != null) url.searchParams.set("query", state.query);
    if (Object.keys(state.rules).length) url.searchParams.set("rules", JSON.stringify(state.rules));
    if (state.view !== "everyone") url.searchParams.set("view", state.view);
    if (state.lens) url.searchParams.set("lens", state.lens);
    resp = await fetch(url);
  }
  const scene = await resp.json();
  Object.values(plotDivs).forEach((d) => d.classList.remove("loading"));
  el("busy").textContent = "";
  if (scene.invalid) {                    // values no real person could have
    el("busy").textContent = scene.error;
    if (state.custom && formDataset === state.dataset) {
      restoreForm();
      const first = el("you-fields").querySelector(".you-row.bad input");
      if (first) first.focus();
    }
    return;
  }
  if (scene.error) { el("busy").textContent = "Something went wrong: " + scene.error; return; }
  lastScene = scene;

  if (scene.decoded) {
    state.custom = scene.decoded.values;
    state.point = null;
    state.plane = null;
    state.fromMap = true;
  }
  if (!scene.query.custom) state.query = scene.query.id;
  const rebuilt = formDataset !== state.dataset;
  buildForm(scene);
  if (scene.decoded && !rebuilt) restoreForm();
  showMapNote(scene);

  const config = { responsive: true, displayModeBar: false };
  const draw = plotsReady ? Plotly.react : Plotly.newPlot;
  if (HAS_MAP)
    for (const which of ["linear", "mlp"])
      await draw(plotDivs[which], buildPanelTraces(scene, which),
                 panelLayout(scene, which), config);
  if (HAS_DELTA) await draw(deltaDiv, deltaTraces(scene), deltaLayout(), config);

  if (!plotsReady) {
    plotsReady = true;
    if (HAS_MAP)
      for (const div of Object.values(plotDivs))
        wireClicks(div);
  }
  updatePanel(scene);
}

// ---- which map: the simple (linear) one, the flexible (MLP) one, or both

function colorbarPanel() {
  return mapView === "linear" ? "linear" : "mlp";
}

function setMapView(view, redraw) {
  if (!["linear", "mlp", "both"].includes(view)) view = "both";
  mapView = view;
  try { localStorage.setItem(VIEW_KEY, view); } catch (e) {}
  el("plots").classList.toggle("single", view !== "both");
  el("cell-linear").hidden = view === "mlp";
  el("cell-mlp").hidden = view === "linear";
  for (const b of el("map-toggle").querySelectorAll("button"))
    b.setAttribute("aria-pressed", String(b.dataset.view === view));
  if (redraw && plotsReady && lastScene) {
    redrawPlots(lastScene);
    showMapNote(lastScene);
    for (const div of Object.values(plotDivs))
      if (!div.closest(".plot-cell").hidden) Plotly.Plots.resize(div);
  }
}

// ---- what the map is built around: everyone (one shared map), or this person
// (each model's map rebuilt so its suggested changes show whole)

function setAround(view, redraw) {
  state.view = view === "around" ? "around" : "everyone";
  try { localStorage.setItem(AROUND_KEY, state.view); } catch (e) {}
  for (const b of el("around-toggle").querySelectorAll("button"))
    b.setAttribute("aria-pressed", String(b.dataset.around === state.view));
  if (redraw && lastScene && !loading) refresh();
}
el("around-toggle").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-around]");
  if (b && b.dataset.around !== state.view) setAround(b.dataset.around, true);
});
try { setAround(localStorage.getItem(AROUND_KEY), false); } catch (e) { setAround("everyone", false); }
el("around-tip").innerHTML = G.tip("Everyone: one map for all people. Around this person: " +
  "each map is rebuilt around the star, so both suggested changes show at their true " +
  "distance and direction.");

// ---- developer option: draw the shared map with ECLIPSE (experimental) instead of PCA

function setLens(lens, redraw) {
  state.lens = lens === "eclipse" ? "eclipse" : null;
  try {
    if (state.lens) localStorage.setItem(LENS_KEY, state.lens);
    else localStorage.removeItem(LENS_KEY);
  } catch (e) {}
  el("dev-eclipse").checked = !!state.lens;
  el("lens-badge").hidden = !state.lens;
  if (redraw && lastScene && !loading) refresh();
}
el("dev-eclipse").addEventListener("change", (e) => setLens(e.target.checked ? "eclipse" : null, true));
try { setLens(localStorage.getItem(LENS_KEY), false); } catch (e) { setLens(null, false); }

el("map-toggle").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (b) setMapView(b.dataset.view, true);
});
try { setMapView(localStorage.getItem(VIEW_KEY) || "both", false); }
catch (e) { setMapView("both", false); }

// A dot selects that person; anywhere else selects the spot itself, which the
// server turns back into a person through the lens's exact inverse. Clicks are
// read from the mouse event, not Plotly's hover, so every pixel of the plot area
// is clickable and the spot is exact.
const DOT_PX = 4;          // a click this close to a dot's centre picks the dot

function wireClicks(div) {
  let down = null, last = -1;
  div.addEventListener("mousedown", (e) => { down = [e.clientX, e.clientY]; }, true);
  div.addEventListener("click", (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;  // a drag
    if (e.timeStamp - last < 300) return;      // Plotly re-sends the same click
    last = e.timeStamp;
    onClick(div, e);
  });
}

function onClick(div, e) {
  if (loading) return;
  const at = plotPixel(div, e);
  if (!at) return;
  const id = dotAt(div, at);
  if (id != null) {
    state.query = id;
    state.custom = null;
    state.point = null;
    state.plane = null;
    state.fromMap = false;
  } else {
    const fl = div._fullLayout, which = div === plotDivs.linear ? "linear" : "mlp";
    state.point = [fl.xaxis.p2d(at[0]), fl.yaxis.p2d(at[1])];
    state.plane = (lastScene && lastScene.panels[which].plane) || null;
    state.query = null;
  }
  refresh();
}

// The click in plot-area pixels, or null outside the plot area.
function plotPixel(div, mouse) {
  const fl = div._fullLayout, svg = div.querySelector(".main-svg");
  if (!fl || !fl.xaxis || !svg) return null;
  const xa = fl.xaxis, ya = fl.yaxis, box = svg.getBoundingClientRect();
  const px = mouse.clientX - box.left - xa._offset;
  const py = mouse.clientY - box.top - ya._offset;
  if (px < 0 || py < 0 || px > xa._length || py > ya._length) return null;
  return [px, py];
}

// The id of the nearest dot within DOT_PX of a plot-area pixel, else null.
function dotAt(div, [px, py]) {
  const xa = div._fullLayout.xaxis, ya = div._fullLayout.yaxis;
  let best = null, bestD = DOT_PX;
  for (const t of div.data) {
    if (t.meta !== "people") continue;
    for (let i = 0; i < t.x.length; i++) {
      const d = Math.hypot(xa.d2p(t.x[i]) - px, ya.d2p(t.y[i]) - py);
      if (d <= bestD) { bestD = d; best = t.customdata[i]; }
    }
  }
  return best;
}

// On the shared map a point is drawn where its look-alike sits: the values the flat map
// can't show are set to typical ones. Say when that puts the star or a change on the
// wrong side of its line, panel by panel, and offer the exact view.
const PANEL_NAME = { linear: "Simple", mlp: "Flexible" };
function offMapNote(scene) {
  if (scene.view === "around") return "";
  const issues = [];
  for (const which of visiblePanels()) {
    const m = scene.panels[which].metrics, marks = [];
    if (m.star_drawn_right === false) marks.push("★ this person");
    if (!m.pred_bad) { if (marks.length) issues.push([which, marks]); continue; }
    if (quickOk(scene, which) && m.quick_drawn_right === false) marks.push("✕ smallest change");
    if (safeOk(scene, which) && m.safe_drawn_right === false) marks.push("▪ holds across models");
    if (marks.length) issues.push([which, marks]);
  }
  if (!issues.length) return "";
  const list = issues.map(([which, marks]) =>
    `${PANEL_NAME[which]} map: ${marks.join(", ")}`).join("; ");
  return `<span class="sub">Drawn on the wrong side of its line (${list}). Part of the ` +
    `change is in values this flat map can’t show, so the picture is approximate there. ` +
    `<button type="button" class="link-btn" data-show-around>Show it exactly</button></span>`;
}
el("map-note").addEventListener("click", (e) => {
  if (e.target.closest("[data-show-around]")) setAround("around", true);
});

function showMapNote(scene) {
  const note = el("map-note"), d = scene.decoded;
  const off = offMapNote(scene);
  note.hidden = !d && !off;
  if (!d) { note.innerHTML = off; return; }
  const m = scene.panels.linear.metrics, [goodName, badName] = scene.class_names;
  note.innerHTML = `<b>Estimated person at this spot:</b> ` +
    `${G.esc(m.pred_bad ? badName : goodName)} · ${pct(m.p_bad_erm_x0)} chance of ${G.esc(badName)}. ` +
    `<span class="sub">Their numbers are filled in below.</span>` +
    (d.outside.length ? `<br><span class="warn">Outside the data: ${d.outside.map(G.esc).join(", ")}</span>` : "") +
    (off ? "<br>" + off : "");
}

el("dataset").addEventListener("change", async (e) => {
  state.dataset = e.target.value;
  loadRules();
  state.query = null; state.custom = null; state.point = null; state.fromMap = false;
  el("save-msg").textContent = "";
  closeSavePanel();
  await refresh();
  refreshSaved();
});
el("you-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const bad = el("you-fields").querySelector(".you-row.bad input");
  if (bad) {
    el("save-msg").textContent = "Fix the values marked “not possible” first.";
    bad.focus();
    return;
  }
  el("save-msg").textContent = "";
  state.custom = readForm();
  state.point = null;
  state.fromMap = false;
  refresh();
});
el("you-typical").addEventListener("click", () => {
  for (const inp of el("you-fields").querySelectorAll("input")) {
    inp.value = inp.closest(".you-row").dataset.median;
    inp.dispatchEvent(new Event("input"));
  }
  for (const sel of el("you-fields").querySelectorAll("select.you-group"))
    sel.value = sel.dataset.modal || "";
});
el("you-clear").addEventListener("click", () => {
  for (const inp of el("you-fields").querySelectorAll("input")) {
    inp.value = "";
    inp.dispatchEvent(new Event("input"));
  }
  for (const sel of el("you-fields").querySelectorAll("select.you-group")) sel.value = "";
  state.custom = null;
  state.point = null;
  state.fromMap = false;
  refresh();
});

// ---- saving: signed-in users choose which values to keep, under a name

function setSaveButton() {
  el("you-save").textContent = currentUser ? "Save values…" : "Sign in to save";
}

// One item per form field that has a value (a one-hot group counts as one).
function filledItems() {
  const items = [];
  for (const row of el("you-fields").querySelectorAll(".you-row")) {
    const label = row.querySelector(".fname").firstChild.textContent.trim();
    const inp = row.querySelector("input"), sel = row.querySelector("select.you-group");
    if (inp && inp.value !== "") {
      const unit = (row.querySelector(".unit") || {}).textContent || "";
      items.push({ names: [inp.name], label,
                   text: inp.value + (unit ? " " + unit.replace(/[()]/g, "") : "") });
    } else if (sel && sel.value !== "") {
      items.push({ names: groupMembers(sel), label, text: sel.selectedOptions[0].textContent });
    }
  }
  return items;
}

function defaultSaveName() {
  const when = new Date().toLocaleString([], { month: "short", day: "numeric",
                                               hour: "numeric", minute: "2-digit" });
  return (lastScene && lastScene.query.from_map ? "Map spot, " : "My values, ") + when;
}

function updateSaveConfirm() {
  const name = el("save-name").value.trim();
  const clash = savedEntries.some((s) => s.name === name);
  el("save-confirm").textContent = clash ? "Replace" : "Save";
  el("save-confirm").title = clash ? "Replaces your save with the same name" : "";
}

function openSavePanel() {
  const items = filledItems();
  if (!items.length) {
    el("save-msg").textContent = "Enter or pick at least one value first.";
    return;
  }
  panelItems = items;
  el("save-msg").textContent = "";
  el("save-choices").innerHTML = items.map((it, i) =>
    `<label class="save-choice"><input type="checkbox" data-i="${i}" checked>` +
    `<span>${esc(it.label)}</span> <b>${esc(it.text)}</b></label>`).join("");
  el("save-name").value = defaultSaveName();
  updateSaveConfirm();
  el("save-panel").hidden = false;
  el("save-panel").scrollIntoView({ block: "nearest", behavior: "smooth" });
  el("save-name").focus();
  el("save-name").select();
}

function closeSavePanel() {
  el("save-panel").hidden = true;
  panelItems = [];
}

async function confirmSave() {
  const all = readForm(), values = {};
  for (const cb of el("save-choices").querySelectorAll("input:checked"))
    for (const nm of panelItems[+cb.dataset.i].names) values[nm] = all[nm];
  const msg = el("save-msg");
  if (!Object.keys(values).length) {
    msg.textContent = "Tick at least one value to save.";
    return;
  }
  const name = el("save-name").value.trim();
  el("save-confirm").disabled = true;
  try {
    const resp = await fetch("/api/saved", {
      method: "POST", headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ dataset: state.dataset, name, values }),
    });
    const body = await resp.json().catch(() => ({}));
    if (resp.ok) {
      closeSavePanel();
      msg.textContent = `Saved “${body.saved.name}” to your account.`;
      await refreshSaved();
    } else {
      msg.textContent = body.error || "Could not save. Please try again.";
    }
  } catch (e) {
    msg.textContent = "Could not reach the server. Please try again.";
  } finally {
    el("save-confirm").disabled = false;
  }
}

// Plain-language summary of a save, e.g. "Glucose 150 mg/dL · BMI 31.5 kg/m²".
function summarise(values) {
  const meta = Object.fromEntries((lastScene ? lastScene.features : []).map((f) => [f.name, f]));
  const parts = [], groups = {};
  for (const [name, v] of Object.entries(values)) {
    if (v == null) continue;
    const f = meta[name];
    if (f && f.group) {
      if (!(f.group in groups)) groups[f.group] = parts.push(`${f.group_label}: none`) - 1;
      if (v === 1) parts[groups[f.group]] = `${f.group_label}: ${f.value_label}`;
      continue;
    }
    const unit = f && f.unit ? " " + f.unit : "";
    parts.push(`${f ? f.label : name} ${fmtVal(v, f && f.integer && Number.isInteger(v))}${unit}`);
  }
  return parts.join(" · ");
}

function renderSaved() {
  el("saved-list").hidden = !savedEntries.length;
  el("saved-items").innerHTML = savedEntries.map((s, i) =>
    `<li><div class="saved-main"><b>${esc(s.name)}</b>` +
    `<span class="sub">${esc(summarise(s.values))}</span></div>` +
    `<span class="sub saved-when">${new Date(s.updated_at * 1000).toLocaleString()}</span>` +
    `<button type="button" data-load="${i}">Load</button>` +
    `<button type="button" data-del="${i}">Delete</button></li>`).join("");
}

async function refreshSaved() {
  savedEntries = [];
  if (currentUser) {
    try {
      const url = "/api/saved?dataset=" + encodeURIComponent(state.dataset);
      const body = await (await fetch(url, { credentials: "same-origin" })).json();
      savedEntries = body.saved || [];
    } catch (e) {}
  }
  renderSaved();
}

function goSignInToSave(values) {
  // Keep what was typed, sign in, and pick what to save on the way back.
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ dataset: state.dataset, values }));
  } catch (e) {}
  location.href = "/login.html?reason=save&next=" +
    encodeURIComponent("/app.html?dataset=" + state.dataset);
}

function takePending() {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

el("you-save").addEventListener("click", () => {
  if (!currentUser) goSignInToSave(readForm());
  else openSavePanel();
});
el("save-confirm").addEventListener("click", confirmSave);
el("save-cancel").addEventListener("click", closeSavePanel);
el("save-name").addEventListener("input", updateSaveConfirm);
el("save-all").addEventListener("click", () =>
  el("save-choices").querySelectorAll("input").forEach((cb) => { cb.checked = true; }));
el("save-none").addEventListener("click", () =>
  el("save-choices").querySelectorAll("input").forEach((cb) => { cb.checked = false; }));

el("saved-items").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const s = savedEntries[+(b.dataset.load ?? b.dataset.del)];
  if (!s) return;
  if (b.dataset.load != null) {
    state.custom = s.values;
    state.point = null;
    state.fromMap = false;
    restoreForm();
    el("save-msg").textContent = `Loaded “${s.name}”.`;
    refresh();
    return;
  }
  if (!confirm(`Delete “${s.name}”?`)) return;
  const resp = await fetch("/api/saved?id=" + encodeURIComponent(s.id),
                           { method: "DELETE", credentials: "same-origin" });
  el("save-msg").textContent = resp.ok ? `Deleted “${s.name}”.`
                                       : "Could not delete. Please try again.";
  await refreshSaved();
});


async function showAccount() {
  currentUser = await G.me;
  setSaveButton();
}

async function init() {
  await showAccount();
  const qs = new URLSearchParams(location.search);
  if (qs.has("dataset")) state.dataset = qs.get("dataset");
  if (qs.has("query") && isFinite(Number(qs.get("query")))) state.query = Number(qs.get("query"));
  if (qs.get("you") === "tab") {
    const h = takeHandoff();
    if (h && h.dataset === state.dataset) { state.custom = h.values; state.fromMap = !!h.fromMap; }
  } else if (qs.has("you")) {
    // An older link with the values in it: use them, then take them out of the address.
    state.custom = {};
    for (const kv of qs.get("you").split(",")) {
      const i = kv.indexOf(":");
      if (i > 0 && isFinite(Number(kv.slice(i + 1))))
        state.custom[kv.slice(0, i)] = Number(kv.slice(i + 1));
    }
    qs.set("you", "tab");
    try {
      sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ dataset: state.dataset, values: state.custom }));
      history.replaceState(null, "", `${location.pathname}?${qs}`);
    } catch (e) {}
  }

  // Back from signing in to save: restore what was typed, then choose what to keep.
  const pending = currentUser ? takePending() : null;
  if (pending) {
    state.dataset = pending.dataset;
    state.custom = pending.values;
  }

  loadRules();
  checkSummaryAI();
  const meta = await (await fetch("/api/datasets")).json();
  el("dataset").innerHTML = meta.datasets
    .map((d) => `<option value="${G.esc(d.key)}">${G.esc(G.topicName(d.key, d.label))}</option>`)
    .join("");
  el("dataset").value = state.dataset;

  await refresh();
  await refreshSaved();
  const openId = Number(qs.get("save"));
  const toOpen = openId && savedEntries.find((e) => e.id === openId);
  if (toOpen) {
    state.custom = toOpen.values;
    state.point = null;
    state.fromMap = false;
    restoreForm();
    el("save-msg").textContent = `Opened “${toOpen.name}”.`;
    await refresh();
  }
  if (pending) openSavePanel();
  else if (qs.get("enter") === "1") {
    el("you-details").open = true;
    el("you-details").scrollIntoView({ behavior: "smooth", block: "start" });
    const first = el("you-fields").querySelector("input, select");
    if (first) first.focus({ preventScroll: true });
  }
}

// ---- map tools: graph style, find me, reset zoom, most disputed

el("map-tip").innerHTML = G.tip("Click any spot to see the person who would be there. " +
  "Drag a box to zoom in, or use + and −. Double-click resets.");
el("tip-linear").innerHTML = G.tip("A straight-line model. Easy to explain.");
el("tip-mlp").innerHTML = G.tip("A small neural network. Can bend around the data.");
el("compare-tip").innerHTML = G.tip("Where each number sits among everyone in the data. " +
  "Most important first. A lock means it can’t be changed.", "right");
el("reco-tip").innerHTML = G.tip("Changes to the numbers that would flip the models’ " +
  "prediction. Things you can’t change are never suggested. They show how the models " +
  "behave; they are not advice and don’t say what would happen in real life.");
el("reco-kind-tip").innerHTML = G.tip("Smallest: the least total change for this model. " +
  "Fewest changes: touches as few values as possible. Holds across models: flips every model " +
  "that fits the data about as well. That is a property of the models, not a real-world " +
  "guarantee.");
el("whatif-tip").innerHTML = G.tip("Drag a value. The chance updates and a hollow star " +
  "shows where you would move on the map.");
el("plan-tip").innerHTML = G.tip("Tick the changes you’ll make. Save the plan to your " +
  "account and compare it with now.", "right");
el("changes-tip").innerHTML = G.tip("Now: your numbers. After: the closest person every " +
  "good model would put on the other side.");

const MAP_STYLES = ["density", "classes", "datapoints"];
function setMapStyle(style, redraw) {
  // older saves stored "1" for the dot map and "0" for the density map
  style = style === "1" ? "datapoints" : MAP_STYLES.includes(style) ? style : "density";
  mapStyle = style;
  const select = el("map-style");
  if (select && select.tagName === "SELECT") select.value = style;
  el("disputed-switch").hidden = style !== "datapoints";
  try { localStorage.setItem(GRAPH_KEY, style); } catch (e) {}
  if (redraw && plotsReady && lastScene) {
    redrawPlots(lastScene);
    renderLegend(lastScene);
  }
}
el("map-style").addEventListener("change", (e) => setMapStyle(e.target.value, true));
el("show-disputed").addEventListener("change", (e) => {
  showDisputed = e.target.checked;
  if (plotsReady && lastScene) redrawPlots(lastScene);
});
try { setMapStyle(localStorage.getItem(GRAPH_KEY), false); }
catch (e) { setMapStyle("density", false); }

function visiblePanels() {
  return ["linear", "mlp"].filter((w) => !el("cell-" + w).hidden);
}
el("reset-zoom").addEventListener("click", () => {
  if (!lastScene) return;
  for (const which of visiblePanels()) {
    const [xr, yr] = defaultRanges(lastScene, which);
    Plotly.relayout(plotDivs[which], { "xaxis.range": xr, "yaxis.range": yr });
  }
});
// Zoom in or out around the middle of what's on screen; both axes by the same
// factor, so the map keeps its shape.
const ZOOM_STEP = 0.7;
function zoomBy(factor) {
  if (!plotsReady) return;
  for (const which of visiblePanels()) {
    const fl = plotDivs[which]._fullLayout;
    const scale = (r) => {
      const c = (r[0] + r[1]) / 2, h = (r[1] - r[0]) / 2 * factor;
      return [c - h, c + h];
    };
    Plotly.relayout(plotDivs[which], { "xaxis.range": scale(fl.xaxis.range),
                                       "yaxis.range": scale(fl.yaxis.range) });
  }
}
el("zoom-in").addEventListener("click", () => zoomBy(ZOOM_STEP));
el("zoom-out").addEventListener("click", () => zoomBy(1 / ZOOM_STEP));

el("find-me").addEventListener("click", () => {
  if (!lastScene) return;
  const q = lastScene.query;
  for (const which of visiblePanels()) {
    const fl = plotDivs[which]._fullLayout;
    const wx = fl.xaxis.range[1] - fl.xaxis.range[0], wy = fl.yaxis.range[1] - fl.yaxis.range[0];
    Plotly.relayout(plotDivs[which], { "xaxis.range": [q.x - wx / 2, q.x + wx / 2],
                                       "yaxis.range": [q.y - wy / 2, q.y + wy / 2] });
  }
});

init();
