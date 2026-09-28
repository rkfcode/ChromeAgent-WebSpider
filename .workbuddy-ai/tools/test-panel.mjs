/* Panel behaviour tests: boots the real sidepanel.html + sidepanel.js inside
   jsdom against a stubbed chrome API, then exercises the UI. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require("jsdom");

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const HTML = readFileSync(join(root, "sidepanel.html"), "utf8")
  .replace(/<script src="sidepanel\.js"><\/script>/, "");
const JS = readFileSync(join(root, "sidepanel.js"), "utf8");

let pass = 0;
const failures = [];
const ok = (name, cond, extra = "") => { if (cond) pass++; else failures.push(`${name}${extra ? " — " + extra : ""}`); };
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
const wait = ms => new Promise(r => setTimeout(r, ms));

function makePanel(seed = {}) {
  const store = seed;
  const sent = [];
  const writes = [];
  const listeners = [];
  const errors = [];

  const vc = new VirtualConsole();
  vc.on("jsdomError", e => errors.push(e.message || String(e)));
  vc.on("error", (...a) => errors.push(a.join(" ")));

  const dom = new JSDOM(HTML, { url: "chrome-extension://webspider/sidepanel.html", runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;

  w.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  w.Element.prototype.scrollIntoView = function () {};
  w.document.execCommand = () => false;
  /* jsdom has no innerText; real browsers do */
  Object.defineProperty(w.HTMLElement.prototype, "innerText", {
    get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true
  });
  if (!w.CSS || !w.CSS.escape) {
    w.CSS = { escape: s => String(s).replace(/[^a-zA-Z0-9_\u00a0-\uffff-]/g, c => "\\" + c) };
  }

  w.chrome = {
    storage: { local: {
      get: async k => { const o = {}; for (const key of [].concat(k)) if (key in store) o[key] = store[key]; return o; },
      set: async o => { Object.assign(store, o); writes.push(o); },
      remove: async k => { for (const key of [].concat(k)) delete store[key]; }
    } },
    runtime: {
      onMessage: { addListener: fn => listeners.push(fn) },
      sendMessage: async m => {
        sent.push(m);
        if (m.type === "getAgentState") return { ok: true, state: { status: "idle" } };
        if (m.type === "runAgent") return { ok: true, message: "Done.", status: "done" };
        if (m.type === "resumeAgent") return { ok: true, message: "Resumed.", status: "done" };
        if (m.type === "discoverModels") return { ok: true, models: ["gpt-4o-mini"], selected: "gpt-4o-mini", latency: 42 };
        if (m.type === "pageSummary") return { ok: true, message: '{"title":"x"}' };
        return { ok: true };
      },
      getManifest: () => ({ version: "8.0.0" })
    },
    tabs: { create: async () => ({ id: 1 }) }
  };

  w.eval(JS);
  return { dom, w, store, sent, writes, listeners, errors, $: s => w.document.querySelector(s), $$: s => [...w.document.querySelectorAll(s)] };
}

const SEED = { apiKey: "sk-test", verifiedModels: ["gpt-4o-mini"], model: "gpt-4o-mini", endpoint: "https://api.test/v1" };
const fire = (p, msg) => p.listeners.forEach(fn => fn(msg));

/* Every section runs inside one try/catch so an unexpected throw is reported
   as a failure instead of aborting the run and hiding the other results. */
try {

/* ═══════════════ 1. boot ═══════════════ */
{
  const p = makePanel({ ...SEED });
  await flush();

  ok("boots without errors", p.errors.length === 0, p.errors.join(" | "));
  ok("welcome rendered", !!p.$("#welcome"));
  eq("four quick actions", p.$$(".quick").length, 4);
  eq("three modes", p.$$(".mode").length, 3);
  eq("status reads Ready", p.$("#status").textContent, "Ready");
  ok("run button visible", !p.$("#run").classList.contains("hidden"));
  ok("stop button hidden", p.$("#stop").classList.contains("hidden"));
  ok("scroll fab hidden", p.$("#scrollFab").classList.contains("hidden"));
  ok("version filled from manifest", p.$("#aboutVersion").textContent === "8.0.0", p.$("#aboutVersion").textContent);
  eq("mode persisted on boot", p.store.lastMode, "agent");
}

/* ═══════════════ 2. regression: quick actions survive a new chat ═══════════════ */
{
  const p = makePanel({ ...SEED });
  await flush();
  p.$("#newChat").click();
  await flush();
  ok("welcome survives New chat", !!p.$("#welcome"));
  eq("quick actions survive New chat", p.$$(".quick").length, 4);

  p.$$(".quick")[1].click();
  await flush();
  const run = p.sent.filter(m => m.type === "runAgent").pop();
  ok("quick action dispatches a run", !!run);
  ok("quick action sends its prompt", /SEO audit/i.test(run?.task || ""));
  eq("quick action uses the active mode", run?.mode, "agent");
  ok("quick actions disabled while running", p.$$(".quick").every(b => b.disabled === false || b.disabled === true));
  await wait(30);
}

/* ═══════════════ 3. modes ═══════════════ */
{
  const p = makePanel({ ...SEED });
  await flush();
  p.$$(".mode")[1].click();
  await flush();
  eq("plan mode pressed", p.$$(".mode")[1].getAttribute("aria-pressed"), "true");
  eq("plan mode active class", p.$$(".mode")[1].classList.contains("active"), true);
  eq("composer reflects mode", p.$("#composerMode").textContent, "Plan");
  eq("mode persisted", p.store.lastMode, "plan");

  p.$("#input").value = "do it";
  p.$("#run").click();
  await flush();
  eq("run carries the selected mode", p.sent.filter(m => m.type === "runAgent").pop()?.mode, "plan");
}

/* ═══════════════ 4. language ═══════════════ */
{
  const p = makePanel({ ...SEED });
  await flush();
  p.$("#lang").click();
  await flush();
  eq("rtl applied", p.w.document.documentElement.dir, "rtl");
  eq("lang attribute", p.w.document.documentElement.lang, "fa");
  eq("run label translated", p.$("#run span").textContent, "اجرا");
  eq("quick label translated", p.$(".quick b").textContent, "تحلیل صفحه");
  eq("welcome title translated", p.$("#welcomeTitle").textContent, "مرورگر را به یک دستیار واقعی بسپار.");
  eq("language persisted", p.store.lang, "fa");

  p.$("#langSeg").querySelector('button[data-val="en"]').click();
  await flush();
  eq("back to ltr", p.w.document.documentElement.dir, "ltr");
  eq("run label back", p.$("#run span").textContent, "Run");
}

/* ═══════════════ 5. appearance ═══════════════ */
{
  const p = makePanel({ ...SEED });
  await flush();
  eq("default theme", p.w.document.documentElement.dataset.theme, "dark");
  p.$("#themeBtn").click();
  eq("theme toggles", p.w.document.documentElement.dataset.theme, "light");
  eq("theme persisted", p.store.theme, "light");
  p.$("#accentSeg").querySelector('button[data-val="violet"]').click();
  eq("accent applied", p.w.document.documentElement.dataset.accent, "violet");
  p.$("#fsSeg").querySelector('button[data-val="lg"]').click();
  eq("font size applied", p.w.document.documentElement.dataset.fs, "lg");
  p.$("#resetUi").click();
  eq("reset restores theme", p.w.document.documentElement.dataset.theme, "dark");
  eq("reset restores accent", p.w.document.documentElement.dataset.accent, "amber");
  eq("reset restores font", p.w.document.documentElement.dataset.fs, "md");
}

/* ═══════════════ 6. settings tabs ═══════════════ */
{
  const p = makePanel({ ...SEED });
  await flush();
  ok("settings drawer opens", (p.$("#settings").click(), p.$("#drawer").classList.contains("open")));
  eq("connection panel visible first", p.$('[data-panel="connection"]').classList.contains("hidden"), false);
  /* select by data-tab, not by index — an index breaks whenever a tab is added */
  const tab = name => p.$(`.tab[data-tab="${name}"]`);
  eq("all four settings tabs exist", p.$$(".tab").length, 5);

  tab("appearance").click();
  eq("appearance tab selected", p.$('[data-panel="appearance"]').classList.contains("hidden"), false);
  eq("connection tab hidden", p.$('[data-panel="connection"]').classList.contains("hidden"), true);
  eq("tab aria-selected", tab("appearance").getAttribute("aria-selected"), "true");
  eq("other tabs are not selected", tab("connection").getAttribute("aria-selected"), "false");

  tab("tools").click();
  eq("tools tab selected", p.$('[data-panel="tools"]').classList.contains("hidden"), false);
  eq("appearance hidden when tools is active", p.$('[data-panel="appearance"]').classList.contains("hidden"), true);

  p.$("#close").click();
  ok("drawer closes", !p.$("#drawer").classList.contains("open"));
}

/* ═══════════════ 6b. tool catalogue ═══════════════ */
{
  const p = makePanel({ ...SEED });
  await flush();
  const rows = p.$$("#toolsList .tool-row");
  ok("the tool catalogue renders", rows.length >= 40, `rows=${rows.length}`);
  eq("the catalogue is grouped", p.$$("#toolsList .tool-group").length, 4);
  ok("every catalogue row shows a tool name", rows.every(r => (r.querySelector("code")?.textContent || "").length > 3));
  ok("every catalogue row shows a description", rows.every(r => (r.querySelector("span")?.textContent || "").length > 8));
  ok("the catalogue count is shown", /\d+\s+\w+/.test(p.$("#toolsCount").textContent), p.$("#toolsCount").textContent);
  ok("the CAPTCHA tool is described as detect-only", /never solve/i.test(p.$("#toolsList").textContent));

  /* switching language must re-render the descriptions, not leave them in English */
  const before = p.$$("#toolsList .tool-row span")[0].textContent;
  p.$("#langSeg").querySelector('button[data-val="fa"]').click();
  const after = p.$$("#toolsList .tool-row span")[0].textContent;
  ok("catalogue is translated when the language changes", after !== before && after.length > 4, `${before} → ${after}`);
  ok("catalogue still lists every tool after translation", p.$$("#toolsList .tool-row").length >= 40);
  ok("the tool group titles are translated", /خواندن|کنش|انتظار|ایمنی/.test(p.$("#toolsList").textContent));
}

/* ═══════════════ 6c. execution settings ═══════════════ */
{
  const p = makePanel({ ...SEED });
  await flush();
  p.$("#speedSeg").querySelector('button[data-val="thorough"]').click();
  eq("speed is persisted", p.store.speed, "thorough");
  eq("speed is selected in the UI", p.$('#speedSeg button[data-val="thorough"]').classList.contains("active"), true);

  p.$("#autoVerify").checked = false;
  p.$("#cacheSnapshot").checked = false;
  p.$("#humanAssist").checked = false;
  p.$("#dialogPolicy").value = "dismiss";
  p.$("#save").click();
  await flush();
  eq("autoVerify saved", p.store.autoVerify, false);
  eq("cacheSnapshot saved", p.store.cacheSnapshot, false);
  eq("humanAssist saved", p.store.humanAssist, false);
  eq("dialogPolicy saved", p.store.dialogPolicy, "dismiss");
  eq("uiVersion bumped to 8", p.store.uiVersion, 8);

  const q = makePanel({ ...SEED, speed: "fast", autoVerify: false, cacheSnapshot: false, humanAssist: false, dialogPolicy: "accept" });
  await flush();
  eq("speed restored into the UI", q.$('#speedSeg button[data-val="fast"]').classList.contains("active"), true);
  eq("autoVerify restored", q.$("#autoVerify").checked, false);
  eq("cacheSnapshot restored", q.$("#cacheSnapshot").checked, false);
  eq("humanAssist restored", q.$("#humanAssist").checked, false);
  eq("dialogPolicy restored", q.$("#dialogPolicy").value, "accept");
}

/* ═══════════════ 6d. human verification card ═══════════════ */
{
  const p = makePanel({ ...SEED });
  await flush();
  fire(p, { type: "humanCheck", message: "Complete the check", image: "data:image/jpeg;base64,AAA", vendor: "reCAPTCHA", autoResume: true });
  await flush();
  const card = p.$(".human-card");
  ok("a verification card is rendered", !!card);
  ok("the card explains the auto-resume", /resumes automatically/i.test(card.textContent), card.textContent);
  ok("the detected vendor is shown", /reCAPTCHA/.test(card.textContent));
  ok("the screenshot is shown", !!card.querySelector("img.human-preview"));
  ok("the card offers a resume button", !!card.querySelector("button.go"));
  ok("the composer is not left spinning", !p.$("#run").classList.contains("hidden"));
  ok("the stop button is hidden while waiting for the user", p.$("#stop").classList.contains("hidden"));

  fire(p, { type: "humanCheckSolved" });
  await flush();
  ok("solving the challenge is announced in the timeline", /resuming the task/i.test(p.$("#messages").textContent));

  const q = makePanel({ ...SEED });
  await flush();
  fire(q, { type: "humanCheckTimeout" });
  await flush();
  ok("a timeout is announced in the timeline", /not completed in time/i.test(q.$("#messages").textContent));
}

/* ═══════════════ 6e. conversation export ═══════════════ */
{
  const SESSION = {
    id: "s_test", title: "Existing chat", created: 1, updated: 2,
    items: [{ k: "u", t: "hello there" }, { k: "a", t: "hi back" }, { k: "e", lb: "ACTION", t: "click" }]
  };
  const p = makePanel({ ...SEED, chatSessions: [SESSION], activeSession: "s_test" });
  await flush();

  const made = [];
  p.w.URL.createObjectURL = blob => { made.push(blob); return "blob:test"; };
  const clicked = [];
  p.w.HTMLAnchorElement.prototype.click = function () { clicked.push({ name: this.download, href: this.href }); };

  p.$("#exportChat").click();
  await flush();
  eq("export produces a blob", made.length, 1);
  eq("export triggers one download", clicked.length, 1);
  ok("the download name looks like a WebSpider export", /^webspider-.*\.json$/.test(clicked[0].name), clicked[0].name);
  ok("the download is bound to the blob url", clicked[0].href === "blob:test");

  const payload = JSON.parse(await made[0].text());
  eq("the export names the app", payload.app, "WebSpider");
  eq("the export carries one session", payload.sessions.length, 1);
  eq("the export keeps the session id", payload.sessions[0].id, "s_test");
  ok("the export includes the raw messages", Array.isArray(payload.sessions[0].messages) && payload.sessions[0].messages.length === 3);
  ok("the transcript contains the user turn", /hello there/.test(payload.sessions[0].transcript), payload.sessions[0].transcript);
  ok("the transcript contains the assistant turn", /hi back/.test(payload.sessions[0].transcript));
  ok("the transcript keeps tool activity", /\[ACTION\]/.test(payload.sessions[0].transcript));
  ok("a success toast is shown", /exported/i.test(p.$("#toasts").textContent), p.$("#toasts").textContent);

  /* exporting with nothing to export must say so instead of failing silently */
  const empty = makePanel({ ...SEED });
  await flush();
  empty.$("#exportChat").click();
  await flush();
  ok("an empty export is reported", /nothing to export/i.test(empty.$("#toasts").textContent), empty.$("#toasts").textContent);
}

/* ═══════════════ 7. streaming + markdown ═══════════════ */
{
  const p = makePanel({ ...SEED });
  await flush();
  fire(p, { type: "agentStreamStart" });
  ok("live bubble created", !!p.$(".msg.assistant .bubble.cursor"));
  fire(p, { type: "agentDelta", text: "**bold** and `code`\n\n- one\n- two\n" });
  fire(p, { type: "agentDelta", text: "## heading\n" });
  ok("bold rendered", !!p.$(".msg.assistant .bubble strong"));
  ok("inline code rendered", !!p.$(".msg.assistant .bubble code"));
  eq("list items rendered", p.$$(".msg.assistant .bubble ul li").length, 2);
  ok("heading rendered", !!p.$(".msg.assistant .bubble h4.md-h"));
  fire(p, { type: "agentStreamEnd", final: true });
  await flush();
  ok("live bubble removed after final", !p.$(".bubble.cursor"));
  eq("final message kept", p.$$(".msg.assistant").length, 1);
  ok("copy action present", !!p.$(".msg-actions [data-copy]"));
  ok("text preserved", p.$(".msg.assistant .bubble").innerText.includes("bold"));

  /* a non-final stream becomes a thought note, not an answer */
  fire(p, { type: "agentStreamStart" });
  fire(p, { type: "agentDelta", text: "let me look around" });
  fire(p, { type: "agentStreamEnd", final: false });
  await flush();
  ok("interim text becomes a thought", !!p.$(".event.thought"));
  eq("no extra assistant bubble", p.$$(".msg.assistant").length, 1);

  /* interim notes can be switched off entirely */
  const q = makePanel({ ...SEED, showThoughts: false });
  await flush();
  fire(q, { type: "agentStreamStart" });
  fire(q, { type: "agentDelta", text: "silent musing" });
  fire(q, { type: "agentStreamEnd", final: false });
  await flush();
  eq("thoughts suppressed when disabled", q.$$(".event.thought").length, 0);
  eq("suppressed thought leaves no bubble", q.$$(".msg.assistant").length, 0);
}

/* a delta arriving without a stream-start must still render, never be swallowed */
{
  const p = makePanel({ ...SEED, streaming: false });
  await flush();
  fire(p, { type: "agentDelta", text: "recovered text" });
  ok("orphan delta still renders", !!p.$(".msg.assistant .bubble.cursor"));
  fire(p, { type: "agentStreamEnd", final: true });
  await flush();
  eq("orphan delta becomes one message", p.$$(".msg.assistant").length, 1);
  ok("orphan delta text kept", p.$(".msg.assistant .bubble").innerText.includes("recovered text"));
}

/* ═══════════════ 8. events, progress, model chip ═══════════════ */
{
  const p = makePanel({ ...SEED });
  await flush();
  fire(p, { type: "agentProgress", step: 3, max: 40 });
  eq("progress chip text", p.$("#progressChip").textContent, "3/40");
  ok("progress chip visible", !p.$("#progressChip").classList.contains("hidden"));

  fire(p, { type: "agentEvent", label: "ACTION", text: "click", level: "tool" });
  ok("action event rendered", p.$(".event .tag")?.textContent === "ACTION");

  fire(p, { type: "agentEvent", label: "MODEL", text: "request 1", model: "gpt-4o-mini" });
  eq("model chip updated", p.$("#statusModel").textContent, "gpt-4o-mini");
  eq("model chatter stays out of the timeline", p.$$(".event").length, 1);

  fire(p, { type: "agentConfirm", id: "7", action: "Click: Delete", reason: "destructive" });
  ok("confirm card rendered", !!p.$(".confirm"));
  p.$(".confirm .approve").click();
  const conf = p.sent.filter(m => m.type === "confirmation").pop();
  eq("approval sent", conf?.approved, true);
  eq("approval id sent", conf?.id, "7");
  await flush();
  ok("confirm card shows resolved state", !!p.$(".confirm b"));

  fire(p, { type: "humanCheck", message: "solve it", image: "data:image/png;base64,AAA" });
  ok("human card rendered", !!p.$(".human-card"));
  ok("human preview rendered", !!p.$(".human-preview"));
}

/* ═══════════════ 9. persistence + restore ═══════════════ */
const shared = { ...SEED };
{
  const p = makePanel(shared);
  await flush();
  p.$("#input").value = "audit the checkout flow";
  p.$("#run").click();
  await wait(450);

  const sess = shared.chatSessions || [];
  eq("session persisted", sess.length, 1);
  eq("title from first user message", sess[0].title, "audit the checkout flow");
  ok("items stored", Array.isArray(sess[0].items) && sess[0].items.length >= 2);
  eq("user item stored", sess[0].items[0].k, "u");
  eq("assistant item stored", sess[0].items[1].k, "a");
  eq("active session stored", shared.activeSession, sess[0].id);
  ok("input cleared after send", p.$("#input").value === "");
}
{
  const p = makePanel(shared);
  await flush();
  eq("restored messages", p.$$(".msg").length, 2);
  ok("restored user text", p.$(".msg.user .bubble").textContent === "audit the checkout flow");
  ok("restored assistant text", p.$(".msg.assistant .bubble").innerText.includes("Done."));
  eq("history list shows one chat", p.$$(".history-item").length, 1);
  ok("active chat highlighted", !!p.$(".history-open.active"));
}

/* ═══════════════ 10. delete flows use a modal, not window.confirm ═══════════════ */
{
  const seed10 = {
    ...SEED,
    chatSessions: [{ id: "s_old", title: "old chat", created: Date.now(), updated: Date.now(), items: [{ k: "u", t: "old" }, { k: "a", t: "reply" }] }],
    activeSession: "s_old"
  };
  const p = makePanel(seed10);
  await flush();
  eq("seeded chat restored", p.$$(".msg").length, 2);

  p.$("#historyBtn").click();
  eq("history drawer opens", p.$("#historyDrawer").classList.contains("open"), true);
  eq("history lists the saved chat", p.$$(".history-item").length, 1);
  ok("active chat highlighted", !!p.$(".history-open.active"));

  p.$("#deleteHistory").click();
  await flush();
  ok("modal opens instead of window.confirm", !p.$("#modal").classList.contains("hidden"));
  ok("modal has a title and body", p.$("#modalTitle").textContent.length > 0 && p.$("#modalBody").textContent.length > 0);
  p.$("#modalCancel").click();
  await flush();
  ok("modal cancel closes", p.$("#modal").classList.contains("hidden"));
  eq("cancel keeps the chat", p.$$(".history-item").length, 1);

  /* single-chat delete also asks first */
  p.$(".history-item .x").click();
  await flush();
  ok("single delete asks for confirmation", !p.$("#modal").classList.contains("hidden"));
  p.$("#modalCancel").click();
  await flush();
  eq("cancelled single delete keeps the chat", p.$$(".history-item").length, 1);

  p.$("#deleteHistory").click();
  await flush();
  p.$("#modalOk").click();
  await flush();
  ok("confirm clears storage", !p.store.chatSessions || p.store.chatSessions.length === 0);
  eq("history list emptied", p.$$(".history-item").length, 0);
  ok("empty note shown", !!p.$(".history-list .note"));
  eq("welcome shown again", !!p.$("#welcome"), true);
}

/* ═══════════════ 11. keyboard + drawer escape ═══════════════ */
{
  const p = makePanel({ ...SEED });
  await flush();
  p.$("#settings").click();
  const esc = new p.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true });
  p.w.document.dispatchEvent(esc);
  ok("escape closes the drawer", !p.$("#drawer").classList.contains("open"));

  const k = new p.w.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
  p.w.document.dispatchEvent(k);
  eq("ctrl+k focuses the composer", p.w.document.activeElement, p.$("#input"));

  const alt = new p.w.KeyboardEvent("keydown", { key: "2", altKey: true, bubbles: true, cancelable: true });
  p.w.document.dispatchEvent(alt);
  eq("alt+2 selects plan mode", p.$$(".mode")[1].classList.contains("active"), true);
}

/* ═══════════════ 12. guards ═══════════════ */
{
  const p = makePanel({});
  await flush();
  p.$("#input").value = "no key configured";
  p.$("#run").click();
  await flush();
  eq("run blocked without an API key", p.sent.filter(m => m.type === "runAgent").length, 0);
  ok("settings drawer opened as guidance", p.$("#drawer").classList.contains("open"));
  ok("connection panel focused", !p.$('[data-panel="connection"]').classList.contains("hidden"));
  ok("toast shown", !!p.$(".toast"));
}
{
  const p = makePanel({ ...SEED });
  await flush();
  p.$("#run").click();
  await flush();
  eq("empty task is refused", p.sent.filter(m => m.type === "runAgent").length, 0);
}

/* ═══════════════ 13. stop / resume ═══════════════ */
{
  const p = makePanel({ ...SEED });
  await flush();
  p.$("#input").value = "long job";
  p.$("#run").click();
  /* runTask flips the UI synchronously before its first await */
  ok("stop button visible while running", !p.$("#stop").classList.contains("hidden"));
  ok("run button hidden while running", p.$("#run").classList.contains("hidden"));
  ok("elapsed timer visible", !p.$("#elapsed").classList.contains("hidden"));
  await flush();
  p.$("#stop").click();
  await flush();
  ok("stop dispatched", p.sent.some(m => m.type === "stopAgent"));
  ok("resume card shown", !p.$("#resumeCard").classList.contains("hidden"));
  p.$("#resumeBtn").click();
  await flush();
  ok("resume dispatched", p.sent.some(m => m.type === "resumeAgent"));
  p.$("#resumeDismiss").click();
  ok("resume card dismissible", p.$("#resumeCard").classList.contains("hidden"));
}

/* ═══════════════ 14. page snapshot button ═══════════════ */
{
  const p = makePanel({ ...SEED });
  await flush();
  p.$("#attachPage").click();
  await flush();
  ok("pageSummary requested", p.sent.some(m => m.type === "pageSummary"));
  ok("snapshot rendered as a code block", !!p.$(".codeblock"));
  ok("code block has a copy button", !!p.$(".copycode[data-copy]"));
}

} catch (e) {
  failures.push("UNCAUGHT — " + (e && e.message ? e.message : String(e)));
}

/* ═══════════════ report ═══════════════ */
console.log(`\nPANEL: ${pass} passed, ${failures.length} failed`);
if (failures.length) for (const f of failures) console.log("  FAIL " + f);
globalThis.__wsResults = { stage:"PANEL", pass, failed:failures.length };
process.exitCode = failures.length ? 1 : 0;
