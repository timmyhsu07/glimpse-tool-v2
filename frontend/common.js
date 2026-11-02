// Shared by every page: theme, top navigation, topic names, "?" tips.
(function () {
  const THEME_KEY = "glimpse-theme";
  const $ = (id) => document.getElementById(id);

  const TOPICS = {
    pima: { name: "Diabetes", line: "Would a model flag diabetes?",
            source: "a public dataset of 768 women of Pima Indian heritage, aged 21 and over",
            limit: "It is not a diagnosis or medical advice.",
            icon: '<path d="M12 3c3.5 4.6 6 8 6 11a6 6 0 0 1-12 0c0-3 2.5-6.4 6-11z"/>' },
    taiwan: { name: "Credit card", line: "Would a bank expect you to miss payments?",
             source: "a public dataset of 30,000 credit card holders in Taiwan from 2005",
             limit: "It is not a credit decision or financial advice.",
             icon: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18M7 15h4"/>' },
    cancer: { name: "Breast cancer", line: "Would a model call a tumor malignant?",
              source: "a public dataset of 569 breast tumor samples measured from images (University of Wisconsin)",
              limit: "It is not a diagnosis or medical advice.",
              icon: '<path d="M12 3c-2 0-3.5 1.5-3.5 3.5 0 2 1.5 4 3.5 6.5 2-2.5 3.5-4.5 3.5-6.5C15.5 4.5 14 3 12 3z"/><path d="M10.5 11 6.5 21M13.5 11l4 10"/>' },
  };
  const topicName = (key, fallback) => (TOPICS[key] ? TOPICS[key].name : fallback || key);
  const icon = (key) =>
    `<svg class="topic-icon" viewBox="0 0 24 24" aria-hidden="true">${(TOPICS[key] || {}).icon || ""}</svg>`;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // A "?" that shows a short explanation on hover, focus or tap.
  const tip = (text, align) =>
    `<button type="button" class="tip${align === "right" ? " tip-r" : ""}" ` +
    `aria-label="${esc(text)}" data-tip="${esc(text)}">?</button>`;

  const LOCK = '<svg class="lock" viewBox="0 0 24 24" aria-hidden="true">' +
    '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';

  const isDark = () => document.documentElement.getAttribute("data-theme") === "dark";

  const BASE = {
    light: {
      good: "#0072b2", bad: "#d55e00",
      line: "#14213d", worst: "#b34700", fan: "#555555",
      you: "#f0e442", quick: "#111111", safe: "#7a3300", outline: "#111111",
      whatif: "#111111", arrow: "#111111",
      deltaLin: "#0072b2", deltaMlp: "#009e73", immutable: "#d0d0d0",
      density: "27,27,43", fieldOpacity: 0.45,
      field: [[0, "#5aa0dc"], [0.25, "#a8cdee"], [0.5, "#f5f5f5"], [0.75, "#f8c590"], [1, "#f39a3d"]],
    },
    dark: {
      good: "#56b4e9", bad: "#e69f00",
      line: "#f2f2f5", worst: "#ffb070", fan: "#bbbbbb",
      you: "#f0e442", quick: "#f2f2f2", safe: "#d55e00", outline: "#111111",
      whatif: "#f2f2f5", arrow: "#f2f2f5",
      deltaLin: "#56b4e9", deltaMlp: "#009e73", immutable: "#5a5f68",
      density: "242,242,248", fieldOpacity: 0.5,
      field: [[0, "#3d8fd6"], [0.25, "#2f5f8f"], [0.5, "#2a2e36"], [0.75, "#8a5a2b"], [1, "#e8892b"]],
    },
  };
  const PALETTES = {
    "blue-orange": { label: "Blue & orange", safe: true, light: {}, dark: {} },
    "blue-red": {
      label: "Blue & red", safe: true,
      light: { good: "#2166ac", bad: "#b2182b", worst: "#9e1b1b", safe: "#6e0f0f",
        field: [[0, "#6aa6d6"], [0.25, "#b0cee6"], [0.5, "#f5f5f5"], [0.75, "#ebb8b2"], [1, "#e07a6e"]] },
      dark: { good: "#67a9cf", bad: "#ef8a62", worst: "#ff9a8a", safe: "#e0443a",
        field: [[0, "#3d8fd6"], [0.25, "#345e86"], [0.5, "#2a2e36"], [0.75, "#824042"], [1, "#d9534f"]] },
    },
    "green-purple": {
      label: "Green & purple", safe: true,
      light: { good: "#1b7837", bad: "#762a83", worst: "#5b2a86", safe: "#3f1d5c",
        field: [[0, "#5fb36b"], [0.25, "#aad4b0"], [0.5, "#f5f5f5"], [0.75, "#ceb8dc"], [1, "#a67bc4"]] },
      dark: { good: "#5fbf73", bad: "#c28ee0", worst: "#d6a8f0", safe: "#b06ad8",
        field: [[0, "#3f9a52"], [0.25, "#346444"], [0.5, "#2a2e36"], [0.75, "#62487b"], [1, "#9a62c0"]] },
    },
    classic: {
      label: "Classic green & pink", safe: false,
      light: { good: "#2f6f9f", bad: "#c0573f", worst: "#e65100", safe: "#b71c1c", fieldOpacity: 0.4,
        field: [[0, "#aaffaa"], [0.25, "#ccffcc"], [0.5, "#f4f6fa"], [0.75, "#ffccff"], [1, "#ffaaff"]] },
      dark: { good: "#6fb1d8", bad: "#e08a76", worst: "#ff8a3d", safe: "#e04a3a", fieldOpacity: 0.4,
        field: [[0, "#aaffaa"], [0.25, "#ccffcc"], [0.5, "#f4f6fa"], [0.75, "#ffccff"], [1, "#ffaaff"]] },
    },
  };
  const PALETTE_KEY = "glimpse-palette";
  const palette = () => {
    const value = document.documentElement.getAttribute("data-palette");
    return PALETTES[value] ? value : "blue-orange";
  };
  function setPalette(name) {
    if (!PALETTES[name]) name = "blue-orange";
    document.documentElement.setAttribute("data-palette", name);
    try { localStorage.setItem(PALETTE_KEY, name); } catch (e) {}
    document.dispatchEvent(new CustomEvent("glimpse-theme", { detail: name }));
  }
  const mapColors = (name) => {
    const theme = isDark() ? "dark" : "light";
    return { ...BASE[theme], ...PALETTES[PALETTES[name] ? name : palette()][theme] };
  };

  // The chance bar: a green half and a pink half split at 50%, a band for what the
  // other good models say (lo..hi), and a dot for the best guess. Percent inputs.
  function rangeBar(lo, hi, p, goodName, badName, compact) {
    const clamp = (v) => Math.min(100, Math.max(0, v));
    lo = clamp(lo); hi = clamp(hi); p = clamp(p);
    const label = `Best guess ${p}% chance of ${badName}. Other good models say ${lo}% to ${hi}%.`;
    return `<div class="rb${compact ? " rb-compact" : ""}" role="img" aria-label="${esc(label)}">
      <div class="rb-track">
        <span class="rb-zone rb-good"></span><span class="rb-zone rb-bad"></span>
        <span class="rb-mid"></span>
        <span class="rb-band" style="left:${lo}%;width:${Math.max(hi - lo, 1)}%"></span>
        <span class="rb-dot" style="left:${p}%"></span>
      </div>${compact ? "" : `
      <div class="rb-scale"><span>${esc(goodName)}</span><span>50%</span><span>${esc(badName)}</span></div>`}
    </div>`;
  }

  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
    const btn = $("theme-toggle");
    if (btn) btn.textContent = t === "dark" ? "☀ Light" : "☾ Dark";
    document.dispatchEvent(new CustomEvent("glimpse-theme", { detail: t }));
  }

  // Signed-in state, fetched once per page.
  const me = fetch("/api/me", { credentials: "same-origin" })
    .then((r) => r.json()).then((b) => b.user || null).catch(() => null);

  function markNav() {
    const page = document.body.dataset.page;
    for (const a of document.querySelectorAll("#nav a")) {
      if (a.dataset.page === page) a.setAttribute("aria-current", "page");
    }
    const link = $("account-link");
    if (!link) return;
    me.then((user) => {
      if (user) {
        link.textContent = "My account";
        link.href = "/account.html";
      } else {
        link.textContent = "Sign in";
        link.href = "/login.html?next=" + encodeURIComponent(location.pathname + location.search);
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    applyTheme(isDark() ? "dark" : "light");
    const btn = $("theme-toggle");
    if (btn) btn.addEventListener("click", () => applyTheme(isDark() ? "light" : "dark"));
    markNav();
  });

  window.GLIMPSE = {
    TOPICS, topicName, icon, tip, esc, LOCK, isDark, me, rangeBar,
    PALETTES, palette, setPalette, mapColors,
  };
})();
