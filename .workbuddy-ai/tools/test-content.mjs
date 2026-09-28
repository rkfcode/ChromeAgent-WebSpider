/* content.js tests: element location, stable ids, actions and diagnostics,
   driven through the real chrome.runtime.onMessage handler. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require("jsdom");

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const JS = readFileSync(join(root, "content.js"), "utf8");

let pass = 0;
const failures = [];
const ok = (n, c, e = "") => { if (c) pass++; else failures.push(`${n}${e ? " — " + e : ""}`); };
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

const PAGE = `<!doctype html><html lang="en"><head>
<title>Test Page</title>
<meta name="description" content="demo">
</head><body>
<h1>Welcome</h1><h2>Section</h2>
<button id="saveBtn" aria-label="Save changes">Save</button>
<button id="delBtn">Delete account</button>
<label>Plan <select id="plan"><option value="a">Basic</option><option value="b">Pro plan</option></select></label>
<input id="email" name="email" placeholder="Email address">
<textarea id="notes"></textarea>
<div id="ce" contenteditable="true"></div>
<div id="content">Hello <b>world</b></div>
<a href="https://external.example/x">External link</a>
<img id="broken" src="nope.png" alt="missing">
<form action="/go" method="post"><input name="q"></form>
<iframe title="frame" src="about:blank"></iframe>
</body></html>`;

/* A second fixture for the v8 read/audit tools. It is deliberately separate from
   PAGE so that no assertion in the v7 sections has to be re-baselined. */
const RICH = `<!doctype html><html lang="en"><head>
<title>Rich Test Page</title>
<meta name="description" content="short">
</head><body>
<h1>Rich</h1><h3>Skipped level</h3>
<p id="low" style="color:#999999;background-color:#ffffff;font-size:14px">Low contrast text here</p>
<p id="ok" style="color:#000000;background-color:#ffffff;font-size:14px">High contrast text here</p>
<button id="btn1">Search products</button>
<button id="iconBtn" aria-label="Close dialog"></button>
<button id="noName"></button>
<a href="/local" id="local">Local link</a>
<a href="https://outside.example/p" target="_blank" id="blank">External link</a>
<a href="#" id="dead">Dead link</a>
<a href="#anchor">Anchor</a>
<span id="dup"></span><span id="dup"></span>
<form id="reg" action="/register" method="post">
<label for="fullname">Full name</label>
<input id="fullname" name="fullname" required>
<input id="pw" name="pw" type="password" value="secret" aria-label="Password">
<input id="nolabel" name="nolabel">
<select id="country" name="country"><option value="ir">Iran</option><option value="de">Germany</option></select>
<input type="checkbox" id="terms" name="terms">
<input type="radio" id="planA" name="plan" value="a">
<input type="radio" id="planB" name="plan" value="b">
<textarea id="bio" name="bio"></textarea>
</form>
<table id="tbl">
<caption>Prices</caption>
<thead><tr><th>Name</th><th>Price</th></tr></thead>
<tbody><tr><td>Alpha</td><td>10</td></tr><tr><td>Beta</td><td>20</td></tr></tbody>
</table>
<div id="ce2" contenteditable="true">edit me</div>
<script type="application/json" id="__webspider_console">[]</script>
<script type="application/json" id="__webspider_dialogs">[]</script>
</body></html>`;

function makePage(html = PAGE) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => errors.push(e.message || String(e)));

  const dom = new JSDOM(html, { url: "https://site.test/page", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;

  /* jsdom gaps that real browsers do not have */
  Object.defineProperty(w.HTMLElement.prototype, "innerText", {
    get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true
  });
  w.Element.prototype.getBoundingClientRect = () => ({ x: 10, y: 10, width: 120, height: 24, top: 10, left: 10, right: 130, bottom: 34 });
  w.Element.prototype.scrollIntoView = function () {};
  if (!w.CSS || !w.CSS.escape) w.CSS = { escape: s => String(s).replace(/[^a-zA-Z0-9_\u00a0-\uffff-]/g, c => "\\" + c) };
  if (!w.performance.getEntriesByType) w.performance.getEntriesByType = () => [];
  const realGCS = w.getComputedStyle.bind(w);
  w.getComputedStyle = el => new Proxy(realGCS(el), {
    get(t, p) {
      if (p === "display") return "block";
      if (p === "visibility") return "visible";
      if (p === "opacity") return "1";
      const v = t[p];
      return typeof v === "function" ? v.bind(t) : v;
    }
  });

  let handler = null;
  w.chrome = { runtime: { onMessage: { addListener: fn => { handler = fn; } } } };

  w.eval(JS);

  const call = (type, args = {}) => new Promise(resolve => {
    handler({ type, args }, {}, resolve);
  });

  return { dom, w, call, errors, $: s => w.document.querySelector(s) };
}

/* ═══════════ snapshot ═══════════ */
{
  const p = makePage();
  ok("content script loads cleanly", p.errors.length === 0, p.errors.join(" | "));

  const r = await p.call("snapshot");
  ok("snapshot ok", r.ok, r.error);
  const d = r.data;
  eq("url captured", d.url, "https://site.test/page");
  eq("title captured", d.title, "Test Page");
  ok("headings captured", d.headings.includes("Welcome") && d.headings.includes("Section"));
  ok("text captured", d.text.includes("Hello world"));
  ok("meta captured", d.meta.some(m => m.name === "description" && m.content === "demo"));
  ok("frames captured", d.frames.length === 1 && d.frames[0].title === "frame");
  ok("external links captured", d.links.some(l => /external\.example/.test(l.href)));
  ok("broken image flagged", d.images.some(i => i.broken && i.alt === "missing"));

  const save = d.controls.find(c => c.label === "Save changes");
  ok("control labelled from aria-label", !!save);
  ok("control carries a stable elementId", /^ws\d+$/.test(save?.elementId || ""), JSON.stringify(save));
  ok("elementId is written to the DOM", p.$("#saveBtn").getAttribute("data-webspider-id") === save.elementId);
  ok("snapshot is idempotent", (await p.call("snapshot")).data.controls.find(c => c.label === "Save changes").elementId === save.elementId);
}

/* ═══════════ click ═══════════ */
{
  const p = makePage();
  const snap = (await p.call("snapshot")).data;
  const saveId = snap.controls.find(c => c.label === "Save changes").elementId;
  let clicked = 0;
  p.$("#saveBtn").addEventListener("click", () => clicked++);

  const byId = await p.call("click", { elementId: saveId });
  ok("click by elementId", byId.ok, byId.error);
  eq("click handler fired", clicked, 1);
  eq("click reports the elementId", byId.data.elementId, saveId);

  const byText = await p.call("click", { text: "Delete account" });
  ok("click by visible text", byText.ok, byText.error);
  eq("text click targets the right element", byText.data.selector, "#delBtn");

  const bySelector = await p.call("click", { selector: "#saveBtn" });
  ok("click by selector", bySelector.ok, bySelector.error);

  const missing = await p.call("click", { text: "does not exist anywhere" });
  ok("missing element fails loudly", missing.ok === false && /not found/i.test(missing.error), JSON.stringify(missing));

  const disabled = await p.call("click", { selector: "#email" });
  ok("non-clickable still resolves", typeof disabled.ok === "boolean");
}

/* ═══════════ type / select / key ═══════════ */
{
  const p = makePage();
  let inputs = 0, changes = 0;
  p.$("#email").addEventListener("input", () => inputs++);
  p.$("#email").addEventListener("change", () => changes++);

  const t = await p.call("type", { selector: "#email", value: "a@b.com" });
  ok("type ok", t.ok, t.error);
  eq("input value set", p.$("#email").value, "a@b.com");
  eq("input event dispatched", inputs, 1);
  eq("change event dispatched", changes, 1);

  const t2 = await p.call("type", { selector: "#ce", value: "hello ce" });
  ok("contenteditable type ok", t2.ok, t2.error);
  eq("contenteditable text set", p.$("#ce").textContent, "hello ce");

  const s = await p.call("select", { selector: "#plan", label: "Pro plan" });
  ok("select by label", s.ok, s.error);
  eq("select value applied", p.$("#plan").value, "b");

  const s2 = await p.call("select", { selector: "#plan", value: "a" });
  eq("select by value", s2.data?.value, "a");

  let keys = [];
  p.w.document.addEventListener("keydown", e => keys.push(e.key));
  const k = await p.call("key", { selector: "#email", key: "Enter" });
  ok("key ok", k.ok, k.error);
  ok("keydown dispatched", keys.includes("Enter"));

  const bad = await p.call("select", { selector: "#email", value: "x" });
  ok("select on a non-select fails", bad.ok === false, JSON.stringify(bad));
}

/* ═══════════ extract / scroll / wait / diagnostics ═══════════ */
{
  const p = makePage();
  const t = await p.call("extract", { selector: "#content" });
  eq("extract text", t.data.text, "Hello world");

  const h = await p.call("extract", { selector: "#content", format: "html" });
  ok("extract html", /<b>world<\/b>/.test(h.data.html));

  const l = await p.call("extract", { format: "links" });
  ok("extract links", l.data.links.some(x => /external\.example/.test(x.href)));

  const sc = await p.call("scroll", { pixels: 100 });
  ok("scroll ok", sc.ok && typeof sc.data.scrollY === "number");

  const w8 = await p.call("wait", { ms: 50 });
  ok("wait clamps and returns", w8.ok && w8.data.waited >= 50);

  const dg = await p.call("diagnostics");
  ok("diagnostics ok", dg.ok, dg.error);
  ok("diagnostics finds broken images", dg.data.brokenImages.length === 1);
  ok("diagnostics lists forms", dg.data.forms.length === 1 && dg.data.forms[0].inputs === 1);
  ok("diagnostics reports slow resources array", Array.isArray(dg.data.slowResources));

  const hi = await p.call("highlight", { selector: "#saveBtn" });
  ok("highlight ok", hi.ok, hi.error);
  ok("overlay injected", !!p.$("#__webspider_overlay"));

  const dr = await p.call("draw", { x1: 0, y1: 0, x2: 50, y2: 50, kind: "rect" });
  ok("draw ok", dr.ok, dr.error);

  const un = await p.call("nonsense");
  ok("unknown action rejected", un.ok === false && /unknown action/i.test(un.error));
}

/* ═══════════ shadow DOM + exposed locator ═══════════ */
{
  const p = makePage();
  const host = p.w.document.createElement("div");
  host.id = "host";
  p.w.document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<button id="shadowBtn">Shadow action</button>`;

  ok("locator exposed for the service worker", typeof p.w.__webspiderLocate === "function");
  ok("locator pierces open shadow roots", !!p.w.__webspiderLocate({ selector: "#shadowBtn" }));
  ok("locator finds by text", !!p.w.__webspiderLocate({ text: "Delete account" }));
  ok("locator returns null when absent", p.w.__webspiderLocate({ text: "zzz nowhere" }) === null);

  const snap = (await p.call("snapshot")).data;
  ok("snapshot includes shadow controls", snap.controls.some(c => c.label === "Shadow action"));
}

/* ═══════════ page_state / mark / diff ═══════════ */
{
  const p = makePage(RICH);
  const st = await p.call("page_state");
  ok("page_state ok", st.ok, st.error);
  const d = st.data;
  eq("page_state url", d.url, "https://site.test/page");
  eq("page_state reports the MAIN bridge is absent here", d.bridge, false);
  eq("page_state reports the default dialog policy", d.dialogPolicy, "record");
  ok("page_state returns a change token", typeof d.token === "string" && d.token.length > 0);
  ok("page_state counts controls", d.controls >= 8, `controls=${d.controls}`);
  ok("page_state is stable across two reads", (await p.call("page_state")).data.token === d.token);

  const mk = await p.call("mark_page");
  ok("mark_page ok", mk.ok, mk.error);
  ok("mark_page returns a token", typeof mk.data.token === "string" && mk.data.token.length > 0);
  eq("mark_page records the control count", mk.data.controls, d.controls);

  const same = await p.call("diff_page");
  eq("diff_page reports no change before anything happens", same.data.changed, false);
  eq("diff_page lists nothing added", same.data.added.length, 0);

  const added = p.w.document.createElement("div");
  added.textContent = "brand new sentence appears";
  p.w.document.body.appendChild(added);

  const df = await p.call("diff_page");
  ok("diff_page sees the change", df.data.changed === true, JSON.stringify(df.data).slice(0, 200));
  ok("diff_page lists the added text", df.data.added.some(x => x.includes("brand new sentence appears")), JSON.stringify(df.data.added));
  ok("diff_page reports the text delta", df.data.textDelta > 0, `delta=${df.data.textDelta}`);

  const fresh = makePage(RICH);
  eq("diff_page without a marker says so", (await fresh.call("diff_page")).data.first, true);
}

/* ═══════════ human-check detection (never solving) ═══════════ */
{
  const clean = makePage(RICH);
  const hc = await clean.call("human_check");
  ok("human_check ok", hc.ok, hc.error);
  eq("no challenge on a clean page", hc.data.present, false);
  eq("clean page reports no vendor", hc.data.vendor, "");
  eq("clean page advice says there is nothing to do", /no human-verification challenge detected/i.test(hc.data.advice), true);

  const rc = makePage(RICH.replace("</body>", `<iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/api2/anchor"></iframe></body>`));
  const h2 = (await rc.call("human_check")).data;
  eq("challenge iframe detected", h2.present, true);
  ok("reCAPTCHA vendor identified", /reCAPTCHA/i.test(h2.vendor), h2.vendor);
  ok("iframe kind recorded", h2.kinds.includes("iframe"));
  ok("challenge frame reported", h2.frames.length === 1 && /recaptcha/.test(h2.frames[0].src));
  ok("detection never offers to solve", /do not solve/i.test(h2.advice));
  eq("snapshot carries the challenge report", (await rc.call("snapshot")).data.humanCheck.present, true);

  const wd = makePage(RICH.replace("</body>", `<div class="g-recaptcha" data-sitekey="abc123"></div></body>`));
  const h3 = (await wd.call("human_check")).data;
  eq("challenge widget detected", h3.present, true);
  ok("widget kind recorded", h3.kinds.includes("widget"));
  ok("widget element carries a stable elementId", /^ws\d+$/.test(h3.elements[0]?.elementId || ""), JSON.stringify(h3.elements));

  const tx = makePage(RICH.replace("</body>", "<div>Verify you are human to continue</div></body>"));
  const h4 = (await tx.call("human_check")).data;
  eq("text challenge detected", h4.present, true);
  ok("text kind recorded", h4.kinds.includes("text"));

  const it = makePage(RICH.replace("</body>", `<div id="challenge-running"></div></body>`));
  ok("interstitial marker detected", (await it.call("human_check")).data.kinds.includes("interstitial"));

  const hc2 = makePage(RICH.replace("</body>", `<iframe title="hCaptcha" src="https://hcaptcha.com/1/api.js"></iframe></body>`));
  ok("hCaptcha vendor identified", /hCaptcha/i.test((await hc2.call("human_check")).data.vendor));
}

/* ═══════════ query_elements / get_table / get_form ═══════════ */
{
  const p = makePage(RICH);

  const q = await p.call("query_elements", { selector: "#tbl td" });
  ok("query_elements ok", q.ok, q.error);
  eq("query_elements total", q.data.total, 4);
  eq("query_elements items", q.data.items.length, 4);
  ok("query_elements items carry elementIds", q.data.items.every(i => /^ws\d+$/.test(i.elementId)));
  ok("query_elements items carry accessible names", q.data.items.every(i => typeof i.name === "string"));

  const limited = await p.call("query_elements", { selector: "#tbl td", limit: 2, offset: 1 });
  eq("query_elements honours limit", limited.data.items.length, 2);
  eq("query_elements honours offset", limited.data.items[0].index, 1);

  const attrs = await p.call("query_elements", { selector: "#blank", attrs: true });
  ok("query_elements can include attributes", attrs.data.items[0].attrs.target === "_blank");

  const badSel = await p.call("query_elements", { selector: "###" });
  ok("an invalid selector fails loudly", badSel.ok === false, JSON.stringify(badSel));
  const noSel = await p.call("query_elements", {});
  ok("a missing selector fails loudly", noSel.ok === false && /selector is required/i.test(noSel.error));

  const t = await p.call("get_table", { selector: "#tbl" });
  ok("get_table ok", t.ok, t.error);
  eq("table headers detected", t.data.headers, ["Name", "Price"]);
  eq("table caption read", t.data.caption, "Prices");
  eq("table row count", t.data.rowCount, 2);
  eq("table rows read", t.data.rows[0], ["Alpha", "10"]);

  const objs = await p.call("get_table", { selector: "#tbl", format: "objects" });
  eq("table objects keyed by header", objs.data.objects[1], { Name: "Beta", Price: "20" });
  ok("table objects replace rows", objs.data.rows === undefined);

  const missingTable = await p.call("get_table", { selector: "#low" });
  ok("a target with no table fails loudly", missingTable.ok === false && /no <table>/i.test(missingTable.error));

  const f = await p.call("get_form", { selector: "#reg" });
  ok("get_form ok", f.ok, f.error);
  eq("form action read", f.data.action.endsWith("/register"), true);
  eq("form method read", f.data.method, "POST");
  eq("form field count", f.data.count, 8);
  const fullname = f.data.fields.find(x => x.name === "fullname");
  eq("form field labelled from <label for>", fullname.label, "Full name");
  eq("form field required flag", fullname.required, true);
  ok("form field validation state is boolean", typeof fullname.invalid === "boolean");
  const pw = f.data.fields.find(x => x.name === "pw");
  eq("password value is masked", pw.value, "•••");
  eq("password labelled from aria-label", pw.label, "Password");
  const country = f.data.fields.find(x => x.name === "country");
  eq("select options exposed", country.options.map(o => o.value), ["ir", "de"]);
  const terms = f.data.fields.find(x => x.name === "terms");
  eq("checkbox state exposed", terms.checked, false);

  const noForm = await p.call("get_form", { selector: "#tbl" });
  ok("a target with no form still returns the page fields", noForm.ok && noForm.data.count >= 0, JSON.stringify(noForm).slice(0, 160));
}

/* ═══════════ find_in_page / get_selection / console / dialogs / network ═══════════ */
{
  const p = makePage(RICH);

  const fi = await p.call("find_in_page", { query: "Beta" });
  ok("find_in_page ok", fi.ok, fi.error);
  eq("find_in_page hit count", fi.data.count, 1);
  eq("find_in_page match text", fi.data.hits[0].match, "Beta");
  ok("find_in_page returns surrounding context", fi.data.hits[0].before.includes("Alpha"));
  ok("find_in_page reports the containing element", fi.data.elements.length >= 1);

  const fi2 = await p.call("find_in_page", { query: "nothing here at all" });
  eq("find_in_page misses cleanly", fi2.data.count, 0);
  const fi3 = await p.call("find_in_page", {});
  ok("find_in_page needs a query", fi3.ok === false && /query is required/i.test(fi3.error));

  const gs = await p.call("get_selection");
  eq("selection is empty on a fresh page", gs.data.empty, true);
  p.w.getSelection = () => ({ toString: () => "picked text" });
  const gs2 = await p.call("get_selection");
  eq("selection text is read", gs2.data.text, "picked text");
  eq("selection length is reported", gs2.data.length, 11);

  eq("console bridge is absent without main.js", (await p.call("console_logs")).data.bridge, false);
  p.$("#__webspider_console").textContent = JSON.stringify([
    { level: "log", text: "hello", url: "u" },
    { level: "error", text: "boom happened", url: "u" },
    { level: "warn", text: "careful now", url: "u" }
  ]);
  const cl = await p.call("console_logs", { level: "error" });
  eq("console_logs filters by level", cl.data.entries.length, 1);
  eq("console_logs counts every level", cl.data.counts.log, 1);
  eq("console_logs error count", cl.data.errors, 1);
  eq("console_logs warning count", cl.data.warnings, 1);
  eq("console_logs total", cl.data.total, 3);
  const cl2 = await p.call("console_logs", { contains: "care" });
  eq("console_logs filters by substring", cl2.data.entries.length, 1);
  const cl3 = await p.call("console_logs", { limit: 1 });
  eq("console_logs honours limit", cl3.data.entries.length, 1);
  eq("console_logs keeps the newest", cl3.data.entries[0].text, "careful now");
  await p.call("console_logs", { clear: true });
  eq("console_logs clears the buffer", JSON.parse(p.$("#__webspider_console").textContent).length, 0);

  p.$("#__webspider_dialogs").textContent = JSON.stringify([{ kind: "confirm", message: "sure?", t: 1, policy: "record" }]);
  const dl = await p.call("dialog_log");
  eq("dialog_log reads entries", dl.data.total, 1);
  eq("dialog_log reports the policy", dl.data.policy, "record");
  await p.call("dialog_log", { clear: true });
  eq("dialog_log clears the buffer", JSON.parse(p.$("#__webspider_dialogs").textContent).length, 0);

  p.w.performance.getEntriesByType = t => t !== "resource" ? [] : [
    { name: "https://a/x.js", initiatorType: "script", duration: 120, startTime: 1, transferSize: 1000, encodedBodySize: 1000, decodedBodySize: 1000 },
    { name: "https://a/slow.css", initiatorType: "css", duration: 2500, startTime: 5, transferSize: 2000, encodedBodySize: 2000, decodedBodySize: 2000 }
  ];
  const nl = await p.call("network_log", { slowest: 1 });
  eq("network_log counts resources", nl.data.count, 2);
  eq("network_log sorts by slowest", nl.data.entries[0].url, "https://a/slow.css");
  eq("network_log counts slow requests", nl.data.slow, 1);
  eq("network_log totals the transfer size", nl.data.totalKB, 3);
  const nl2 = await p.call("network_log", { kind: "script" });
  eq("network_log filters by kind", nl2.data.entries.length, 1);
}

/* ═══════════ styles_of ═══════════ */
{
  const p = makePage(RICH);
  const st = await p.call("styles_of", { selector: "#low" });
  ok("styles_of ok", st.ok, st.error);
  ok("styles_of reads the computed color", !!st.data.styles.color, JSON.stringify(st.data.styles));
  ok("styles_of computes a contrast ratio", st.data.contrast && st.data.contrast.ratio > 0, JSON.stringify(st.data.contrast));
  ok("low contrast is reported below 4.5", st.data.contrast.ratio < 4.5, `ratio=${st.data.contrast.ratio}`);
  eq("styles_of reports the element is visible", st.data.hidden, false);

  const okp = await p.call("styles_of", { selector: "#ok" });
  ok("high contrast passes 4.5", okp.data.contrast.ratio > 4.5, `ratio=${okp.data.contrast.ratio}`);

  const miss = await p.call("styles_of", { selector: "#nowhere" });
  ok("styles_of fails loudly for a missing element", miss.ok === false && /not found/i.test(miss.error));
}

/* ═══════════ audits ═══════════ */
{
  const p = makePage(RICH);

  const seo = await p.call("audit", { kind: "seo" });
  ok("seo audit ok", seo.ok, seo.error);
  ok("seo score is a percentage", seo.data.score > 0 && seo.data.score < 100, `score=${seo.data.score}`);
  ok("seo flags the short description", seo.data.issues.some(i => /description/i.test(i.msg)));
  ok("seo flags the missing canonical", seo.data.issues.some(i => /canonical/i.test(i.msg)));
  ok("seo flags the missing Open Graph tags", seo.data.issues.some(i => /Open Graph/i.test(i.msg)));
  ok("seo reports the h1 count", seo.data.stats.h1 === 1);
  ok("seo reports structured data", seo.data.stats.structuredData === 0);

  const a11y = await p.call("audit", { kind: "a11y" });
  ok("a11y audit ok", a11y.ok, a11y.error);
  ok("a11y flags the unnamed control", a11y.data.issues.some(i => /accessible name/i.test(i.msg)));
  ok("a11y flags the unlabelled field", a11y.data.issues.some(i => /no label/i.test(i.msg)));
  ok("a11y flags duplicate ids", a11y.data.issues.some(i => /duplicate id/i.test(i.msg)));
  ok("a11y flags heading level skips", a11y.data.issues.some(i => /heading level skip/i.test(i.msg)));
  ok("a11y flags the low-contrast text", a11y.data.issues.some(i => /contrast/i.test(i.msg)));
  ok("a11y actually measured contrast", a11y.data.stats.contrastChecked > 0, `checked=${a11y.data.stats.contrastChecked}`);
  ok("a11y issue carries a severity", a11y.data.issues.every(i => ["high", "medium", "low"].includes(i.severity)));

  const links = await p.call("audit", { kind: "links" });
  ok("links audit ok", links.ok, links.error);
  ok("links flags the dead link", links.data.issues.some(i => /"#"/.test(i.msg)));
  ok("links flags the missing noopener", links.data.issues.some(i => /noopener/i.test(i.msg)));
  eq("links counts internal links", links.data.stats.internal, 1);
  eq("links counts external links", links.data.stats.external, 1);
  eq("links counts every visible anchor", links.data.stats.total, 4);
  eq("links does not count a pure anchor as internal or external", links.data.stats.internal + links.data.stats.external, 2);

  const content = await p.call("audit", { kind: "content" });
  ok("content audit ok", content.ok, content.error);
  ok("content flags the thin page", content.data.issues.some(i => /Thin content/i.test(i.msg)));
  ok("content reports a reading time", content.data.stats.readingMinutes >= 1);

  const perf = await p.call("audit", { kind: "perf" });
  ok("perf audit ok", perf.ok, perf.error);
  ok("perf reports resource stats", typeof perf.data.stats.resources === "number");
  ok("perf reports the DOM size", perf.data.stats.domNodes > 0);

  const all = await p.call("audit", { kind: "all" });
  ok("audit all returns five kinds", Object.keys(all.data.kinds).length === 5, JSON.stringify(Object.keys(all.data.kinds || {})));
  ok("audit all averages the score", typeof all.data.score === "number");
  ok("audit all counts issues", all.data.issues > 0);

  const bad = await p.call("audit", { kind: "nonsense" });
  ok("an unknown audit kind fails loudly", bad.ok === false && /unknown audit kind/i.test(bad.error));
  eq("audit defaults to seo", (await p.call("audit")).data.kind, "seo");
}

/* ═══════════ actions: clear / check / hover / focus / click_at / submit ═══════════ */
{
  const p = makePage(RICH);

  const cf = await p.call("clear_field", { selector: "#pw" });
  ok("clear_field ok", cf.ok, cf.error);
  eq("clear_field empties the value", p.$("#pw").value, "");

  let changes = 0;
  p.$("#terms").addEventListener("change", () => changes++);
  const ck = await p.call("check", { selector: "#terms" });
  ok("check ok", ck.ok, ck.error);
  eq("check ticks the box", p.$("#terms").checked, true);
  eq("check dispatches change", changes, 1);
  const ck2 = await p.call("check", { selector: "#terms", value: false });
  eq("check can untick", ck2.data.checked, false);
  const ck3 = await p.call("check", { selector: "#planB" });
  eq("check works on radios", p.$("#planB").checked, true);
  const ckBad = await p.call("check", { selector: "#fullname" });
  ok("check rejects a non-checkbox", ckBad.ok === false && /checkbox or radio/i.test(ckBad.error));

  let hovered = 0;
  p.$("#btn1").addEventListener("mouseover", () => hovered++);
  const hv = await p.call("hover", { selector: "#btn1" });
  ok("hover ok", hv.ok, hv.error);
  eq("hover dispatches mouseover", hovered, 1);

  const fo = await p.call("focus_el", { selector: "#fullname" });
  ok("focus_el ok", fo.ok, fo.error);
  eq("focus_el moves focus", fo.data.focused, true);
  eq("focus_el matches activeElement", p.w.document.activeElement.id, "fullname");

  const ca = await p.call("click_at", { x: 12, y: 34 });
  ok("click_at ok", ca.ok, ca.error);
  eq("click_at reports its coordinates", [ca.data.x, ca.data.y], [12, 34]);
  ok("click_at reports a target", !!ca.data.target.tag);
  const caBad = await p.call("click_at", {});
  ok("click_at needs coordinates", caBad.ok === false && /numeric/i.test(caBad.error));

  let submits = 0;
  p.$("#reg").addEventListener("submit", e => { e.preventDefault(); submits++; });
  /* the form has a required, empty field — submitting must respect validation */
  const sfBlocked = await p.call("submit_form", { selector: "#reg" });
  ok("submit_form reports success even when validation blocks", sfBlocked.ok, sfBlocked.error);
  eq("submit_form does not submit an invalid form", submits, 0);
  p.$("#fullname").value = "Reza";
  const sf = await p.call("submit_form", { selector: "#reg" });
  ok("submit_form ok", sf.ok, sf.error);
  eq("submit_form fires the submit event once the form is valid", submits, 1);
  const sf2 = await p.call("submit_form", { selector: "#tbl" });
  ok("submit_form fails without a form", sf2.ok === false && /no form/i.test(sf2.error));

  const s2 = await p.call("scroll_to", { selector: "#tbl" });
  ok("scroll_to element ok", s2.ok && s2.data.scrolledTo === "element", JSON.stringify(s2).slice(0, 140));
  const s3 = await p.call("scroll_to", { y: 300 });
  ok("scroll_to offset ok", s3.ok && s3.data.scrolledTo === "y");
}

/* ═══════════ wait primitives ═══════════ */
{
  const p = makePage(RICH);

  const w1 = await p.call("wait_for_element", { selector: "#btn1", timeout: 1000 });
  ok("wait_for_element finds an existing element", w1.ok && w1.data.found === true, JSON.stringify(w1).slice(0, 160));
  ok("wait_for_element reports an elementId", /^ws\d+$/.test(w1.data.elementId || ""));

  const w2 = await p.call("wait_for_element", { text: "Dead link", timeout: 1000 });
  ok("wait_for_element finds by text", w2.data.found === true);

  const w3 = await p.call("wait_for_element", { selector: "#never", timeout: 250 });
  ok("wait_for_element times out honestly", w3.ok && w3.data.found === false && w3.data.timedOut === true, JSON.stringify(w3).slice(0, 160));
  ok("wait_for_element reports the elapsed time", w3.data.waited >= 200, `waited=${w3.data.waited}`);

  const w4 = await p.call("wait_for_element", {});
  ok("wait_for_element needs a target", w4.ok === false && /selector or text/i.test(w4.error));

  const t1 = await p.call("wait_for_text", { text: "Beta", timeout: 1000 });
  ok("wait_for_text finds existing text", t1.data.found === true);
  const t2 = await p.call("wait_for_text", { text: "zzz nowhere zzz", timeout: 250 });
  ok("wait_for_text times out honestly", t2.data.found === false && t2.data.timedOut === true);
  const t3 = await p.call("wait_for_text", {});
  ok("wait_for_text needs text", t3.ok === false && /needs text/i.test(t3.error));

  const d1 = await p.call("wait_for_dom_stable", { quiet: 100, timeout: 3000 });
  ok("wait_for_dom_stable settles", d1.ok && d1.data.stable === true, JSON.stringify(d1).slice(0, 160));
  eq("wait_for_dom_stable counts no mutations on a static page", d1.data.mutations, 0);

  const n1 = await p.call("wait_for_network_idle", { quiet: 120, timeout: 3000 });
  ok("wait_for_network_idle settles", n1.ok && n1.data.idle === true, JSON.stringify(n1).slice(0, 160));
  ok("wait_for_network_idle reports a request count", typeof n1.data.requests === "number");
}

/* ═══════════ dialog policy ═══════════ */
{
  const p = makePage(RICH);
  const d1 = await p.call("set_dialog_policy", { policy: "accept" });
  ok("set_dialog_policy ok", d1.ok, d1.error);
  eq("policy applied", d1.data.policy, "accept");
  eq("policy written to the DOM", p.w.document.documentElement.getAttribute("data-webspider-dialogs"), "accept");
  eq("dialog_log reads the new policy", (await p.call("dialog_log")).data.policy, "accept");

  const d2 = await p.call("set_dialog_policy", { policy: "nonsense" });
  eq("an unknown policy falls back to record", d2.data.policy, "record");
  const d3 = await p.call("set_dialog_policy", {});
  eq("a missing policy falls back to record", d3.data.policy, "record");
}

/* ═══════════ dispatch hardening ═══════════ */
{
  const p = makePage(RICH);
  const proto = await p.call("constructor");
  ok("inherited Object keys are not handlers", proto.ok === false && /unknown action/i.test(proto.error), JSON.stringify(proto));
  const proto2 = await p.call("toString");
  ok("prototype methods are not handlers", proto2.ok === false, JSON.stringify(proto2));
  const proto3 = await p.call("hasOwnProperty");
  ok("hasOwnProperty is not a handler", proto3.ok === false);
}

console.log(`\nCONTENT: ${pass} passed, ${failures.length} failed`);
if (failures.length) for (const f of failures) console.log("  FAIL " + f);
globalThis.__wsResults = { stage:"CONTENT", pass, failed:failures.length };
process.exitCode = failures.length ? 1 : 0;
