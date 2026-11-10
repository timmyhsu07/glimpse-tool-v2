// Compare two people side by side: you, any of your saves, or a typical person.
const G = window.GLIMPSE;
const el = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);

let topic = qs.get("dataset") || "pima";
let saves = [];                 // this topic's saves (signed in only)
let fromLink = null;            // values passed from the map or details page
let showSame = false;

function fmt(v, integer) {
  if (v == null || isNaN(v)) return "—";
  if (integer) return Math.round(v).toLocaleString();
  const a = Math.abs(v);
  return String(Number(v.toFixed(a >= 100 ? 0 : a >= 10 ? 1 : 2)));
}
const pct = (p) => Math.round(p * 100) + "%";
const day = (t) => new Date(t * 1000).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });

function parseYou(raw) {
  if (!raw) return null;
  const out = {};
  for (const kv of raw.split(",")) {
    const i = kv.indexOf(":");
    if (i > 0 && isFinite(Number(kv.slice(i + 1)))) out[kv.slice(0, i)] = Number(kv.slice(i + 1));
  }
  return Object.keys(out).length ? out : null;
}

// The values handed over in this tab (?you=tab), or from an older link with the values in
// the address, which are then taken out of it.
function takeYou() {
  const raw = qs.get("you");
  if (raw === "tab") {
    try {
      const h = JSON.parse(sessionStorage.getItem("glimpse-you") || "null");
      return h && h.dataset === topic ? h.values : null;
    } catch (e) { return null; }
  }
  const vals = parseYou(raw);
  if (vals) {
    qs.set("you", "tab");
    try {
      sessionStorage.setItem("glimpse-you", JSON.stringify({ dataset: topic, values: vals }));
      history.replaceState(null, "", `${location.pathname}?${qs}`);
    } catch (e) {}
  }
  return vals;
}

// Every choice for the two pickers: { key, label, values }.
function choices() {
  const list = [];
  if (fromLink) list.push({ key: "you", label: "Your values", values: fromLink });
  for (const s of saves) list.push({ key: "save:" + s.id, label: `${s.name} · ${day(s.updated_at)}`, values: s.values });
  list.push({ key: "typical", label: "A typical person", values: {} });
  return list;
}

function fillPickers(aKey, bKey) {
  const opts = choices().map((c) => `<option value="${G.esc(c.key)}">${G.esc(c.label)}</option>`).join("");
  el("cmp-a").innerHTML = opts;
  el("cmp-b").innerHTML = opts;
  const keys = choices().map((c) => c.key);
  el("cmp-a").value = keys.includes(aKey) ? aKey : keys[0];
  el("cmp-b").value = keys.includes(bKey) ? bKey : (keys.find((k) => k !== el("cmp-a").value) || keys[0]);
}

function defaultKeys() {
  const a = qs.get("a"), b = qs.get("b");
  if (fromLink) return ["you", b ? "save:" + b : "typical"];
  if (a) {
    const older = saves.find((s) => String(s.id) !== a);
    return ["save:" + a, b ? "save:" + b : older ? "save:" + older.id : "typical"];
  }
  if (saves.length >= 2) return ["save:" + saves[1].id, "save:" + saves[0].id];   // older vs newer
  return [saves.length ? "save:" + saves[0].id : "typical", "typical"];
}

async function loadSaves(user) {
  saves = [];
  if (!user) return;
  try {
    const r = await fetch("/api/saved?dataset=" + encodeURIComponent(topic), { credentials: "same-origin" });
    if (r.ok) saves = (await r.json()).saved.sort((x, y) => y.updated_at - x.updated_at);
  } catch (e) {}
}

function summaryCard(title, person, names) {
  const m = person.linear, bad = m.p >= 0.5;
  const lo = Math.round(m.lo * 100), hi = Math.round(m.hi * 100);
  return `<div class="cmp-card ${bad ? "bad" : "good"}">
    <div class="vlabel">${G.esc(title)}</div>
    <div class="vpred">${G.esc(bad ? names[1] : names[0])}</div>
    <div class="vrange"><b class="vchance">${pct(m.p)}</b> chance of ${G.esc(names[1])}</div>
    <div class="vothers sub">Other good models: ${lo}–${hi}%</div>
    ${G.rangeBar(lo, hi, Math.round(m.p * 100), names[0], names[1])}
  </div>`;
}

// One display row per feature, or per one-hot group.
function rows(body, A, B) {
  const out = [], groups = {};
  const rank = new Map(body.importance.map((n, i) => [n, i]));
  for (const f of body.features) {
    if (f.group) {
      const g = groups[f.group] || (groups[f.group] = { label: f.group_label, members: [], immutable: false });
      g.members.push(f);
      g.immutable = g.immutable || f.immutable;
      continue;
    }
    const a = A.values[f.name], b = B.values[f.name];
    out.push({ label: f.label, unit: f.unit, immutable: f.immutable, rank: rank.get(f.name) ?? 1e9,
               a: fmt(a, f.integer), b: fmt(b, f.integer), same: Math.abs(a - b) < 1e-6,
               up: b > a, diff: fmt(Math.abs(b - a), f.integer), pa: A.pct[f.name], pb: B.pct[f.name] });
  }
  for (const g of Object.values(groups)) {
    const pick = (P) => { const m = g.members.find((f) => P.values[f.name] >= 0.5); return m ? m.value_label : "none"; };
    const a = pick(A), b = pick(B);
    out.push({ label: g.label, unit: "", immutable: g.immutable, rank: 1e8, a, b, same: a === b, group: true });
  }
  return out.sort((x, y) => (x.same - y.same) || (x.rank - y.rank));
}

async function render() {
  const pick = (key) => choices().find((c) => c.key === key);
  const A = pick(el("cmp-a").value), B = pick(el("cmp-b").value);
  if (!A || !B) return;
  el("cmp-hint").textContent = "";
  let body;
  try {
    const r = await fetch("/api/people", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset: topic, people: [A.values, B.values] }),
    });
    body = await r.json();
    if (!r.ok) throw new Error(body.error);
  } catch (e) {
    el("cmp-summary").innerHTML = `<p class="warn">Couldn’t load this comparison. Try again.</p>`;
    return;
  }
  const [pa, pb] = body.people, names = body.class_names;
  const moved = Math.round(pb.linear.p * 100) - Math.round(pa.linear.p * 100);
  const flipped = (pa.linear.p >= 0.5) !== (pb.linear.p >= 0.5);
  el("cmp-summary").innerHTML =
    summaryCard(A.label, pa, names) +
    `<div class="cmp-move" aria-label="change in chance">
       <span class="cmp-move-arrow">${moved === 0 ? "=" : moved > 0 ? "▲" : "▼"}</span>
       <b>${moved === 0 ? "No change" : `${Math.abs(moved)} points ${moved > 0 ? "up" : "down"}`}</b>
       ${flipped ? `<span class="badge close">flips the result</span>` : ""}</div>` +
    summaryCard(B.label, pb, names);

  const all = rows(body, pa, pb);
  const changed = all.filter((r) => !r.same), same = all.filter((r) => r.same);
  const shown = showSame ? all : changed;
  el("cmp-table").innerHTML =
    `<thead><tr><th>Value</th><th>Left</th><th></th><th>Right</th></tr></thead><tbody>` +
    (shown.length ? shown.map((r) => `<tr class="${r.same ? "same" : ""}${r.immutable ? " immrow" : ""}">
      <td>${G.esc(r.label)}${r.immutable ? " " + G.LOCK : ""}</td>
      <td>${G.esc(r.a)}${r.unit ? ` <span class="sub">${G.esc(r.unit)}</span>` : ""}</td>
      <td class="cmp-arrow">${r.same ? "=" :
        r.group ? "→" : `${r.up ? "▲" : "▼"} ${G.esc(r.diff)}`}</td>
      <td><b>${G.esc(r.b)}</b>${r.unit ? ` <span class="sub">${G.esc(r.unit)}</span>` : ""}</td></tr>`).join("")
      : `<tr><td colspan="4" class="sub">The same on every value.</td></tr>`) + `</tbody>`;
  const btn = el("cmp-show-same");
  btn.hidden = !same.length;
  btn.textContent = showSame ? "Hide values that are the same" : `Show ${same.length} values that are the same`;
}

el("cmp-show-same").addEventListener("click", () => { showSame = !showSame; render(); });
el("cmp-a").addEventListener("change", render);
el("cmp-b").addEventListener("change", render);
el("cmp-topic").addEventListener("change", async (e) => {
  topic = e.target.value;
  qs.set("dataset", topic);
  history.replaceState(null, "", `${location.pathname}?${qs}${location.hash}`);
  el("cmp-add-profile").href = `/app.html?dataset=${encodeURIComponent(topic)}&enter=1`;
  fromLink = null;
  await loadSaves(await G.me);
  fillPickers(...defaultKeys());
  render();
});

async function init() {
  el("cmp-values-tip").innerHTML = G.tip("Changed values first, most important at the top. " +
    "A lock means it can’t be changed.");
  fromLink = takeYou();
  let datasets = [];
  try { datasets = (await (await fetch("/api/datasets")).json()).datasets; } catch (e) {}
  if (!datasets.some((d) => d.key === topic) && datasets.length) topic = datasets[0].key;
  el("cmp-topic").innerHTML = datasets.map((d) =>
    `<option value="${G.esc(d.key)}">${G.esc(G.topicName(d.key, d.label))}</option>`).join("");
  el("cmp-topic").value = topic;
  el("cmp-add-profile").href = `/app.html?dataset=${encodeURIComponent(topic)}&enter=1`;
  const user = await G.me;
  await loadSaves(user);
  fillPickers(...defaultKeys());
  if (!user) el("cmp-hint").innerHTML =
    `<a href="/login.html?next=${encodeURIComponent(location.pathname + location.search)}">Sign in</a> to compare your saves.`;
  await render();
  if (!user) el("cmp-hint").innerHTML =
    `<a href="/login.html?next=${encodeURIComponent(location.pathname + location.search)}">Sign in</a> to compare your saves.`;
}
init();
