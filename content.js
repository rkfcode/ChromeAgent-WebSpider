/* ============================================================
   WebSpider page agent — v8
   Runs in every frame, in the isolated world. Exposes
   window.__webspiderLocate so the service worker can find which
   frame actually holds an element.

   Read tools never mutate the page. Action tools never bypass a
   security control. Console and native-dialog capture live in
   main.js (MAIN world) and are read back through DOM slots.
   ============================================================ */
(() => {
if (window.__webspider_v8) return;
window.__webspider_v8 = true;

const MAX = { items: 200, text: 20000 };

/* --------------------------------------------------------- utils */
const clean = s => String(s || "").replace(/\s+/g, " ").trim();
const esc = s => CSS.escape(String(s));
const clip = (s, n) => { const t = String(s ?? ""); return t.length > n ? t.slice(0, n) + "…" : t; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v)));
const clampMs = (v, lo, hi, def) => { const n = Number(v); return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
const round2 = n => Math.round(n * 100) / 100;
const safeBool = fn => { try { return !!fn(); } catch { return false; } };

/* Loose matching: case, punctuation, curly quotes and diacritics all fold,
   so "Delete  account!" and "delete account" are the same target. */
const norm = s => clean(s).toLowerCase()
  .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
  .replace(/[^a-z0-9\u0600-\u06ff]+/g, " ")
  .trim();

const safeQueryAll = (root, sel) => { try { return [...root.querySelectorAll(sel)]; } catch { return []; } };

/* ------------------------------------------------------- visibility */
const vis = e => {
  if (!e) return false;
  const r = e.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const s = getComputedStyle(e);
  return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
};

const rectOf = e => {
  try {
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  } catch { return { x: 0, y: 0, w: 0, h: 0 }; }
};

const attrMap = e => {
  const o = {};
  try { for (const a of e.attributes) o[a.name] = clip(a.value, 160); } catch {}
  return o;
};

/* ------------------------------------------------ shadow-aware query */
/* Collecting shadow roots is O(n); do it once per snapshot, not per selector. */
function collectShadowRoots() {
  const roots = [];
  const walk = root => {
    let nodes;
    try { nodes = root.querySelectorAll("*"); } catch { return; }
    for (const n of nodes) {
      if (!n.shadowRoot) continue;
      roots.push(n.shadowRoot);
      walk(n.shadowRoot);
    }
  };
  walk(document);
  return roots;
}

/* With `roots` supplied, light DOM and shadow DOM are merged (snapshot).
   Without it, shadow DOM is only consulted when the light DOM has no match
   (locate), which keeps targeting fast and predictable. */
function search(sel, roots) {
  let out = [];
  try { out = [...document.querySelectorAll(sel)]; } catch { return []; }
  if (roots) {
    for (const r of roots) { try { out.push(...r.querySelectorAll(sel)); } catch {} }
  } else if (!out.length) {
    for (const r of collectShadowRoots()) { try { out.push(...r.querySelectorAll(sel)); } catch {} }
  }
  return out;
}

/* ----------------------------------------------------------- labels */
/* Compact label used inside snapshots — kept byte-compatible with v7. */
const txt = e => clean(
  e?.getAttribute?.("aria-label") || e?.getAttribute?.("title") || e?.innerText ||
  e?.getAttribute?.("placeholder") || e?.name || e?.id || e?.tagName || ""
).slice(0, 180);

/* Full accessible name, following the HTML-AAM precedence order.
   Deliberately does NOT fall back to `name`, `id` or the tag name: those are
   what a control is called in code, not what a screen reader announces, and
   treating them as a name would hide genuinely unlabelled fields from the
   accessibility audit. */
function labelFor(e) {
  if (!e || !e.getAttribute) return "";
  const g = a => e.getAttribute(a) || "";
  let name = g("aria-label");
  if (!name) {
    const ids = g("aria-labelledby");
    if (ids) name = ids.split(/\s+/).map(id => {
      const n = document.getElementById(id);
      return n ? clean(n.innerText || n.textContent) : "";
    }).filter(Boolean).join(" ");
  }
  if (!name && e.id) {
    try { const l = document.querySelector(`label[for="${esc(e.id)}"]`); if (l) name = clean(l.innerText || l.textContent); } catch {}
  }
  if (!name) { const l = e.closest?.("label"); if (l) name = clean(l.innerText || l.textContent); }

  const tag = e.tagName;
  const type = String(e.type || "").toLowerCase();
  if (!name && (tag === "IMG" || tag === "AREA" || (tag === "INPUT" && type === "image"))) name = g("alt");
  if (!name && tag === "INPUT" && ["submit", "button", "reset", "image"].includes(type)) name = clean(e.value || "");
  if (!name && (tag === "BUTTON" || tag === "A" || tag === "SUMMARY")) name = clean(e.innerText || e.textContent || "");
  if (!name && (tag === "INPUT" || tag === "TEXTAREA")) name = g("placeholder");
  if (!name) name = g("title");
  return clip(clean(name), 200);
}

const sel = e => {
  if (!e) return "";
  if (e.id) return "#" + esc(e.id);
  let s = e.tagName.toLowerCase();
  if (e.name) s += `[name="${esc(e.name)}"]`;
  if (e.classList?.length) s += "." + [...e.classList].filter(Boolean).slice(0, 2).map(esc).join(".");
  return s;
};

/* stable ids let the model re-target an element after the DOM shifts */
let uid = 0;
function tag(e) {
  let id = e.getAttribute("data-webspider-id");
  if (!id) {
    id = "ws" + (++uid);
    try { e.setAttribute("data-webspider-id", id); } catch {}
  }
  return id;
}

/* ---------------------------------------------------------- locate */
const CANDIDATE_SEL = "button,a,input,textarea,select,[role=button],[role=link],[role=checkbox]," +
  "[role=radio],[role=tab],[role=menuitem],label,summary,[contenteditable=true]";

function findVisibleByText(q) {
  if (!q) return null;
  const visible = search(CANDIDATE_SEL).filter(vis);
  return visible.find(x => norm(txt(x)) === q)
      || visible.find(x => norm(txt(x)).includes(q))
      || visible.find(x => norm(x.value).includes(q))
      || null;
}

function locate(a = {}) {
  let e = null;
  if (a.elementId) {
    const q = `[data-webspider-id="${esc(String(a.elementId))}"]`;
    try { e = document.querySelector(q); } catch {}
    if (!e) { const l = search(q); e = l[0] || null; }
  }
  if (!e && a.selector) {
    const l = search(a.selector);
    e = l.find(vis) || l[0] || null;
  }
  if (!e && a.role) {
    const l = search(`[role="${esc(String(a.role))}"]`);
    e = l.find(vis) || l[0] || null;
  }
  if (!e) {
    const q = norm(a.text || a.label || a.placeholder);
    if (q) e = findVisibleByText(q);
  }
  if (!e && a.index != null) {
    const l = search(a.selector || CANDIDATE_SEL).filter(vis);
    e = l[Number(a.index)] || null;
  }
  return e;
}
window.__webspiderLocate = locate;
window.__webspiderVis = vis;

/* -------------------------------------------------- MAIN-world bridge */
/* main.js writes into these slots; absent in a page that never ran it. */
const bridgeAlive = () => safeBool(() => document.documentElement.getAttribute("data-webspider-main") === "1");
const slotValue = id => { try { return JSON.parse(document.getElementById(id)?.textContent || "[]"); } catch { return []; } };
const dialogPolicy = () => { try { return document.documentElement.getAttribute("data-webspider-dialogs") || "record"; } catch { return "record"; } };

function setDialogPolicy(a = {}) {
  const p = String(a.policy || "").toLowerCase();
  const v = ["record", "accept", "dismiss"].includes(p) ? p : "record";
  try { document.documentElement.setAttribute("data-webspider-dialogs", v); } catch {}
  return { ok: true, policy: v, bridge: bridgeAlive(), note: v === "record" ? "Native dialogs are shown to the user." : `Native dialogs are answered automatically (${v}).` };
}

function consoleLogs(a = {}) {
  const all = slotValue("__webspider_console");
  const counts = {};
  for (const x of all) counts[x.level] = (counts[x.level] || 0) + 1;
  let list = all;
  if (a.level) list = list.filter(x => x.level === String(a.level).toLowerCase());
  if (a.contains) { const q = norm(a.contains); list = list.filter(x => norm(x.text).includes(q)); }
  const limit = Math.max(1, Math.min(500, Number(a.limit) || 100));
  list = list.slice(-limit);
  if (a.clear) { const n = document.getElementById("__webspider_console"); if (n) n.textContent = "[]"; }
  return {
    bridge: bridgeAlive(), total: all.length, counts,
    errors: counts.error || 0, warnings: counts.warn || 0,
    entries: list.map(x => ({ level: x.level, text: clip(x.text, 600), url: clip(x.url, 300) }))
  };
}

function dialogLog(a = {}) {
  const all = slotValue("__webspider_dialogs");
  if (a.clear) { const n = document.getElementById("__webspider_dialogs"); if (n) n.textContent = "[]"; }
  return { bridge: bridgeAlive(), policy: dialogPolicy(), total: all.length, entries: all.slice(-100) };
}

/* --------------------------------------------------- page state */
function hash(s) {
  let h = 2166136261;
  const t = String(s || "");
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

const controlSel = "button,[role=button],input,textarea,select,[contenteditable=true],a[href]";
const controls = roots => search(controlSel, roots).filter(vis);

function stateToken() {
  const body = document.body;
  /* deliberately excludes document.readyState: the token answers "did the page
     content change?", and a page finishing its load is not the agent's doing. */
  return hash([
    location.href, document.title,
    controls().length, safeQueryAll(document, "a[href]").length,
    document.forms.length, clean(body?.innerText || "").length,
    body?.children?.length || 0, Math.round(scrollY / 50)
  ].join("|"));
}

function pageState() {
  const body = document.body;
  const active = document.activeElement;
  const busy = safeBool(() => !!document.querySelector('[aria-busy="true"],[role="progressbar"],[role="status"]'));
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    lang: document.documentElement.lang || "",
    viewport: { w: innerWidth, h: innerHeight },
    scroll: { y: Math.round(scrollY), maxY: Math.max(0, Math.round((document.documentElement.scrollHeight || 0) - innerHeight)) },
    controls: controls().length,
    links: safeQueryAll(document, "a[href]").length,
    forms: document.forms.length,
    images: document.images.length,
    textLength: clean(body?.innerText || "").length,
    busy,
    focused: active && active !== document.body
      ? { tag: active.tagName.toLowerCase(), elementId: tag(active), label: txt(active), selector: sel(active) }
      : null,
    dialogPolicy: dialogPolicy(),
    bridge: bridgeAlive(),
    token: stateToken()
  };
}

/* mark / diff: lets the agent prove that an action actually changed the page */
let mark = null;
function markPage() {
  const s = pageState();
  mark = { token: s.token, url: s.url, text: clean(document.body?.innerText || ""), controls: s.controls, at: Date.now() };
  return { ok: true, token: mark.token, url: mark.url, controls: mark.controls, at: mark.at };
}

const sentences = t => String(t || "").split(/(?<=[.!?؟])\s+|\n+/).map(clean).filter(x => x.length > 2);

function diffPage() {
  const s = pageState();
  const now = clean(document.body?.innerText || "");
  if (!mark) return { ok: true, first: true, changed: true, token: s.token, note: "No marker had been set; nothing to compare against." };
  const before = new Set(sentences(mark.text));
  const after = new Set(sentences(now));
  const added = [...after].filter(x => !before.has(x)).slice(0, 12);
  const removed = [...before].filter(x => !after.has(x)).slice(0, 12);
  return {
    ok: true,
    changed: mark.token !== s.token,
    urlChanged: mark.url !== s.url,
    from: mark.url,
    to: s.url,
    tokenBefore: mark.token,
    tokenAfter: s.token,
    textDelta: now.length - mark.text.length,
    controlsBefore: mark.controls,
    controlsAfter: s.controls,
    added, removed
  };
}

/* -------------------------------------------- human verification */
/* Detection only. WebSpider never solves, clicks or bypasses a challenge —
   it reports it so the run can pause and the user can complete it. */
const HUMAN_VENDORS = [
  { re: /recaptcha|google\.com\/recaptcha/i,                        vendor: "reCAPTCHA" },
  { re: /hcaptcha/i,                                                vendor: "hCaptcha" },
  { re: /challenges\.cloudflare\.com|turnstile|cf-challenge/i,      vendor: "Cloudflare Turnstile" },
  { re: /arkoselabs|funcaptcha/i,                                   vendor: "Arkose FunCaptcha" },
  { re: /geetest/i,                                                 vendor: "GeeTest" },
  { re: /datadome/i,                                                vendor: "DataDome" },
  { re: /perimeterx|px-captcha|human-challenge|_px/i,               vendor: "PerimeterX" },
  { re: /awswaf|aws-waf|amazon.*captcha/i,                          vendor: "AWS WAF" },
  { re: /mtcaptcha/i,                                               vendor: "MTCaptcha" },
  { re: /captcha|challenge-platform/i,                              vendor: "CAPTCHA" }
];
const HUMAN_TEXT = /(i'?m not a robot|i am not a robot|verify (?:you are|you're|that you are) (?:a )?human|are you a human|human verification|complete the security check|checking your browser|verifying you are human|please complete the captcha|solve the challenge|press and hold|slide to verify|من ربات نیستم|تأیید انسان|اثبات اینکه ربات نیستید|کد امنیتی)/i;
const INTERSTITIAL_SEL = "#challenge-running,#cf-challenge-running,#challenge-stage,.cf-browser-verification,.cf-turnstile-wrapper,#px-captcha";

function vendorOf(s) {
  const t = String(s || "");
  for (const v of HUMAN_VENDORS) if (v.re.test(t)) return v.vendor;
  return "";
}

function detectHumanCheck() {
  const kinds = new Set();
  const frames = [];
  const elements = [];
  const texts = [];
  const vendors = new Set();

  /* 1. challenge iframes */
  for (const f of search("iframe,frame")) {
    const hay = [f.src, f.title, f.name, f.id, f.className, f.getAttribute("src")].join(" ");
    const v = vendorOf(hay);
    if (!v && !/challenge|captcha|verify/i.test(hay)) continue;
    if (v) vendors.add(v);
    kinds.add("iframe");
    frames.push({ vendor: v || "unknown", src: clip(String(f.src || ""), 400), title: clip(f.title || "", 120), rect: rectOf(f) });
  }

  /* 2. challenge widgets and containers */
  for (const e of search("[data-sitekey],[class*=captcha],[class*=Captcha],[id*=captcha],[id*=Captcha]," +
                         "[class*=turnstile],[class*=hcaptcha],[class*=g-recaptcha],[class*=challenge],[class*=Challenge]")) {
    const hay = [e.className, e.id, e.getAttribute("data-sitekey"), e.getAttribute("aria-label")].join(" ");
    const v = vendorOf(hay);
    if (!v && !/captcha|challenge|turnstile|verify/i.test(hay)) continue;
    if (v) vendors.add(v);
    kinds.add("widget");
    elements.push({ elementId: tag(e), selector: sel(e), tag: e.tagName.toLowerCase(), label: txt(e), vendor: v || "unknown", rect: rectOf(e) });
  }

  /* 3. interstitial markers (Cloudflare / PerimeterX style) */
  const interstitial = safeBool(() => !!document.querySelector(INTERSTITIAL_SEL));
  if (interstitial) kinds.add("interstitial");

  /* 4. visible text signals, limited to the first slice of the page body */
  const body = document.body;
  if (body) {
    const raw = clean(body.innerText || "").slice(0, 20000);
    const m = raw.match(new RegExp(HUMAN_TEXT.source, "ig")) || [];
    for (const t of [...new Set(m.map(x => clean(x).toLowerCase()))].slice(0, 8)) { texts.push(t); kinds.add("text"); }
  }

  const present = kinds.size > 0;
  return {
    present,
    vendor: [...vendors][0] || (present ? "unknown" : ""),
    vendors: [...vendors],
    kinds: [...kinds],
    frames: frames.slice(0, 10),
    elements: elements.slice(0, 10),
    texts,
    interstitial,
    advice: present
      ? "A human-verification challenge is on the page. Do NOT solve or bypass it. Ask the user to complete it in the browser; the run resumes automatically once it is gone."
      : "No human-verification challenge detected."
  };
}

/* ------------------------------------------------------- snapshot */
function snapshot() {
  const body = document.body;
  const roots = collectShadowRoots();
  const controlsList = controls(roots).slice(0, 120).map(x => ({
    elementId: tag(x),
    tag: x.tagName.toLowerCase(),
    type: x.type || "",
    label: txt(x),
    selector: sel(x),
    value: clean(x.value || "").slice(0, 120)
  }));

  const frames = search("iframe,frame", roots).filter(vis).slice(0, 30).map(x => {
    const r = x.getBoundingClientRect();
    return {
      title: x.title || "", name: x.name || "", src: String(x.src || "").slice(0, 500),
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      sandbox: x.getAttribute("sandbox") || ""
    };
  });

  const humanSignals = clean(body?.innerText || "")
    .match(/captcha|recaptcha|hcaptcha|turnstile|verify you are human|i['’]?m not a robot|من ربات نیستم/ig) || [];
  const humanCheck = detectHumanCheck();

  const forms = [...document.forms].slice(0, 10).map(f => ({
    action: clip(f.action || "", 300),
    method: (f.method || "get").toUpperCase(),
    fields: f.querySelectorAll("input,textarea,select").length,
    elementId: tag(f)
  }));

  return {
    url: location.href,
    title: document.title,
    language: document.documentElement.lang || "",
    viewport: { w: innerWidth, h: innerHeight },
    scrollY,
    documentHeight: Math.max(body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0),
    meta: search("meta[name],meta[property]", roots).slice(0, 35).map(x => ({ name: x.name || x.getAttribute("property"), content: x.content || "" })),
    headings: search("h1,h2,h3,h4", roots).filter(vis).map(txt).filter(Boolean).slice(0, 70),
    links: search("a[href]", roots).filter(vis).slice(0, 90).map(x => ({ text: txt(x), href: x.href })),
    controls: controlsList,
    frames,
    forms,
    humanVerificationSignals: [...new Set(humanSignals.map(x => x.toLowerCase()))],
    humanCheck,
    images: [...document.images].filter(vis).slice(0, 50).map(x => ({
      alt: x.alt || "", src: x.currentSrc || x.src,
      width: x.naturalWidth, height: x.naturalHeight, broken: !x.complete || x.naturalWidth === 0
    })),
    text: clean(body?.innerText || "").slice(0, 16000)
  };
}

/* ----------------------------------------------------- diagnostics */
function diagnostics() {
  const roots = collectShadowRoots();
  const brokenImages = [...document.images].filter(x => !x.complete || x.naturalWidth === 0).slice(0, 40)
    .map(x => ({ src: x.currentSrc || x.src, alt: x.alt || "" }));

  const suspiciousLinks = search("a[href]", roots)
    .filter(x => vis(x) && /^https?:/i.test(x.href) && !x.href.startsWith(location.origin))
    .slice(0, 80).map(x => ({ text: txt(x), href: x.href }));

  const forms = [...document.forms].map(f => ({
    action: f.action, method: f.method || "get",
    inputs: f.querySelectorAll("input,textarea,select").length
  })).slice(0, 30);

  let resources = [];
  try { resources = performance.getEntriesByType("resource"); } catch {}
  const slowResources = resources
    .filter(x => /^(https?|wss?):/i.test(x.name) && Number(x.duration) > 15000)
    .slice(-30).map(x => ({ url: x.name, duration: Math.round(x.duration) }));

  const consoleEntries = slotValue("__webspider_console");
  const consoleErrors = consoleEntries.filter(x => x.level === "error").slice(-20)
    .map(x => ({ text: clip(x.text, 400), url: clip(x.url, 200) }));

  return {
    url: location.href, title: document.title,
    brokenImages, forms, slowResources,
    performance: { resources: resources.length },
    capturedErrors: (window.__webspiderErrors || []).slice(-30),
    consoleErrors,
    consoleCount: consoleEntries.length,
    dialogs: slotValue("__webspider_dialogs").slice(-10),
    suspiciousLinks,
    humanCheck: detectHumanCheck()
  };
}

/* ---------------------------------------------------- read tools */
function describe(e, i) {
  return {
    index: i,
    elementId: tag(e),
    tag: e.tagName.toLowerCase(),
    type: (e.type || "").toLowerCase(),
    role: e.getAttribute?.("role") || "",
    label: txt(e),
    name: labelFor(e),
    selector: sel(e),
    text: clip(clean(e.innerText || e.textContent || ""), 200),
    value: clip(clean(e.value ?? ""), 160),
    href: e.href ? clip(String(e.href), 400) : "",
    rect: rectOf(e),
    visible: vis(e),
    disabled: !!e.disabled
  };
}

/* An invalid selector must fail loudly: querySelectorAll swallows the
   SyntaxError and returns an empty list, which would read to the model as
   "that element does not exist" instead of "your selector is broken". */
function assertSelector(s) {
  const v = String(s || "");
  if (!v) throw Error("A CSS selector is required");
  try { document.querySelector(v); } catch { throw Error(`Invalid CSS selector: ${v}`); }
  return v;
}

function queryElements(a = {}) {
  const selector = assertSelector(a.selector);
  const found = a.shadow === false ? safeQueryAll(document, selector) : search(selector, collectShadowRoots());
  const total = found.length;
  let list = a.visible === false ? found : found.filter(vis);
  const offset = Math.max(0, Number(a.offset) || 0);
  const limit = Math.max(1, Math.min(MAX.items, Number(a.limit) || 40));
  return {
    selector, total, visible: list.length, offset,
    items: list.slice(offset, offset + limit).map((e, i) => {
      const d = describe(e, offset + i);
      if (a.attrs) d.attrs = attrMap(e);
      return d;
    })
  };
}

function getTable(a = {}) {
  const e = locate(a);
  if (!e) throw Error("Table not found");
  const table = e.tagName === "TABLE" ? e : (e.closest?.("table") || e.querySelector?.("table"));
  if (!table) throw Error("No <table> in the target element");

  /* nested tables: keep only rows whose nearest table is this one */
  const allRows = safeQueryAll(table, "tr").filter(r => r.closest("table") === table);
  const thead = table.querySelector("thead");
  let headers = [];
  let dataRows = allRows;
  if (thead) {
    /* every row inside <thead> is header material, never data */
    const htr = thead.querySelector("tr");
    if (htr) headers = [...htr.children].map(c => clean(c.innerText || c.textContent));
    dataRows = allRows.filter(r => !thead.contains(r));
  } else if (allRows.length && allRows[0].querySelector("th") && !allRows[0].querySelector("td")) {
    /* a table with no <thead> whose first row is all <th> is still a header row */
    headers = [...allRows[0].children].map(c => clean(c.innerText || c.textContent));
    dataRows = allRows.slice(1);
  }
  dataRows = dataRows.filter(r => r.querySelectorAll("td,th").length);

  const limit = Math.max(1, Math.min(MAX.items, Number(a.limit) || 100));
  const rows = dataRows.slice(0, limit)
    .map(r => [...r.children].map(c => clean(c.innerText || c.textContent).slice(0, 300)));

  const out = {
    elementId: tag(table),
    selector: sel(table),
    caption: clean(table.querySelector("caption")?.innerText || ""),
    headers,
    rowCount: dataRows.length,
    returned: rows.length,
    rows
  };
  if (a.format === "objects" && headers.length) {
    out.objects = rows.map(r => { const o = {}; headers.forEach((h, i) => { o[h || `col${i + 1}`] = r[i] ?? ""; }); return o; });
    delete out.rows;
  }
  return out;
}

function getFormFields(a = {}) {
  let scope = document;
  if (a.selector || a.elementId || a.text || a.label) {
    const e = locate(a);
    if (!e) throw Error("Form not found");
    scope = e.closest?.("form") || e;
  }
  const formEl = scope.tagName === "FORM" ? scope
    : (scope.closest?.("form") || scope.querySelector?.("form") || null);

  const fields = safeQueryAll(scope, "input,textarea,select,[contenteditable=true]").filter(vis);
  const items = fields.slice(0, MAX.items).map(e => {
    const type = (e.type || "").toLowerCase();
    const item = {
      elementId: tag(e),
      tag: e.tagName.toLowerCase(),
      type,
      name: e.name || "",
      label: labelFor(e),
      selector: sel(e),
      required: !!(e.required || e.getAttribute("aria-required") === "true"),
      value: type === "password" ? "•••" : clip(clean(e.value ?? ""), 160),
      disabled: !!e.disabled,
      invalid: safeBool(() => typeof e.checkValidity === "function" && !e.checkValidity())
    };
    if (typeof e.checked === "boolean" && (type === "checkbox" || type === "radio")) item.checked = e.checked;
    if (e.tagName === "SELECT") item.options = [...e.options].slice(0, 40).map(o => ({ value: o.value, label: clean(o.text) }));
    return item;
  });

  return {
    action: clip(formEl?.action || location.href, 400),
    method: String(formEl?.method || "get").toUpperCase(),
    elementId: formEl ? tag(formEl) : "",
    count: items.length,
    invalid: items.filter(i => i.invalid).length,
    fields: items
  };
}

function textNodeHits(root, q, limit) {
  const out = [];
  if (!q) return out;
  let w;
  try {
    w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) { return clean(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; }
    });
  } catch { return out; }
  let n, guard = 0;
  while ((n = w.nextNode()) && guard++ < 20000 && out.length < limit) {
    const v = clean(n.nodeValue);
    if (v.toLowerCase().includes(q)) out.push(n);
  }
  return out;
}

function findInPage(a = {}) {
  const raw = String(a.query || a.text || "");
  const q = norm(raw);
  if (!q) throw Error("A query is required");
  const body = document.body;
  if (!body) return { query: raw, count: 0, hits: [], elements: [] };

  const flat = clean(body.innerText || body.textContent || "");
  const hay = flat.toLowerCase();
  const needle = clean(raw).toLowerCase();
  const maxHits = Math.max(1, Math.min(50, Number(a.limit) || 20));
  const hits = [];
  let idx = 0, guard = 0;
  while (hits.length < maxHits && guard++ < 5000) {
    const at = hay.indexOf(needle, idx);
    if (at < 0) break;
    hits.push({
      at,
      before: clip(flat.slice(Math.max(0, at - 90), at), 90),
      match: flat.slice(at, at + needle.length),
      after: clip(flat.slice(at + needle.length, at + needle.length + 140), 140)
    });
    idx = at + needle.length;
  }

  const seen = new Set();
  const elements = [];
  for (const node of textNodeHits(body, needle, 200)) {
    const p = node.parentElement;
    if (!p || seen.has(p) || !vis(p)) continue;
    seen.add(p);
    elements.push({ elementId: tag(p), selector: sel(p), text: clip(clean(p.innerText || p.textContent), 200) });
    if (elements.length >= 20) break;
  }

  return { query: raw, count: hits.length, hits, elements };
}

function getSelectionInfo() {
  try {
    const s = window.getSelection();
    const text = clean(s?.toString() || "");
    return { text: clip(text, 4000), length: text.length, empty: !text };
  } catch { return { text: "", length: 0, empty: true }; }
}

function networkLog(a = {}) {
  let entries = [];
  try { entries = performance.getEntriesByType("resource"); } catch {}
  let list = entries.map(e => ({
    url: clip(String(e.name || ""), 400),
    type: e.initiatorType || "",
    duration: Math.round(Number(e.duration) || 0),
    start: Math.round(Number(e.startTime) || 0),
    size: Math.round(Number(e.transferSize ?? e.encodedBodySize) || 0),
    cached: Number(e.transferSize) === 0 && Number(e.decodedBodySize) > 0
  }));
  if (a.kind) list = list.filter(x => x.type === String(a.kind));
  if (a.slowest) list = [...list].sort((x, y) => y.duration - x.duration);
  const limit = Math.max(1, Math.min(MAX.items, Number(a.limit) || 100));
  const totalSize = list.reduce((s, x) => s + x.size, 0);
  return {
    count: entries.length,
    totalSize, totalKB: Math.round(totalSize / 1024),
    slow: list.filter(x => x.duration > 1000).length,
    failed: safeBool(() => typeof performance.getEntriesByType === "function" && false),
    entries: list.slice(0, limit)
  };
}

/* --------------------------------------------------- colour maths */
function parseColor(v) {
  const s = String(v || "").trim();
  if (!s) return null;
  let m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (p.length < 3 || p.slice(0, 3).some(n => !isFinite(n))) return null;
    return { r: clamp(p[0], 0, 255), g: clamp(p[1], 0, 255), b: clamp(p[2], 0, 255), a: p.length > 3 && isFinite(p[3]) ? clamp(p[3], 0, 1) : 1 };
  }
  m = s.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split("").map(c => c + c).join("");
    return {
      r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16),
      a: h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
    };
  }
  const named = { transparent: { r: 0, g: 0, b: 0, a: 0 }, white: { r: 255, g: 255, b: 255, a: 1 }, black: { r: 0, g: 0, b: 0, a: 1 } };
  return named[s.toLowerCase()] || null;
}
function luminance(c) {
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}
function contrastRatio(a, b) {
  const l1 = luminance(a), l2 = luminance(b);
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}
const blend = (top, bottom) => {
  const a = top.a ?? 1;
  return { r: Math.round(top.r * a + bottom.r * (1 - a)), g: Math.round(top.g * a + bottom.g * (1 - a)), b: Math.round(top.b * a + bottom.b * (1 - a)), a: 1 };
};
const WHITE = { r: 255, g: 255, b: 255, a: 1 };

function effectiveBackground(e) {
  let node = e, acc = null;
  for (let i = 0; i < 24 && node; i++) {
    let c = null;
    try { c = parseColor(getComputedStyle(node).backgroundColor); } catch {}
    if (c && c.a > 0) { acc = acc ? blend(acc, c) : c; if (c.a >= 0.999) break; }
    node = node.parentElement;
  }
  if (!acc || acc.a <= 0) return WHITE;
  return acc.a >= 0.999 ? acc : blend(acc, WHITE);
}
const rgbToHex = c => "#" + [c.r, c.g, c.b].map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0")).join("");

function stylesOf(a = {}) {
  const e = locate(a);
  if (!e) throw Error("Element not found");
  let s = {};
  try { s = getComputedStyle(e); } catch {}
  const pick = ["display", "visibility", "opacity", "position", "zIndex", "color", "backgroundColor", "fontSize",
    "fontWeight", "fontFamily", "lineHeight", "letterSpacing", "textAlign", "margin", "padding", "border",
    "borderRadius", "width", "height", "overflow", "cursor", "pointerEvents", "boxShadow", "transform"];
  const styles = {};
  for (const p of pick) { const v = s[p]; if (v != null && v !== "") styles[p] = clip(v, 120); }
  const fg = parseColor(s.color);
  const bg = effectiveBackground(e);
  return {
    selector: sel(e), label: txt(e), tag: e.tagName.toLowerCase(), rect: rectOf(e),
    hidden: !vis(e), styles,
    contrast: fg ? { ratio: round2(contrastRatio(fg.a < 1 ? blend(fg, bg) : fg, bg)), foreground: String(s.color || ""), background: rgbToHex(bg) } : null
  };
}

/* --------------------------------------------------------- audits */
const SEV = { high: 12, medium: 6, low: 2 };
const scoreOf = issues => Math.max(0, Math.min(100, 100 - issues.reduce((s, i) => s + (SEV[i.severity] || 2), 0)));

function seoAudit() {
  const issues = [];
  const add = (severity, msg, extra) => issues.push({ severity, msg, ...extra });
  const t = clean(document.title);
  if (!t) add("high", "The page has no <title>.");
  else if (t.length < 10) add("medium", `The title is very short (${t.length} characters).`, { value: clip(t, 120) });
  else if (t.length > 65) add("low", `The title may be truncated in search results (${t.length} characters).`, { value: clip(t, 120) });

  const md = document.querySelector('meta[name="description"]')?.content || "";
  if (!md) add("high", "Missing meta description.");
  else if (md.length < 50 || md.length > 165) add("low", `Meta description is ${md.length} characters (50–160 recommended).`);

  const h1s = safeQueryAll(document, "h1").filter(vis);
  if (!h1s.length) add("high", "No visible <h1> on the page.");
  else if (h1s.length > 1) add("medium", `${h1s.length} <h1> elements; use exactly one.`);

  const canonical = document.querySelector('link[rel="canonical"]')?.href || "";
  if (!canonical) add("medium", "No canonical link is declared.");

  const robots = (document.querySelector('meta[name="robots"]')?.content || "").toLowerCase();
  if (/noindex/.test(robots)) add("high", "The robots meta tag contains noindex — the page will not be indexed.", { value: robots });

  const missingOg = ["og:title", "og:description", "og:image"].filter(p => !document.querySelector(`meta[property="${p}"]`));
  if (missingOg.length) add("low", `Missing Open Graph tags: ${missingOg.join(", ")}.`);

  const noAlt = [...document.images].filter(i => vis(i) && !i.alt).length;
  if (noAlt) add("medium", `${noAlt} visible image(s) have no alt text.`, { count: noAlt });

  if (!document.documentElement.lang) add("medium", "The <html> element has no lang attribute.");
  if (!document.querySelectorAll('script[type="application/ld+json"]').length) add("low", "No JSON-LD structured data found.");

  if (location.protocol === "https:" && safeQueryAll(document, "img[src^='http://'],script[src^='http://'],link[href^='http://']").length) {
    add("high", "Mixed content: insecure http:// subresources are loaded on an https page.");
  }

  return {
    kind: "seo", score: scoreOf(issues), issues,
    stats: {
      title: clip(t, 120), titleLength: t.length, descriptionLength: md.length,
      h1: h1s.length, headings: safeQueryAll(document, "h1,h2,h3,h4,h5,h6").length,
      links: safeQueryAll(document, "a[href]").length, images: document.images.length,
      canonical: clip(canonical, 300), structuredData: document.querySelectorAll('script[type="application/ld+json"]').length,
      lang: document.documentElement.lang || ""
    }
  };
}

function contrastSample() {
  const items = [];
  let checked = 0;
  const nodes = safeQueryAll(document, "p,span,a,li,h1,h2,h3,h4,button,label,td,th,small,strong,em")
    .filter(vis).slice(0, 400);
  for (const e of nodes) {
    const hasText = [...(e.childNodes || [])].some(n => n.nodeType === 3 && clean(n.nodeValue));
    if (!hasText) continue;
    let s = {};
    try { s = getComputedStyle(e); } catch {}
    const fg = parseColor(s.color);
    if (!fg || fg.a === 0) continue;
    const size = parseFloat(s.fontSize) || 0;
    const weight = Number(s.fontWeight) || 400;
    const big = size >= 24 || (size >= 18.66 && weight >= 700);
    const bg = effectiveBackground(e);
    const eff = fg.a < 1 ? blend(fg, bg) : fg;
    checked++;
    const ratio = contrastRatio(eff, bg);
    const required = big ? 3 : 4.5;
    if (ratio < required) items.push({
      selector: sel(e), text: clip(clean(e.innerText || ""), 80),
      ratio: round2(ratio), required, color: String(s.color || ""), background: rgbToHex(bg)
    });
    if (items.length >= 12) break;
  }
  return { items, checked };
}

function a11yAudit() {
  const issues = [];
  const add = (severity, msg, extra) => issues.push({ severity, msg, ...extra });

  if (!document.documentElement.lang) add("medium", "The <html> element has no lang attribute.");

  const imgs = [...document.images].filter(vis);
  const noAltAttr = imgs.filter(i => !i.hasAttribute("alt"));
  if (noAltAttr.length) add("high", `${noAltAttr.length} image(s) have no alt attribute at all.`, { count: noAltAttr.length, samples: noAltAttr.slice(0, 5).map(i => clip(i.currentSrc || i.src, 120)) });
  const weakAlt = imgs.filter(i => i.alt && /^(image|photo|picture|logo|icon|banner|img)$/i.test(clean(i.alt)));
  if (weakAlt.length) add("low", `${weakAlt.length} image(s) use non-descriptive alt text.`, { count: weakAlt.length });

  const interactive = safeQueryAll(document, "button,a[href],input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=checkbox],[role=radio],[contenteditable=true]").filter(vis);
  const unnamed = interactive.filter(e => !labelFor(e));
  if (unnamed.length) add("high", `${unnamed.length} interactive control(s) have no accessible name.`, { count: unnamed.length, samples: unnamed.slice(0, 6).map(sel) });

  const inputs = safeQueryAll(document, "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]),textarea,select").filter(vis);
  const unlabelled = inputs.filter(e => !labelFor(e));
  if (unlabelled.length) add("high", `${unlabelled.length} form field(s) have no label.`, { count: unlabelled.length, samples: unlabelled.slice(0, 6).map(sel) });

  const positiveTab = safeQueryAll(document, "[tabindex]").filter(e => Number(e.getAttribute("tabindex")) > 0);
  if (positiveTab.length) add("medium", `${positiveTab.length} element(s) use a positive tabindex, which breaks natural focus order.`);

  const framesNoTitle = safeQueryAll(document, "iframe").filter(f => vis(f) && !clean(f.title) && !f.getAttribute("aria-label")).length;
  if (framesNoTitle) add("medium", `${framesNoTitle} iframe(s) have no title attribute.`);

  const seen = {}, dup = [];
  for (const e of safeQueryAll(document, "[id]")) {
    if (seen[e.id]) { if (seen[e.id] === 1) dup.push(e.id); seen[e.id]++; } else seen[e.id] = 1;
  }
  if (dup.length) add("medium", `${dup.length} duplicate id(s): ${dup.slice(0, 5).join(", ")}.`, { ids: dup.slice(0, 10) });

  const hiddenFocusable = safeQueryAll(document, '[aria-hidden="true"]')
    .filter(e => e.querySelector("a[href],button,input,select,textarea,[tabindex]")).length;
  if (hiddenFocusable) add("high", `${hiddenFocusable} aria-hidden container(s) still hold focusable elements.`);

  const levels = safeQueryAll(document, "h1,h2,h3,h4,h5,h6").filter(vis).map(h => Number(h.tagName[1]));
  let skips = 0;
  for (let i = 1; i < levels.length; i++) if (levels[i] - levels[i - 1] > 1) skips++;
  if (skips) add("low", `${skips} heading level skip(s) in the document outline.`);

  const contrast = contrastSample();
  if (contrast.items.length) {
    add(contrast.items.length > 3 ? "high" : "medium",
      `${contrast.items.length} visible text element(s) fall below the WCAG AA contrast ratio.`,
      { count: contrast.items.length, samples: contrast.items.slice(0, 6) });
  }

  return {
    kind: "a11y", score: scoreOf(issues), issues,
    stats: { images: imgs.length, interactive: interactive.length, inputs: inputs.length, contrastChecked: contrast.checked }
  };
}

function perfAudit() {
  const issues = [];
  const add = (severity, msg, extra) => issues.push({ severity, msg, ...extra });
  let entries = [], nav = null;
  try { entries = performance.getEntriesByType("resource"); } catch {}
  try { nav = performance.getEntriesByType("navigation")[0] || null; } catch {}

  const slow = entries.filter(e => Number(e.duration) > 1000);
  if (slow.length) add("medium", `${slow.length} resource(s) took longer than 1 s to load.`,
    { count: slow.length, samples: slow.slice(-5).map(e => ({ url: clip(e.name, 200), duration: Math.round(e.duration) })) });

  const heavy = entries.filter(e => Number(e.transferSize || 0) > 500000);
  if (heavy.length) add("low", `${heavy.length} resource(s) transfer more than 500 KB.`,
    { count: heavy.length, samples: heavy.slice(0, 5).map(e => ({ url: clip(e.name, 200), kb: Math.round(Number(e.transferSize || 0) / 1024) })) });

  const domNodes = document.getElementsByTagName("*").length;
  if (domNodes > 3000) add("medium", `The DOM holds ${domNodes} elements; large DOMs slow interaction.`, { count: domNodes });

  const scripts = safeQueryAll(document, "script[src]").length;
  if (scripts > 25) add("low", `${scripts} external scripts are loaded.`);

  const noDim = [...document.images].filter(i => vis(i) && !i.getAttribute("width") && !i.getAttribute("height")).length;
  if (noDim) add("low", `${noDim} image(s) declare no width/height, which can cause layout shift.`, { count: noDim });

  const dcl = nav ? Math.round(nav.domContentLoadedEventEnd || 0) : 0;
  if (dcl > 4000) add("medium", `DOMContentLoaded took ${dcl} ms.`);

  const totalSize = entries.reduce((s, e) => s + Number(e.transferSize || 0), 0);
  return {
    kind: "perf", score: scoreOf(issues), issues,
    stats: {
      resources: entries.length, slow: slow.length, domNodes, scripts,
      totalSize, totalKB: Math.round(totalSize / 1024),
      domContentLoadedMs: dcl, loadMs: nav ? Math.round(nav.loadEventEnd || 0) : 0
    }
  };
}

function linkAudit() {
  const issues = [];
  const add = (severity, msg, extra) => issues.push({ severity, msg, ...extra });
  const links = safeQueryAll(document, "a[href]").filter(vis);
  const origin = location.origin;
  let internal = 0, external = 0;
  const dead = [], blank = [], insecure = [], puny = [];
  const schemes = {};

  for (const a of links) {
    const href = a.getAttribute("href") || "";
    if (!href || href === "#" || /^javascript:void/i.test(href)) { dead.push({ text: txt(a), href: clip(href, 120) }); continue; }
    if (href.startsWith("#")) continue;
    if (/^mailto:|^tel:/i.test(href)) { const s = href.split(":")[0].toLowerCase(); schemes[s] = (schemes[s] || 0) + 1; continue; }
    if (/^javascript:/i.test(href)) { schemes.javascript = (schemes.javascript || 0) + 1; continue; }
    let u;
    try { u = new URL(a.href); } catch { continue; }
    if (u.hostname.startsWith("xn--") || /[\u0400-\u04ff\u4e00-\u9fff]/.test(u.hostname)) puny.push({ text: txt(a), href: clip(u.href, 200) });
    if (u.origin === origin) internal++; else external++;
    if (location.protocol === "https:" && u.protocol === "http:") insecure.push({ text: txt(a), href: clip(u.href, 200) });
    if (a.target === "_blank" && !/noopener|noreferrer/i.test(a.rel || "")) blank.push({ text: txt(a), href: clip(u.href, 200) });
  }

  const noName = links.filter(a => !labelFor(a)).length;

  if (dead.length) add("medium", `${dead.length} link(s) point to "#", an empty href or javascript:void.`, { count: dead.length, samples: dead.slice(0, 6) });
  if (insecure.length) add("high", `${insecure.length} link(s) downgrade to insecure http:// on an https page.`, { count: insecure.length, samples: insecure.slice(0, 6) });
  if (blank.length) add("low", `${blank.length} target="_blank" link(s) are missing rel="noopener".`, { count: blank.length, samples: blank.slice(0, 6) });
  if (puny.length) add("high", `${puny.length} link(s) use punycode or non-Latin hostnames that may be lookalikes.`, { count: puny.length, samples: puny.slice(0, 6) });
  if (noName) add("low", `${noName} link(s) render with no text or accessible name.`, { count: noName });

  return {
    kind: "links", score: scoreOf(issues), issues,
    stats: { total: links.length, internal, external, dead: dead.length, noopenerMissing: blank.length, insecure: insecure.length, unnamed: noName, schemes }
  };
}

function contentAudit() {
  const issues = [];
  const add = (severity, msg, extra) => issues.push({ severity, msg, ...extra });
  const text = clean(document.body?.innerText || document.body?.textContent || "");
  const words = text ? text.split(/\s+/).length : 0;
  if (words < 120) add("medium", `Thin content: only ${words} words on the page.`, { count: words });

  const headings = safeQueryAll(document, "h1,h2,h3,h4,h5,h6").filter(vis).map(e => clean(e.innerText || "")).filter(Boolean);
  if (!headings.length) add("high", "The page has no headings, which hurts scannability and SEO.");
  const dupes = [...new Set(headings.filter((x, i) => headings.indexOf(x) !== i))];
  if (dupes.length) add("low", `${dupes.length} duplicated heading(s).`, { count: dupes.length, samples: dupes.slice(0, 6) });

  if (/lorem ipsum|dolor sit amet|placeholder text/i.test(text)) add("high", "Placeholder (lorem ipsum) text is still present on the page.");

  const ctaRe = /(buy|order|subscribe|sign ?up|log ?in|contact|start|try|get started|download|add to cart|book|request|خرید|ثبت|ورود|تماس|سفارش)/i;
  const ctas = safeQueryAll(document, "button,a[href],input[type=submit]").filter(vis).filter(e => ctaRe.test(labelFor(e))).length;
  if (!ctas) add("low", "No obvious call-to-action was found.");

  const empty = safeQueryAll(document, "a[href],button").filter(vis).filter(e => !labelFor(e)).length;
  if (empty) add("medium", `${empty} visible control(s) render with no text at all.`, { count: empty });

  const paragraphs = safeQueryAll(document, "p").filter(vis).length;
  return {
    kind: "content", score: scoreOf(issues), issues,
    stats: {
      words, characters: text.length, readingMinutes: Math.max(1, Math.round(words / 220)),
      paragraphs, headings: headings.length, ctas, forms: document.forms.length
    }
  };
}

function audit(a = {}) {
  const kind = String(a.kind || "seo").toLowerCase();
  const map = {
    seo: seoAudit, a11y: a11yAudit, accessibility: a11yAudit,
    perf: perfAudit, performance: perfAudit,
    links: linkAudit, link: linkAudit, content: contentAudit
  };
  if (kind === "all") {
    const kinds = { seo: seoAudit(), a11y: a11yAudit(), perf: perfAudit(), links: linkAudit(), content: contentAudit() };
    const values = Object.values(kinds);
    return {
      kind: "all", url: location.href, title: document.title,
      score: Math.round(values.reduce((s, r) => s + r.score, 0) / values.length),
      issues: values.reduce((s, r) => s + r.issues.length, 0),
      kinds
    };
  }
  const f = map[kind];
  if (!f) throw Error(`Unknown audit kind "${kind}". Use seo, a11y, perf, links, content or all.`);
  const r = f();
  r.url = location.href;
  r.title = document.title;
  return r;
}

/* --------------------------------------------------------- actions */
function click(a) {
  const e = locate(a);
  if (!e) throw Error("Element not found");
  if (e.disabled) throw Error("Element is disabled");
  e.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
  highlight({ element: e, color: "#f2b03c", duration: 900 });
  try { e.focus?.({ preventScroll: true }); } catch {}
  e.click();
  return { ok: true, label: txt(e), selector: sel(e), elementId: e.getAttribute("data-webspider-id") || "" };
}

function setValue(e, v) {
  /* isContentEditable is false for hidden/offscreen nodes, so check the attribute too */
  if (e.isContentEditable || e.hasAttribute("contenteditable")) {
    e.focus();
    e.textContent = v;
    e.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: v }));
    e.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  if (e.tagName !== "INPUT" && e.tagName !== "TEXTAREA") {
    throw Error(`Cannot type into <${e.tagName.toLowerCase()}>`);
  }
  const proto = e.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(e, v); else e.value = v;
  e.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: v }));
  e.dispatchEvent(new Event("change", { bubbles: true }));
}

function type(a) {
  const e = locate(a);
  if (!e) throw Error("Input not found");
  e.scrollIntoView({ behavior: "instant", block: "center" });
  try { e.focus(); } catch {}
  const v = String(a.value ?? "");
  setValue(e, v);
  return { ok: true, label: txt(e), selector: sel(e), elementId: e.getAttribute("data-webspider-id") || "", value: v.slice(0, 300) };
}

function clearField(a) {
  const e = locate(a);
  if (!e) throw Error("Field not found");
  setValue(e, "");
  return { ok: true, cleared: true, label: txt(e), selector: sel(e), elementId: tag(e) };
}

function select(a) {
  const e = locate(a);
  if (!e || e.tagName !== "SELECT") throw Error("Select element not found");
  const target = String(a.value ?? a.label ?? "").toLowerCase();
  const opt = [...e.options].find(o => o.value.toLowerCase() === target)
           || [...e.options].find(o => norm(o.text).includes(norm(target)));
  if (!opt) throw Error("Option not found");
  e.value = opt.value;
  e.dispatchEvent(new Event("input", { bubbles: true }));
  e.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, value: opt.value, label: clean(opt.text) };
}

function check(a) {
  const e = locate(a);
  if (!e) throw Error("Element not found");
  const type = (e.type || "").toLowerCase();
  if (type !== "checkbox" && type !== "radio") throw Error(`check expects a checkbox or radio, got <${e.tagName.toLowerCase()} type="${type}">`);
  const want = a.value === false || a.value === "false" ? false : true;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set;
  if (setter) setter.call(e, want); else e.checked = want;
  e.dispatchEvent(new Event("input", { bubbles: true }));
  e.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, checked: e.checked, type, label: txt(e), selector: sel(e), elementId: tag(e) };
}

function hover(a) {
  const e = locate(a);
  if (!e) throw Error("Element not found");
  e.scrollIntoView({ behavior: "instant", block: "center" });
  const r = e.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2) };
  for (const t of ["pointerover", "mouseover", "mouseenter", "mousemove"]) {
    try { e.dispatchEvent(new MouseEvent(t, opts)); } catch {}
  }
  return { ok: true, label: txt(e), selector: sel(e), rect: rectOf(e) };
}

function focusEl(a) {
  const e = locate(a);
  if (!e) throw Error("Element not found");
  e.scrollIntoView({ behavior: "instant", block: "center" });
  try { e.focus({ preventScroll: true }); } catch { try { e.focus(); } catch {} }
  return { ok: true, focused: document.activeElement === e, label: txt(e), selector: sel(e), elementId: tag(e) };
}

function clickAt(a = {}) {
  const x = Math.round(Number(a.x));
  const y = Math.round(Number(a.y));
  if (!isFinite(x) || !isFinite(y)) throw Error("click_at needs numeric x and y");
  let target = null;
  try { target = document.elementFromPoint(x, y); } catch {}
  if (!target) target = document.body;
  if (!target) throw Error("Nothing to click at that point");
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
  for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    try { target.dispatchEvent(new MouseEvent(t, opts)); } catch {}
  }
  return { ok: true, x, y, target: { tag: target.tagName.toLowerCase(), elementId: tag(target), selector: sel(target), label: txt(target) } };
}

function submitForm(a = {}) {
  let form = null;
  if (a.selector || a.elementId || a.text || a.label) {
    const e = locate(a);
    if (!e) throw Error("Form not found");
    form = e.tagName === "FORM" ? e : (e.closest?.("form") || null);
  } else {
    form = document.forms[0] || null;
  }
  if (!form) throw Error("No form found to submit");
  highlight({ element: form, color: "#f2b03c", duration: 700 });
  if (typeof form.requestSubmit === "function") form.requestSubmit();
  else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  return { ok: true, action: clip(form.action || "", 300), method: String(form.method || "get").toUpperCase(), elementId: tag(form) };
}

function key(a) {
  const k = String(a.key || "").trim();
  if (!k) throw Error("A key name is required");
  const e = locate(a) || document.activeElement || document.body;
  try { e.focus?.({ preventScroll: true }); } catch {}
  const target = e || document;
  const opts = { key: k, bubbles: true, cancelable: true };
  const down = new KeyboardEvent("keydown", opts);
  target.dispatchEvent(down);
  if (k.length === 1) target.dispatchEvent(new KeyboardEvent("keypress", opts));
  target.dispatchEvent(new KeyboardEvent("keyup", opts));
  if (k === "Enter" && !down.defaultPrevented) {
    const form = e && e.form;
    if (form && typeof form.requestSubmit === "function") { try { form.requestSubmit(); } catch {} }
  }
  return { ok: true, key: k, label: txt(e), selector: sel(e) };
}

async function wait(a) {
  const ms = Math.min(8000, Math.max(80, Number(a.ms || 250)));
  await new Promise(r => setTimeout(r, ms));
  return { waited: ms };
}

async function scroll(a) {
  const px = Number(a.pixels || 650);
  window.scrollBy({ top: px, behavior: "smooth" });
  await new Promise(r => setTimeout(r, 140));
  return { scrollY, documentHeight: document.documentElement.scrollHeight };
}

async function scrollTo(a = {}) {
  if (a.elementId || a.selector || a.text || a.label) {
    const e = locate(a);
    if (!e) throw Error("Element not found");
    e.scrollIntoView({ behavior: "smooth", block: a.block || "center" });
    await new Promise(r => setTimeout(r, 180));
    return { ok: true, scrolledTo: "element", label: txt(e), selector: sel(e), rect: rectOf(e) };
  }
  const y = Number(a.y ?? a.pixels ?? 0);
  window.scrollTo({ top: y, behavior: "smooth" });
  await new Promise(r => setTimeout(r, 180));
  return { ok: true, scrolledTo: "y", scrollY, documentHeight: document.documentElement.scrollHeight };
}

function extract(a) {
  const e = a.selector ? locate(a) : document.body;
  if (!e) throw Error("Container not found");
  const format = String(a.format || "text").toLowerCase();
  if (format === "html") return { format: "html", html: String(e.innerHTML || "").slice(0, 18000) };
  if (format === "links") {
    return { format: "links", links: [...e.querySelectorAll("a[href]")].slice(0, 120).map(x => ({ text: txt(x), href: x.href })) };
  }
  if (format === "table") return { format: "table", ...getTable(a) };
  return { format: "text", text: clean(e.innerText || e.textContent || "").slice(0, 18000) };
}

/* ------------------------------------------------------ wait tools */
function waitForElement(a = {}) {
  const selector = a.selector ? assertSelector(a.selector) : "";
  const q = norm(a.text || a.label);
  if (!selector && !q) throw Error("wait_for_element needs a selector or text");
  const timeout = clampMs(a.timeout, 200, 20000, 6000);
  return new Promise(resolve => {
    const started = Date.now();
    const tick = () => {
      let hit = null;
      if (selector) { const l = search(selector); hit = l.find(vis) || l[0] || null; }
      if (!hit && q) hit = findVisibleByText(q);
      if (hit) return resolve({ ok: true, found: true, waited: Date.now() - started, elementId: tag(hit), label: txt(hit), selector: sel(hit) });
      if (Date.now() - started >= timeout) return resolve({ ok: true, found: false, timedOut: true, waited: Date.now() - started, timeout });
      setTimeout(tick, 120);
    };
    tick();
  });
}

function waitForText(a = {}) {
  const q = norm(a.text || a.query);
  if (!q) throw Error("wait_for_text needs text");
  const timeout = clampMs(a.timeout, 200, 20000, 6000);
  return new Promise(resolve => {
    const started = Date.now();
    const tick = () => {
      const body = document.body;
      if (body && norm(body.innerText || body.textContent || "").includes(q)) {
        return resolve({ ok: true, found: true, waited: Date.now() - started, query: a.text || a.query });
      }
      if (Date.now() - started >= timeout) return resolve({ ok: true, found: false, timedOut: true, waited: Date.now() - started, timeout });
      setTimeout(tick, 150);
    };
    tick();
  });
}

function waitForDomStable(a = {}) {
  const quiet = clampMs(a.quiet, 80, 5000, 500);
  const timeout = clampMs(a.timeout, 200, 20000, 6000);
  return new Promise(resolve => {
    const started = Date.now();
    let last = Date.now(), mutations = 0, obs = null, timer = null, done = false;
    const settle = stable => {
      if (done) return;
      done = true;
      try { obs && obs.disconnect(); } catch {}
      if (timer) clearInterval(timer);
      resolve({ ok: true, stable, mutations, waited: Date.now() - started });
    };
    try {
      obs = new MutationObserver(() => { mutations++; last = Date.now(); });
      obs.observe(document.documentElement || document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    } catch {
      return resolve({ ok: true, stable: true, mutations: 0, waited: 0, note: "MutationObserver is unavailable in this context." });
    }
    timer = setInterval(() => {
      if (Date.now() - last >= quiet) settle(true);
      else if (Date.now() - started >= timeout) settle(false);
    }, Math.max(40, Math.min(150, Math.floor(quiet / 2))));
  });
}

const netCount = () => { try { return performance.getEntriesByType("resource").length; } catch { return 0; } };

function waitForNetworkIdle(a = {}) {
  const quiet = clampMs(a.quiet, 100, 5000, 600);
  const timeout = clampMs(a.timeout, 300, 20000, 8000);
  return new Promise(resolve => {
    const started = Date.now();
    let lastCount = netCount(), lastChange = Date.now();
    const timer = setInterval(() => {
      const c = netCount();
      if (c !== lastCount) { lastCount = c; lastChange = Date.now(); }
      const quietFor = Date.now() - lastChange;
      if (quietFor >= quiet) { clearInterval(timer); resolve({ ok: true, idle: true, requests: c, waited: Date.now() - started }); }
      else if (Date.now() - started >= timeout) { clearInterval(timer); resolve({ ok: true, idle: false, timedOut: true, requests: c, waited: Date.now() - started }); }
    }, Math.max(60, Math.min(200, Math.floor(quiet / 2))));
  });
}

/* ------------------------------------------------------- overlays */
function overlay() {
  let o = document.getElementById("__webspider_overlay");
  if (!o) {
    o = document.createElement("div");
    o.id = "__webspider_overlay";
    o.setAttribute("aria-hidden", "true");
    Object.assign(o.style, { position: "fixed", inset: "0", zIndex: "2147483646", pointerEvents: "none" });
    (document.documentElement || document.body).appendChild(o);
  }
  return o;
}

function highlight(a = {}) {
  const e = a.element || locate(a);
  if (!e) throw Error("Element not found");
  const r = e.getBoundingClientRect();
  const color = a.color || "#f2b03c";
  const box = document.createElement("div");
  Object.assign(box.style, {
    position: "fixed", left: `${r.left - 4}px`, top: `${r.top - 4}px`,
    width: `${r.width + 8}px`, height: `${r.height + 8}px`,
    border: `3px solid ${color}`, borderRadius: "8px",
    boxShadow: `0 0 0 9999px rgba(0,0,0,.10),0 0 20px ${color}`,
    transition: "opacity .2s"
  });
  overlay().appendChild(box);
  setTimeout(() => box.remove(), Number(a.duration || 2200));
  return { ok: true, label: txt(e), selector: sel(e) };
}

function draw(a = {}) {
  const o = overlay();
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", innerWidth);
  svg.setAttribute("height", innerHeight);
  Object.assign(svg.style, { position: "fixed", inset: "0", pointerEvents: "none" });
  const color = a.color || "#f2b03c";
  let shape;
  if (a.kind === "rect") {
    shape = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    shape.setAttribute("x", Math.min(a.x1, a.x2));
    shape.setAttribute("y", Math.min(a.y1, a.y2));
    shape.setAttribute("width", Math.abs(a.x2 - a.x1));
    shape.setAttribute("height", Math.abs(a.y2 - a.y1));
    shape.setAttribute("fill", "none");
  } else {
    shape = document.createElementNS("http://www.w3.org/2000/svg", "line");
    shape.setAttribute("x1", a.x1); shape.setAttribute("y1", a.y1);
    shape.setAttribute("x2", a.x2); shape.setAttribute("y2", a.y2);
  }
  shape.setAttribute("stroke", color);
  shape.setAttribute("stroke-width", "4");
  shape.setAttribute("stroke-linecap", "round");
  svg.appendChild(shape);
  o.appendChild(svg);
  setTimeout(() => svg.remove(), 3500);
  return { ok: true };
}

/* --------------------------------------------------- error capture */
window.addEventListener("error", e => {
  window.__webspiderErrors = window.__webspiderErrors || [];
  window.__webspiderErrors.push({ type: "error", message: e.message || "Script error", source: e.filename || "", line: e.lineno || 0 });
});
window.addEventListener("unhandledrejection", e => {
  window.__webspiderErrors = window.__webspiderErrors || [];
  window.__webspiderErrors.push({ type: "promise", message: String(e.reason || "Unhandled rejection") });
});

/* ------------------------------------------------------- dispatch */
/* Object.create(null) so a message type like "constructor" cannot resolve
   to something inherited from Object.prototype. */
const HANDLERS = Object.assign(Object.create(null), {
  snapshot,
  page_state: pageState,
  diagnostics,
  human_check: detectHumanCheck,
  query_elements: queryElements,
  get_table: getTable,
  get_form: getFormFields,
  find_in_page: findInPage,
  get_selection: getSelectionInfo,
  console_logs: consoleLogs,
  dialog_log: dialogLog,
  network_log: networkLog,
  styles_of: stylesOf,
  audit,
  mark_page: markPage,
  diff_page: diffPage,
  extract,
  click,
  type,
  clear_field: clearField,
  select,
  check,
  hover,
  focus_el: focusEl,
  click_at: clickAt,
  submit_form: submitForm,
  key,
  wait,
  scroll,
  scroll_to: scrollTo,
  wait_for_element: waitForElement,
  wait_for_text: waitForText,
  wait_for_dom_stable: waitForDomStable,
  wait_for_network_idle: waitForNetworkIdle,
  set_dialog_policy: setDialogPolicy,
  highlight,
  draw
});

chrome.runtime.onMessage.addListener((m, _s, send) => {
  (async () => {
    try {
      const h = HANDLERS[m?.type];
      if (typeof h !== "function") throw Error("Unknown action");
      const d = await h(m.args || {});
      send({ ok: true, data: d });
    } catch (e) {
      send({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true;
});
})();
