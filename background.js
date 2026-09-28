/* ============================================================
   WebSpider service worker — v7
   Resilient agent loop with SSE streaming, model failover and
   deterministic frame targeting.
   ============================================================ */

export const SYSTEM = `You are WebSpider, a professional browser agent that operates the user's real browser.
Be fast, precise and evidence-driven. Inspect only what is needed, act, then verify the result.
Never claim success without evidence. Prefer direct browser actions over explaining how the user could do them.

READING THE PAGE
Use page_snapshot for the overall picture, page_state for a cheap "did anything change" check, and the targeted readers when you know what you want:
query_elements (CSS selector → structured list), get_form (labels, values, validation), get_table (rows, headers, optional objects), find_in_page (locate text without scrolling), get_selection, console_logs, network_log, styles_of.
Use audit with kind seo|a11y|perf|links|content|all for site analysis instead of guessing.
Every mutating action returns an "after" block describing whether the page actually changed. Read it: if it says the page did not change, the action did not work — diagnose instead of assuming success.
mark_page then act then diff_page proves exactly what changed, when you need a precise before/after.

WAITING
Prefer wait_for_element, wait_for_text, wait_for_dom_stable and wait_for_network_idle over a blind wait: they return as soon as the condition is true and report a timeout honestly.

SAFETY
Do NOT bypass CAPTCHA, "I'm not a robot" checks, authentication, paywalls, security controls or access controls. If a challenge appears, WebSpider detects it, pauses and asks the user to complete it, then resumes automatically from the same step. Never solve, click, interpret answer choices or bypass a challenge — detection and pausing is the whole job.
Sensitive actions include purchases, deletion, publishing, sending, submitting, changing security or account settings and any irreversible action. Ask for confirmation when the setting requires it.
set_dialog_policy controls whether native alert/confirm/prompt dialogs are recorded, auto-accepted or auto-dismissed. Leave it on "record" unless a dialog is blocking the run.

RECOVERY
If a tool fails, recover intelligently: inspect again, retry with a different selector or approach, or fall back to another verified model if the AI request itself fails.
For SEO tasks inspect title, meta, headings, canonical, robots, links, images, structured data when available and visible content. Distinguish observed facts from inference.`;

export const MODE_PROMPTS = {
  agent:    "Mode: AGENT. Act directly — inspect, decide and perform the browser actions needed to finish the task, verifying results as you go.",
  plan:     "Mode: PLAN. Do NOT act yet. Your first reply must be a short numbered plan of at most 8 steps and must not call any tool. The user will approve it and then run it in Agent mode.",
  research: "Mode: RESEARCH. Gather and verify evidence before concluding. Stay read-only: snapshot, page_state, query_elements, get_form, get_table, find_in_page, console_logs, network_log, styles_of, audit, extract, scroll, navigate, open_tab, screenshot and diagnostics are allowed; never click, type, select, check, submit or change state. Cite the page evidence you used."
};

export const TOOLS = [
  fn("page_snapshot", "Read a compact structured snapshot of the current page, including stable elementIds for controls. Use this before acting when you need page evidence.", {}),
  fn("page_state", "Cheap read of the page state: url, title, readyState, scroll, counts, focused element and a change token. Use it to check whether the page changed without paying for a full snapshot.", {}),
  fn("page_diagnostics", "Diagnose visible browser/page problems: captured page errors, console errors, broken images, suspicious links, forms, slow resources and common UX issues.", {}),
  fn("detect_human_check", "Detect whether a CAPTCHA or human-verification challenge is present, and which vendor it belongs to. Detection only — never solve or bypass it. The run pauses and resumes automatically once the user completes it.", {}),
  fn("query_elements", "Query the page with a CSS selector and get a structured list: tag, role, accessible name, text, value, href, rect, visibility and a stable elementId. Use it instead of a full snapshot when you know the selector.", { selector:{type:"string"}, limit:{type:"number"}, offset:{type:"number"}, visible:{type:"boolean"}, attrs:{type:"boolean"}, shadow:{type:"boolean"} }, ["selector"]),
  fn("get_table", "Read a table into structured rows with detected headers. Returns objects keyed by header when format is \"objects\".", { elementId:{type:"string"}, selector:{type:"string"}, text:{type:"string"}, label:{type:"string"}, limit:{type:"number"}, format:{type:"string"} }),
  fn("get_form", "List the fields of a form (or the whole page) with labels, types, current values, required flags, options and validation state. Use it before filling anything in.", { elementId:{type:"string"}, selector:{type:"string"}, text:{type:"string"}, label:{type:"string"} }),
  fn("find_in_page", "Find text on the page without scrolling. Returns context snippets and the elements that contain the match.", { query:{type:"string"}, limit:{type:"number"} }, ["query"]),
  fn("get_selection", "Read the text the user has currently selected on the page.", {}),
  fn("console_logs", "Read the console messages the page has produced (captured in the page's own JS world). Filter by level or substring; optionally clear the buffer.", { level:{type:"string"}, contains:{type:"string"}, limit:{type:"number"}, clear:{type:"boolean"} }),
  fn("dialog_log", "Read the native alert/confirm/prompt dialogs the page has raised, and the current dialog policy.", { clear:{type:"boolean"} }),
  fn("network_log", "Read the page's network resource timings: url, type, duration, transfer size and cache status. Sort by slowest to find bottlenecks.", { kind:{type:"string"}, slowest:{type:"number"}, limit:{type:"number"} }),
  fn("styles_of", "Read the computed styles of an element, plus its effective background and WCAG contrast ratio.", { elementId:{type:"string"}, selector:{type:"string"}, text:{type:"string"}, label:{type:"string"} }),
  fn("audit", "Run a deterministic page audit and get a 0–100 score with a severity-ranked issue list. kind is seo, a11y, perf, links, content or all.", { kind:{type:"string"} }),
  fn("mark_page", "Set a before/after marker on the page state. Follow it with diff_page to prove exactly what changed.", {}),
  fn("diff_page", "Compare the page against the last mark_page and report what changed: url, text delta, control delta and added/removed content.", {}),
  fn("navigate", "Navigate the current browser tab to a URL.", { url:{type:"string"} }, ["url"]),
  fn("back", "Go back one browser history step.", {}),
  fn("forward", "Go forward one browser history step.", {}),
  fn("open_tab", "Open a URL in a new tab and make it the active working tab.", { url:{type:"string"} }, ["url"]),
  fn("click", "Click a visible element. Prefer elementId from a snapshot; otherwise pass a selector, text or label.", { elementId:{type:"string"}, selector:{type:"string"}, text:{type:"string"}, label:{type:"string"} }),
  fn("click_at", "Click at absolute viewport coordinates. Use it only when no element can be targeted.", { x:{type:"number"}, y:{type:"number"} }, ["x","y"]),
  fn("type", "Fill a visible input, textarea or contenteditable. Dispatches input/change events correctly for React/Vue apps.", { elementId:{type:"string"}, selector:{type:"string"}, text:{type:"string"}, label:{type:"string"}, value:{type:"string"} }, ["value"]),
  fn("clear_field", "Empty an input, textarea or contenteditable field.", { elementId:{type:"string"}, selector:{type:"string"}, text:{type:"string"}, label:{type:"string"} }),
  fn("select", "Select an option in a visible select element by value or label.", { elementId:{type:"string"}, selector:{type:"string"}, value:{type:"string"}, label:{type:"string"} }),
  fn("check", "Set a checkbox or radio button to checked (default) or unchecked with value:false.", { elementId:{type:"string"}, selector:{type:"string"}, text:{type:"string"}, label:{type:"string"}, value:{type:"boolean"} }),
  fn("hover", "Move the pointer over an element to reveal menus, tooltips and hover states.", { elementId:{type:"string"}, selector:{type:"string"}, text:{type:"string"}, label:{type:"string"} }),
  fn("focus", "Move keyboard focus to an element without clicking it.", { elementId:{type:"string"}, selector:{type:"string"}, text:{type:"string"}, label:{type:"string"} }),
  fn("press_key", "Press a keyboard key on the focused element or on a located element (Enter, Tab, Escape, ArrowDown, Backspace…). Use it to submit search boxes and dismiss dialogs.", { key:{type:"string"}, elementId:{type:"string"}, selector:{type:"string"}, text:{type:"string"}, label:{type:"string"} }, ["key"]),
  fn("submit_form", "Submit a form properly (requestSubmit), firing validation and the submit event. Prefer pressing Enter on a field when that is what a user would do.", { elementId:{type:"string"}, selector:{type:"string"}, text:{type:"string"}, label:{type:"string"} }),
  fn("scroll", "Scroll the current page vertically by a number of pixels.", { pixels:{type:"number"} }),
  fn("scroll_to", "Scroll to an element, or to an absolute vertical offset with y.", { elementId:{type:"string"}, selector:{type:"string"}, text:{type:"string"}, label:{type:"string"}, y:{type:"number"}, block:{type:"string"} }),
  fn("wait", "Wait a fixed number of milliseconds. Prefer the wait_for_* tools, which return as soon as the condition is met.", { ms:{type:"number"} }),
  fn("wait_for_element", "Wait until a selector or text is present and visible. Returns found:false with timedOut:true rather than hanging forever.", { selector:{type:"string"}, text:{type:"string"}, label:{type:"string"}, timeout:{type:"number"} }),
  fn("wait_for_text", "Wait until the given text appears anywhere in the page.", { text:{type:"string"}, query:{type:"string"}, timeout:{type:"number"} }),
  fn("wait_for_dom_stable", "Wait until the DOM has stopped mutating for a quiet period — the reliable way to wait for a client-rendered page.", { quiet:{type:"number"}, timeout:{type:"number"} }),
  fn("wait_for_network_idle", "Wait until no new network requests have started for a quiet period.", { quiet:{type:"number"}, timeout:{type:"number"} }),
  fn("extract", "Extract readable content from a CSS-selected area or the whole page as text, html, links or table.", { selector:{type:"string"}, format:{type:"string"} }),
  fn("highlight", "Visually highlight a page element for the user. Does not submit or change data.", { elementId:{type:"string"}, selector:{type:"string"}, text:{type:"string"}, label:{type:"string"}, color:{type:"string"} }),
  fn("draw", "Draw an annotation line, arrow or rectangle on the visible page for the user.", { x1:{type:"number"}, y1:{type:"number"}, x2:{type:"number"}, y2:{type:"number"}, kind:{type:"string"} }),
  fn("screenshot", "Capture the full visible browser viewport, including visible iframes, overlays and CAPTCHA or human-verification UI.", {}),
  fn("sync_browser_target", "Detect the currently active browser tab after a popup, OAuth window or new tab appears and make it the working target.", {}),
  fn("set_dialog_policy", "Control native alert/confirm/prompt dialogs: record (show them, default), accept or dismiss. Use accept/dismiss only when a dialog is blocking an automated run.", { policy:{type:"string"} }),
  fn("ask_confirmation", "Pause for explicit user confirmation before a sensitive action.", { action:{type:"string"}, reason:{type:"string"} }, ["action"]),
  fn("human_verification", "Handle a detected human-verification or CAPTCHA checkpoint by pausing for the user. Never solve or bypass it automatically.", { reason:{type:"string"} })
];

function fn(name, description, props, required = []) {
  return { type:"function", function:{ name, description, parameters:{ type:"object", properties:props, required, additionalProperties:false } } };
}

let stopped = false;
let pending = null;
let activeAbort = null;
let seq = 0;
let runtime = blankRuntime();

function blankRuntime() {
  return { runId:null, tabId:null, windowId:null, task:null, mode:"agent", messages:[], turn:0, max:40, modelIndex:0, models:[], startedAt:0, currentAction:"", status:"idle", lastState:null };
}

/* test seam — lets the Node harness inject a fake fetch */
let fetchImpl = (...a) => fetch(...a);
export function __setFetchImpl(f) { fetchImpl = f || ((...a) => fetch(...a)); }

/* ------------------------------------------------------- settings */
const SETTING_KEYS = [
  "endpoint","fallbackEndpoints","model","verifiedModels","temperature","apiKey","confirmRisk","vision",
  "system","maxSteps","retryCount","requestTimeout","streaming","showThoughts","notify",
  "speed","autoVerify","cacheSnapshot","humanAssist","dialogPolicy"
];
const getSettings = () => chrome.storage.local.get(SETTING_KEYS);

/* ------------------------------------------------------ endpoints */
export function normalizeEndpoint(raw) {
  const u = String(raw || "").trim().replace(/\/+$/, "");
  if (!u) throw Error("API URL is empty.");
  try { new URL(u); } catch { throw Error("API URL is invalid. Example: https://api.openai.com/v1"); }
  if (/\/chat\/completions$/i.test(u)) {
    const base = u.replace(/\/chat\/completions$/i, "");
    return { base, chat: u, models: base + "/models" };
  }
  return { base: u, chat: u + "/chat/completions", models: u + "/models" };
}

export function endpointList(raw, fallbacks = "") {
  const all = [raw, ...String(fallbacks || "").split(/\s*[\n,]\s*/).filter(Boolean)].filter(Boolean);
  return [...new Set(all.map(x => normalizeEndpoint(x).base))].map(normalizeEndpoint);
}

/* ---------------------------------------------------------- fetch */
async function apiFetch(url, key, opts = {}, timeoutMs = 25000, externalSignal = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(5000, Number(timeoutMs) || 25000));
  const onAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onAbort, { once:true });
  }
  try {
    const headers = { ...(opts.headers || {}), Authorization:"Bearer " + key };
    const r = await fetchImpl(url, { ...opts, headers, signal:controller.signal, cache:"no-store" });
    const tx = await r.text();
    let data;
    try { data = JSON.parse(tx); } catch { data = { raw:tx }; }
    if (!r.ok) {
      const err = new Error(`HTTP ${r.status}: ${typeof data === "object" ? JSON.stringify(data).slice(0,900) : tx.slice(0,900)}`);
      err.status = r.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", onAbort);
  }
}

/* ------------------------------------------------------ SSE stream */
export async function readSSE(res, signal, onDelta) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", content = "", reasoning = "";
  const tools = new Map();
  let saw = false;

  for (;;) {
    let part;
    try { part = await reader.read(); }
    catch (e) { throw new Error(signal && signal.aborted ? "Request aborted." : (e?.message || "Stream read failed.")); }
    if (part.done) break;
    buf += decoder.decode(part.value, { stream:true });

    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      const t = line.trim();
      if (!t || t.startsWith(":") || !t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") continue;

      let j;
      try { j = JSON.parse(payload); } catch { continue; }
      if (j.error) throw new Error(typeof j.error === "string" ? j.error : (j.error.message || "Stream error."));
      const ch = j.choices && j.choices[0];
      if (!ch) continue;
      const d = ch.delta || ch.message;
      if (!d) continue;

      if (typeof d.content === "string" && d.content) { content += d.content; saw = true; if (onDelta) onDelta(d.content); }
      else if (Array.isArray(d.content)) {
        for (const p of d.content) {
          if (p && (p.type === "text" || p.type === "output_text") && p.text) { content += p.text; saw = true; if (onDelta) onDelta(p.text); }
        }
      }
      if (typeof d.reasoning_content === "string" && d.reasoning_content) reasoning += d.reasoning_content;

      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const idx = Number.isInteger(tc.index) ? tc.index : 0;
          const cur = tools.get(idx) || { id:"", type:"function", function:{ name:"", arguments:"" } };
          if (tc.id) cur.id = tc.id;
          if (tc.type) cur.type = tc.type;
          if (tc.function) {
            if (tc.function.name) cur.function.name += tc.function.name;
            if (tc.function.arguments) cur.function.arguments += tc.function.arguments;
          }
          tools.set(idx, cur);
          saw = true;
        }
      }
    }
  }

  const tool_calls = [...tools.keys()].sort((a, b) => a - b)
    .map(k => tools.get(k))
    .filter(t => t.function && t.function.name);

  if (!saw && !tool_calls.length) throw new Error("Empty stream response.");
  const message = { role:"assistant", content: content || "" };
  if (tool_calls.length) message.tool_calls = tool_calls.map((t, i) => ({ ...t, id: t.id || `call_${Date.now()}_${i}` }));
  if (reasoning) message.__reasoning = reasoning;
  return message;
}

export async function streamChat(ep, key, body, timeoutMs, signal, onDelta) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(5000, Number(timeoutMs) || 18000));
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once:true });
  }
  try {
    const r = await fetchImpl(ep.chat, {
      method:"POST",
      headers:{ "Content-Type":"application/json", Authorization:"Bearer " + key },
      body: JSON.stringify({ ...body, stream:true }),
      signal: controller.signal,
      cache:"no-store"
    });
    if (!r.ok) {
      const tx = await r.text().catch(() => "");
      const err = new Error(`HTTP ${r.status}: ${tx.slice(0,600)}`);
      err.status = r.status;
      throw err;
    }
    const ctype = (r.headers && r.headers.get && r.headers.get("content-type")) || "";
    if (!r.body || typeof r.body.getReader !== "function" || /application\/json/i.test(ctype)) {
      const tx = await r.text();
      let data;
      try { data = JSON.parse(tx); } catch { throw new Error("Unreadable response body."); }
      const m = data?.choices?.[0]?.message;
      if (!m) throw new Error("Empty or incompatible model response.");
      if (typeof m.content === "string" && m.content && onDelta) onDelta(m.content);
      return m;
    }
    return await readSSE(r, signal, onDelta);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/* ------------------------------------------------------ discovery */
async function discover(raw, key, fallbacks = "") {
  const eps = endpointList(raw, fallbacks);
  let lastErr = null;
  for (const ep of eps) {
    const started = Date.now();
    try {
      const data = await apiFetch(ep.models, key, { method:"GET" }, 12000);
      const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : [];
      const ids = arr.map(x => (typeof x === "string" ? x : x?.id)).filter(Boolean);
      if (!ids.length) throw Error("The API returned no identifiable models.");
      const priority = ids.filter(id => /(gpt|o\d|claude|gemini|qwen|llama|mistral|deepseek|command|sonnet|glm|kimi|grok)/i.test(id));
      const candidates = [...new Set([...priority, ...ids])].slice(0, 8);
      const checks = await Promise.all(candidates.map(async id => {
        try {
          const r = await apiFetch(ep.chat, key, {
            method:"POST",
            headers:{ "Content-Type":"application/json" },
            body: JSON.stringify({ model:id, messages:[{ role:"user", content:"Reply exactly: OK" }], temperature:0, max_tokens:5 })
          }, 9000);
          const ok = !!(r?.choices?.[0]?.message || r?.output?.[0] || r?.output_text || r?.message);
          return ok ? id : null;
        } catch { return null; }
      }));
      const verified = checks.filter(Boolean);
      if (verified.length) {
        return { endpoint:ep, models:ids, verified, selected:verified[0], endpoints:eps.map(x => x.base), latency: Date.now() - started };
      }
      lastErr = Error("Models were listed but none passed the Chat Completions health check.");
    } catch (e) { lastErr = e; }
  }
  throw lastErr || Error("No healthy API endpoint found.");
}

/* --------------------------------------------------- state + emit */
async function saveRuntime() {
  try { await chrome.storage.local.set({ agentState:{ ...runtime, messages: runtime.messages.slice(-80) } }); } catch {}
}
let saveTimer = null;
function saveRuntimeSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveRuntime(); }, 400);
}
async function clearRuntime() { runtime = blankRuntime(); await saveRuntime(); }

function signal(type, payload = {}) {
  try { chrome.runtime.sendMessage({ type, ...payload }).catch(() => {}); } catch {}
}

async function emit(label, text, level = "", extra = {}) {
  runtime.currentAction = text || label;
  saveRuntimeSoon();
  signal("agentEvent", { label, text, level, ...extra });
}

/* streaming deltas are batched so the panel is not flooded per token */
let deltaBuf = "", deltaTimer = null;
function pushDelta(text) {
  if (!text) return;
  deltaBuf += text;
  if (deltaTimer) return;
  deltaTimer = setTimeout(flushDelta, 60);
}
function flushDelta() {
  if (deltaTimer) { clearTimeout(deltaTimer); deltaTimer = null; }
  if (!deltaBuf) return;
  const t = deltaBuf;
  deltaBuf = "";
  signal("agentDelta", { text:t });
}
function resetDelta() {
  if (deltaTimer) { clearTimeout(deltaTimer); deltaTimer = null; }
  deltaBuf = "";
}

/* -------------------------------------------------------- tab I/O */
async function sendTab(id, type, args = {}, frameId = 0) {
  try {
    return await chrome.tabs.sendMessage(id, { type, args }, { frameId });
  } catch (e) {
    const msg = e?.message || String(e);
    if (/Receiving end does not exist|Could not establish connection|message port closed/i.test(msg)) {
      try {
        await chrome.scripting.executeScript({ target:{ tabId:id, allFrames:true }, files:["content.js"] });
        return await chrome.tabs.sendMessage(id, { type, args }, { frameId });
      } catch (e2) {
        return { ok:false, error: e2?.message || String(e2) };
      }
    }
    return { ok:false, error: msg };
  }
}

/* When the main frame cannot find an element, locate the frame that can. */
async function locateFrame(id, args) {
  try {
    const res = await chrome.scripting.executeScript({
      target:{ tabId:id, allFrames:true },
      args:[args || {}],
      func: a => {
        try { return !!(window.__webspiderLocate && window.__webspiderLocate(a)); }
        catch { return false; }
      }
    });
    const hit = (res || []).find(r => r && r.result === true);
    return hit ? hit.frameId : null;
  } catch { return null; }
}

async function tabAction(t, type, a) {
  const res = await sendTab(t.id, type, a);
  if (res && res.ok === false && /not found/i.test(res.error || "")) {
    const fid = await locateFrame(t.id, a);
    if (fid !== null && fid !== 0) {
      const r2 = await sendTab(t.id, type, a, fid);
      if (r2 && r2.ok !== false) return r2;
    }
  }
  return res;
}

async function activeTab() {
  if (runtime.tabId) {
    try { const t = await chrome.tabs.get(runtime.tabId); if (t?.id) return t; } catch {}
  }
  const tabs = await chrome.tabs.query({ active:true, currentWindow:true });
  return tabs[0];
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* --------------------------------------------------- execution plan */
/* Consecutive read-only calls run concurrently; a mutating call is a barrier,
   so the order the model asked for is the order the page sees.
   mark_page/diff_page are deliberately NOT read-only: a diff is only meaningful
   if the marker was written first, so they must never be reordered. */
export const READ_ONLY = new Set([
  "page_snapshot","page_state","page_diagnostics","detect_human_check","query_elements",
  "get_table","get_form","find_in_page","get_selection","console_logs","dialog_log",
  "network_log","styles_of","audit","extract","screenshot","highlight","draw",
  "wait","wait_for_element","wait_for_text","wait_for_dom_stable","wait_for_network_idle",
  "sync_browser_target"
]);

/* Actions whose result is worth checking against a fresh page_state. */
export const VERIFY_AFTER = new Set([
  "navigate","back","forward","open_tab","click","click_at","type","clear_field",
  "select","check","submit_form","press_key"
]);

/* Any action that can change the page invalidates the snapshot cache. */
const INVALIDATES = new Set([...VERIFY_AFTER, "scroll","scroll_to","hover","focus","set_dialog_policy"]);

export function speedProfile(s = {}) {
  const speed = ["fast", "balanced", "thorough"].includes(s.speed) ? s.speed : "balanced";
  const cacheOn = s.cacheSnapshot !== false;
  const verifyOn = s.autoVerify !== false;
  if (speed === "fast")     return { speed, snapshotTtl: cacheOn ? 3000 : 0, verify: false,      settle: 120 };
  if (speed === "thorough") return { speed, snapshotTtl: 0,               verify: verifyOn,     settle: 320 };
  return                           { speed, snapshotTtl: cacheOn ? 1200 : 0, verify: verifyOn,  settle: 200 };
}

export function parseArgs(call) {
  try { return JSON.parse(call?.function?.arguments || "{}") || {}; } catch { return {}; }
}

/* ------------------------------------------------- snapshot caching */
let snapCache = { at: 0, tabId: null, data: null };
export function invalidateSnapshot() { snapCache = { at: 0, tabId: null, data: null }; }

async function readSnapshot(t, ttl = 0) {
  const now = Date.now();
  if (ttl > 0 && snapCache.data && snapCache.tabId === t.id && now - snapCache.at < ttl) {
    return { ok: true, data: snapCache.data, cached: true };
  }
  const r = await sendTab(t.id, "snapshot");
  if (r && r.ok !== false && r.data) snapCache = { at: now, tabId: t.id, data: r.data };
  return r;
}

/* ------------------------------------------- human-check watchdog */
/* WebSpider never solves a challenge. It pauses, watches until the user has
   cleared it, then resumes the run automatically from the same step. */
let humanWatch = null;
export function stopHumanWatch() { if (humanWatch) { clearInterval(humanWatch); humanWatch = null; } }

export function watchHumanCheck(tabId, onSolved, { intervalMs = 2500, maxMs = 600000 } = {}) {
  stopHumanWatch();
  const started = Date.now();
  humanWatch = setInterval(async () => {
    if (stopped) return stopHumanWatch();
    if (Date.now() - started > maxMs) {
      stopHumanWatch();
      signal("humanCheckTimeout", { message: "The verification challenge was not completed in time." });
      return;
    }
    const r = await sendTab(tabId, "human_check");
    if (r?.ok === false) return;              /* frame gone or navigating — keep watching */
    if (r?.data?.present !== true) { stopHumanWatch(); signal("humanCheckSolved", {}); onSolved(); }
  }, intervalMs);
}

/* ------------------------------------------------ auto-verification */
/* "Did the click actually do anything?" is the single most common way a
   browser agent lies to itself. Every mutating action is followed by a cheap
   page_state read, and the delta is attached to the tool result. */
async function verifyAfter(t) {
  const r = await sendTab(t.id, "page_state");
  if (!r || r.ok === false || !r.data) return null;
  const d = r.data;
  const before = runtime.lastState || null;
  runtime.lastState = { token:d.token, url:d.url, title:d.title, controls:d.controls, textLength:d.textLength };
  if (!before) return { note:"Post-action page state captured.", ...runtime.lastState, busy:!!d.busy };
  const changed = before.token !== d.token;
  return {
    changed,
    urlChanged: before.url !== d.url,
    from: before.url, to: d.url,
    title: d.title,
    controls: d.controls,
    deltaControls: (d.controls || 0) - (before.controls || 0),
    deltaText: (d.textLength || 0) - (before.textLength || 0),
    busy: !!d.busy,
    note: changed
      ? "The page changed after this action."
      : "The page did NOT change after this action — the action may not have worked."
  };
}

/* ------------------------------------------- human-check pause/resume */
async function pauseForHuman(t, reason, vendor = "") {
  let image = null;
  try { image = (await act(t, "screenshot", {}, {}))?.image || null; } catch {}
  runtime.status = "waiting_human";
  await saveRuntime();
  activeAbort = null;
  if (image) {
    runtime.messages.push({ role:"user", content:[
      { type:"text", text:"Visible browser screen at the human-verification checkpoint. Do not solve it; use it only to understand what the user must complete." },
      { type:"image_url", image_url:{ url:image } }
    ]});
    await saveRuntime();
  }
  signal("humanCheck", { message:reason, image, autoResume:true, vendor });
  watchHumanCheck(t.id, async () => {
    if (stopped) return;
    try {
      const message = await run(runtime.task, runtime.mode, { resume:true });
      signal("agentFinished", { message, status: runtime.status, resumed:true });
      if (runtime.status === "done") notifyDone("WebSpider finished", message);
    } catch (e) {
      const msg = e.message || String(e);
      signal("agentFinished", { message: msg, status:"paused", resumed:true });
    }
  });
  return "Waiting for human verification. Complete it in the browser — WebSpider resumes automatically from the same step.";
}

function retryableError(e) {
  const status = Number(e?.status || 0);
  if ([400, 401, 403, 404, 422].includes(status)) return false;
  return true;
}

/* ----------------------------------------------------- message trim */
export function trimMessages(messages, limit = 45) {
  if (!Array.isArray(messages) || !messages.length) return [];
  const head = messages[0] && messages[0].role === "system" ? [messages[0]] : [];
  let tail = messages.slice(head.length);
  const room = Math.max(4, limit - head.length);
  if (tail.length > room) tail = tail.slice(tail.length - room);
  /* injected: leading-tool guard removed */

  const referenced = new Set();
  for (const m of tail) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) if (c && c.id) referenced.add(c.id);
    }
  }
  const answered = new Set(
    tail.filter(m => m.role === "tool" && m.tool_call_id && referenced.has(m.tool_call_id)).map(m => m.tool_call_id)
  );

  const out = [];
  for (const m of tail) {
    if (m.role === "tool") { if (m.tool_call_id && answered.has(m.tool_call_id)) out.push(m); continue; }
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const keep = m.tool_calls.filter(c => c && c.id && answered.has(c.id));
      if (!keep.length) { if (m.content) out.push({ role:"assistant", content:m.content }); continue; }
      out.push({ ...m, tool_calls:keep });
      continue;
    }
    out.push(m);
  }
  return [...head, ...out];
}

export function compactMessages(messages) {
  return trimMessages(messages).map(m => {
    if (m.role === "tool") return { ...m, content: String(m.content ?? "").slice(0, 9000) };
    if (Array.isArray(m.content)) return m;
    if (typeof m.content === "string" && m.content.length > 12000) return { ...m, content: m.content.slice(0, 12000) };
    return m;
  });
}

/* -------------------------------------------------------- call AI */
async function callAI(s, msgs, hooks = {}) {
  const eps = endpointList(s.endpoint, s.fallbackEndpoints);
  const models = [...new Set([...(s.verifiedModels || []), s.model].filter(Boolean))];
  if (!models.length) throw Error("No verified models are configured. Open Settings and verify a model.");
  const preferred = Math.max(0, Math.min(Number(runtime.modelIndex) || 0, models.length - 1));
  const order = models.map((_, i) => models[(preferred + i) % models.length]);
  const retries = Math.max(0, Math.min(1, Number(s.retryCount) || 0));
  const useStream = s.streaming !== false;
  const timeout = Number(s.requestTimeout) || 18000;
  const errors = [];

  for (let mi = 0; mi < order.length; mi++) {
    const model = order[mi];
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (stopped) throw Error("Agent stopped.");
      for (const ep of eps) {
        let streamOpen = false;
        const openStream  = () => { if (useStream && !streamOpen) { streamOpen = true; resetDelta(); hooks.onStreamStart && hooks.onStreamStart(); } };
        const closeStream = m => { if (streamOpen) { streamOpen = false; flushDelta(); hooks.onStreamEnd && hooks.onStreamEnd(m || null); } };
        try {
          if (stopped) throw Error("Agent stopped.");
          await emit("MODEL", `${model} · request ${attempt + 1}`, "model", { model });
          const body = { model, messages:msgs, temperature:Number(s.temperature ?? 0.15), tools:TOOLS, tool_choice:"auto" };
          const started = Date.now();
          let message = null;

          if (useStream) {
            openStream();
            try {
              message = await streamChat(ep, s.apiKey, body, timeout, activeAbort?.signal, t => { pushDelta(t); hooks.onDelta && hooks.onDelta(t); });
            } catch (se) {
              if (stopped) throw se;
              const st = Number(se?.status || 0);
              if (st === 400 || st === 422) {
                /* provider rejected stream:true — retry the same target without streaming */
                const r = await apiFetch(ep.chat, s.apiKey, {
                  method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body)
                }, timeout, activeAbort?.signal);
                message = r?.choices?.[0]?.message || null;
                if (message && typeof message.content === "string" && message.content) {
                  pushDelta(message.content);
                  hooks.onDelta && hooks.onDelta(message.content);
                }
              } else throw se;
            }
          } else {
            const r = await apiFetch(ep.chat, s.apiKey, {
              method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body)
            }, timeout, activeAbort?.signal);
            message = r?.choices?.[0]?.message || null;
          }

          if (!message || typeof message !== "object") throw Error("Empty or incompatible model response.");
          const reasoning = message.__reasoning;
          delete message.__reasoning;

          closeStream(message);
          runtime.modelIndex = models.indexOf(model);
          try {
            await chrome.storage.local.set({
              model, endpoint:ep.base, connectionOk:true,
              lastHealthyModel:model, lastHealthyEndpoint:ep.base, lastLatency: Date.now() - started
            });
          } catch {}
          return { message, model, endpoint:ep.base, reasoning: reasoning || "" };
        } catch (e) {
          closeStream(null);
          if (stopped) throw e;
          const detail = e?.message || String(e);
          errors.push(`${model}@${ep.base}: ${detail}`);
          await emit("RETRY", `${model} failed · ${detail.slice(0, 140)}`, "warn", { model });
          if (retryableError(e) && attempt < retries) await sleep(150);
          else break;
        }
      }
    }
    if (mi < order.length - 1) {
      const next = order[mi + 1];
      runtime.modelIndex = models.indexOf(next);
      await emit("FAILOVER", `Switching to ${next} · continuing from the same step`, "warn", { model:next });
    }
  }
  const e = new Error(`All verified models and endpoints failed. ${errors.slice(-4).join(" | ")}`);
  e.recoverable = true;
  throw e;
}

/* ---------------------------------------------------- confirmation */
async function confirm(action, reason) {
  const id = String(++seq);
  pending = { id, approved:null };
  signal("agentConfirm", { id, action, reason });
  while (pending && pending.approved === null && !stopped) await sleep(120);
  const ok = pending?.approved === true;
  pending = null;
  return ok;
}

export function risky(a = {}) {
  const x = `${a.selector || ""} ${a.text || ""} ${a.label || ""} ${a.elementId || ""}`.toLowerCase();
  return /(delete|remove|buy|purchase|checkout|pay|submit|send|publish|post|confirm|order|unsubscribe|حذف|خرید|پرداخت|ارسال|ثبت|انتشار|لغو اشتراک)/i.test(x);
}
export function looksHumanCheck(a = {}) {
  return /(captcha|recaptcha|hcaptcha|turnstile|i'm not a robot|im not a robot|verify you are human|verify you're human|من ربات نیستم)/i.test(JSON.stringify(a));
}

/* --------------------------------------------------------- actions */
async function act(t, name, a, s) {
  if (name === "page_snapshot") return readSnapshot(t, speedProfile(s).snapshotTtl);
  if (name === "page_state") return sendTab(t.id, "page_state");
  if (name === "page_diagnostics") return sendTab(t.id, "diagnostics");
  if (name === "detect_human_check") return sendTab(t.id, "human_check");
  if (name === "query_elements") return sendTab(t.id, "query_elements", a);
  if (name === "get_table") return tabAction(t, "get_table", a);
  if (name === "get_form") return tabAction(t, "get_form", a);
  if (name === "find_in_page") return sendTab(t.id, "find_in_page", a);
  if (name === "get_selection") return sendTab(t.id, "get_selection");
  if (name === "console_logs") return sendTab(t.id, "console_logs", a);
  if (name === "dialog_log") return sendTab(t.id, "dialog_log", a);
  if (name === "network_log") return sendTab(t.id, "network_log", a);
  if (name === "styles_of") return tabAction(t, "styles_of", a);
  if (name === "audit") return sendTab(t.id, "audit", a);
  if (name === "mark_page") return sendTab(t.id, "mark_page");
  if (name === "diff_page") return sendTab(t.id, "diff_page");
  if (name === "set_dialog_policy") return sendTab(t.id, "set_dialog_policy", a);

  if (name === "navigate") { await chrome.tabs.update(t.id, { url:a.url }); await sleep(speedProfile(s).settle); return { ok:true, url:a.url }; }
  if (name === "back") { await chrome.tabs.goBack(t.id); await sleep(speedProfile(s).settle); return { ok:true }; }
  if (name === "forward") { await chrome.tabs.goForward(t.id); await sleep(speedProfile(s).settle); return { ok:true }; }
  if (name === "open_tab") {
    const nt = await chrome.tabs.create({ url:a.url, active:true });
    runtime.tabId = nt.id; runtime.windowId = nt.windowId;
    await saveRuntime(); await sleep(speedProfile(s).settle);
    return { ok:true, tabId:nt.id, url:a.url };
  }
  if (name === "click") {
    if (looksHumanCheck(a)) return { humanVerification:true, needsUser:true, message:"Human verification detected. User action required." };
    if (s.confirmRisk && risky(a) && !(await confirm(`Click: ${a.text || a.label || a.selector || a.elementId}`, "This may submit, delete, purchase, publish or otherwise change data."))) {
      return { cancelled:true };
    }
    const res = await tabAction(t, "click", a);
    await sleep(180);
    try {
      const inWin = await chrome.tabs.query({ active:true, windowId:t.windowId });
      const cand = inWin.find(x => x.id && x.id !== t.id);
      if (cand) {
        runtime.tabId = cand.id; runtime.windowId = cand.windowId;
        await saveRuntime();
        res.popupOpened = true; res.tabId = cand.id; res.url = cand.url;
      }
    } catch {}
    return res;
  }
  if (name === "click_at") return sendTab(t.id, "click_at", a);
  if (name === "type")   return tabAction(t, "type", a);
  if (name === "clear_field") return tabAction(t, "clear_field", a);
  if (name === "select") return tabAction(t, "select", a);
  if (name === "check") {
    if (s.confirmRisk && risky(a) && !(await confirm(`Toggle: ${a.text || a.label || a.selector || a.elementId}`, "This control changes saved data."))) {
      return { cancelled:true };
    }
    return tabAction(t, "check", a);
  }
  if (name === "hover")  return tabAction(t, "hover", a);
  if (name === "focus")  return tabAction(t, "focus_el", a);
  if (name === "submit_form") {
    if (s.confirmRisk && !(await confirm(`Submit form: ${a.text || a.label || a.selector || "the current form"}`, "Submitting a form can send, order, publish or delete data."))) {
      return { cancelled:true };
    }
    return tabAction(t, "submit_form", a);
  }
  if (name === "press_key") return tabAction(t, "key", a);
  if (name === "scroll") return sendTab(t.id, "scroll", a);
  if (name === "scroll_to") return tabAction(t, "scroll_to", a);
  if (name === "wait")   return sendTab(t.id, "wait", a);
  if (name === "wait_for_element") return sendTab(t.id, "wait_for_element", a);
  if (name === "wait_for_text") return sendTab(t.id, "wait_for_text", a);
  if (name === "wait_for_dom_stable") return sendTab(t.id, "wait_for_dom_stable", a);
  if (name === "wait_for_network_idle") return sendTab(t.id, "wait_for_network_idle", a);
  if (name === "extract")return sendTab(t.id, "extract", a);
  if (name === "highlight") return tabAction(t, "highlight", a);
  if (name === "draw")   return sendTab(t.id, "draw", a);
  if (name === "screenshot") {
    const at = await activeTab();
    const winId = at?.windowId || t.windowId;
    return { image: await chrome.tabs.captureVisibleTab(winId, { format:"jpeg", quality:78 }) };
  }
  if (name === "sync_browser_target") {
    const nt = await activeTab();
    if (!nt?.id) return { ok:false, error:"No active browser tab found." };
    runtime.tabId = nt.id; runtime.windowId = nt.windowId;
    await saveRuntime();
    return { ok:true, tabId:nt.id, windowId:nt.windowId, url:nt.url, title:nt.title };
  }
  if (name === "ask_confirmation") return { confirmed: await confirm(a.action, a.reason) };
  if (name === "human_verification") return { needsUser:true, humanVerification:true, message:"Please complete the human verification in the browser. WebSpider resumes automatically from this step." };
  return { error:"Unknown tool" };
}

/* ------------------------------------------------------------- run */
/* exported so the Node harness can drive a whole run against a stubbed model */
export async function run(task, mode, { resume = false } = {}) {
  stopped = false;
  activeAbort = new AbortController();
  resetDelta();

  const s = await getSettings();
  if (!s.apiKey) throw Error("API Key is missing. Open Settings and connect a model.");
  const models = [...new Set([...(s.verifiedModels || []), s.model].filter(Boolean))];
  if (!models.length) throw Error("No verified models are configured. Open Settings and verify a model.");

  /* the run-time speed/verification policy: snapshot TTL, settle time, auto-verify */
  const profile = speedProfile(s);

  let t;
  if (resume && runtime.tabId) { try { t = await chrome.tabs.get(runtime.tabId); } catch {} }
  if (!t || !t.id) t = await activeTab();
  if (!t?.id) throw Error("Active tab not found.");

  /* an explicit dialog policy survives the run; "record" leaves the page alone */
  if (s.dialogPolicy && s.dialogPolicy !== "record") {
    try { await sendTab(t.id, "set_dialog_policy", { policy: s.dialogPolicy }); } catch {}
  }

  const max = Math.min(100, Math.max(5, Number(s.maxSteps) || 40));
  runtime = {
    runId: resume && runtime.runId ? runtime.runId : `run_${Date.now()}`,
    tabId: t.id, windowId: t.windowId,
    task: resume && runtime.task ? runtime.task : task,
    mode: resume && runtime.mode ? runtime.mode : (mode || "agent"),
    messages: resume && runtime.messages?.length ? runtime.messages : [],
    turn: resume ? runtime.turn || 0 : 0,
    max,
    modelIndex: resume ? runtime.modelIndex || 0 : 0,
    models,
    startedAt: resume && runtime.startedAt ? runtime.startedAt : Date.now(),
    currentAction:"Starting…", status:"running",
    lastState: resume ? runtime.lastState || null : null
  };
  await saveRuntime();

  if (!resume) {
    invalidateSnapshot();
    const snap = await readSnapshot(t, 0);
    /* seed the verification baseline so the very first action's "did it change?"
       answer is meaningful rather than "unknown" */
    const st = await sendTab(t.id, "page_state");
    if (st?.ok !== false && st?.data) {
      runtime.lastState = { token:st.data.token, url:st.data.url, title:st.data.title, controls:st.data.controls, textLength:st.data.textLength };
    }
    const modeLine = MODE_PROMPTS[runtime.mode] || MODE_PROMPTS.agent;
    runtime.messages = [
      { role:"system", content:`${SYSTEM}\n${modeLine}\n${s.system || ""}\nAlways answer in the same language the user writes in.` },
      { role:"user", content:`Task:\n${runtime.task}\n\nCurrent page state:\n${JSON.stringify(st?.data || null).slice(0, 1500)}\n\nCurrent page evidence:\n${JSON.stringify(snap?.data || snap).slice(0, 18000)}` }
    ];
    await saveRuntime();
  }

  const hooks = {
    onStreamStart: () => signal("agentStreamStart"),
    onDelta: () => {},
    onStreamEnd: m => signal("agentStreamEnd", { final: !!(m && m.content && !(m.tool_calls && m.tool_calls.length)) })
  };

  /* Turn a finished tool call into: cache invalidation, tab re-targeting,
     optional verification, the tool message, and a possible pause.
     Returns a halt string when the run must stop here. */
  async function settle(c, res, opts = {}) {
    const name = c.function?.name || "";
    if (INVALIDATES.has(name)) invalidateSnapshot();
    if (res?.tabId) {
      try { t = await chrome.tabs.get(res.tabId); runtime.tabId = t.id; runtime.windowId = t.windowId; } catch {}
    }

    let after = null;
    if (!opts.parallel && opts.verify && VERIFY_AFTER.has(name) && !res?.error) after = await verifyAfter(t);

    runtime.messages.push({ role:"tool", tool_call_id:c.id, content: JSON.stringify(after ? { ...res, after } : res).slice(0, 12000) });
    if (res?.image && s.vision !== false) {
      runtime.messages.push({ role:"user", content:[{ type:"text", text:"Current visible screenshot:" }, { type:"image_url", image_url:{ url: res.image } }] });
    }
    await saveRuntime();

    if (res?.cancelled) {
      runtime.status = "paused"; await saveRuntime(); activeAbort = null;
      return "Operation cancelled by user.";
    }

    const explicit = !!(res?.humanVerification || res?.needsUser);
    const detected = (name === "detect_human_check" && res?.data?.present === true)
      || ((name === "page_snapshot" || name === "diff_page") && res?.data?.humanCheck?.present === true);
    if (explicit || (detected && s.humanAssist !== false)) {
      const vendor = res?.data?.vendor || "";
      return await pauseForHuman(t, "Human verification is required in the browser. Complete it, then WebSpider resumes automatically.", vendor);
    }
    return null;
  }

  const runOne = async c => {
    await emit("ACTION", c.function.name, "tool", { tool:c.function.name });
    try { return await act(t, c.function.name, parseArgs(c), s); }
    catch (e) { return { error: e.message || String(e) }; }
  };

  for (let turn = runtime.turn; turn < max; turn++) {
    runtime.turn = turn;
    await saveRuntime();
    if (stopped) { runtime.status = "paused"; await saveRuntime(); activeAbort = null; return "Paused. Press Resume to continue."; }

    signal("agentProgress", { step: turn + 1, max });
    await emit("THINK", `Working · step ${turn + 1} of ${max}`);

    let result;
    try {
      result = await callAI(s, compactMessages(runtime.messages), hooks);
    } catch (e) {
      runtime.status = "paused";
      await saveRuntime();
      activeAbort = null;
      signal("agentPaused", { reason: e.message || String(e), canResume:true });
      throw e;
    }

    const m = result.message;
    if (result.reasoning && s.showThoughts !== false) {
      await emit("THINK", `Reasoning · ${result.reasoning.slice(0, 300)}`);
    }
    runtime.messages.push(m);
    runtime.modelIndex = runtime.models.indexOf(result.model);
    await saveRuntime();

    const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    if (!calls.length) {
      runtime.status = "done";
      await saveRuntime();
      return m.content || "Task completed.";
    }
    if (runtime.mode === "plan" && turn === 0) {
      runtime.status = "done";
      await saveRuntime();
      return m.content || "Plan drafted. Switch to Agent mode and run it to execute.";
    }

    const verify = profile.verify;
    let idx = 0;
    while (idx < calls.length) {
      if (stopped) { runtime.status = "paused"; await saveRuntime(); activeAbort = null; return "Paused. Press Resume to continue."; }

      if (READ_ONLY.has(calls[idx].function?.name)) {
        /* gather the maximal consecutive run of read-only calls and run it at once */
        const batch = [];
        while (idx < calls.length && READ_ONLY.has(calls[idx].function?.name)) batch.push(calls[idx++]);
        const results = await Promise.all(batch.map(async c => ({ c, res: await runOne(c) })));
        for (const { c, res } of results) {
          const halt = await settle(c, res, { parallel:true, verify:false });
          if (halt) return halt;
        }
        continue;
      }

      const c = calls[idx++];
      const res = await runOne(c);
      const halt = await settle(c, res, { verify });
      if (halt) return halt;
    }
  }

  runtime.status = "paused";
  await saveRuntime();
  activeAbort = null;
  return `Paused at the ${max}-step safety limit. Resume to continue.`;
}

/* -------------------------------------------------------- notify */
async function notifyDone(title, message) {
  try {
    const s = await getSettings();
    if (s.notify !== true) return;
    await chrome.notifications.create(`ws_${Date.now()}`, {
      type:"basic", iconUrl:"icon128.png", title, message: String(message || "").slice(0, 200), priority:1
    });
  } catch {}
}

/* -------------------------------------------------------- wiring */
chrome.runtime.onInstalled.addListener(async () => {
  try { await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick:true }); } catch {}
});
chrome.runtime.onStartup.addListener(async () => {
  try { await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick:true }); } catch {}
});

chrome.runtime.onMessage.addListener((m, _sender, send) => {
  if (!m || !m.type) return;

  if (m.type === "discoverModels") {
    (async () => {
      try {
        const r = await discover(m.endpoint, m.apiKey, m.fallbackEndpoints || "");
        await chrome.storage.local.set({
          endpoint:r.endpoint.base, model:r.selected, verifiedModels:r.verified, allModels:r.models,
          connectionOk:true, lastHealthyModel:r.selected, lastHealthyEndpoint:r.endpoint.base, lastLatency:r.latency
        });
        send({ ok:true, models:r.verified, selected:r.selected, endpoints:r.endpoints, latency:r.latency });
      } catch (e) {
        await chrome.storage.local.set({ connectionOk:false });
        send({ ok:false, error: e.message || String(e) });
      }
    })();
    return true;
  }

  if (m.type === "runAgent") {
    stopHumanWatch();
    run(m.task, m.mode)
      .then(message => {
        signal("agentFinished", { message, status: runtime.status });
        send({ ok:true, message, status: runtime.status });
        if (runtime.status === "done") notifyDone("WebSpider finished", message);
      })
      .catch(e => {
        const msg = e.message || String(e);
        signal("agentFinished", { message: msg, status:"paused" });
        send({ ok:false, error: msg, canResume:true });
        notifyDone("WebSpider paused", msg);
      });
    return true;
  }

  if (m.type === "resumeAgent") {
    stopHumanWatch();
    chrome.storage.local.get("agentState")
      .then(d => { if (d.agentState) runtime = { ...runtime, ...d.agentState }; return run(runtime.task, runtime.mode, { resume:true }); })
      .then(message => {
        signal("agentFinished", { message, status: runtime.status });
        send({ ok:true, message, status: runtime.status });
      })
      .catch(e => {
        const msg = e.message || String(e);
        signal("agentFinished", { message: msg, status:"paused" });
        send({ ok:false, error: msg, canResume:true });
      });
    return true;
  }

  if (m.type === "stopAgent") {
    stopped = true;
    stopHumanWatch();
    if (activeAbort) activeAbort.abort();
    if (pending) pending.approved = false;
    resetDelta();
    runtime.status = "paused";
    saveRuntime();
    send({ ok:true });
    return;
  }
  if (m.type === "confirmation") { if (pending && pending.id === m.id) pending.approved = !!m.approved; send({ ok:true }); return; }
  if (m.type === "getAgentState") { chrome.storage.local.get("agentState").then(d => send({ ok:true, state: d.agentState || runtime })); return true; }
  if (m.type === "clearAgentState") { clearRuntime().then(() => send({ ok:true })); return true; }
  if (m.type === "pageSummary") {
    activeTab()
      .then(async t => {
        if (!t?.id) throw Error("No active tab found.");
        const r = await sendTab(t.id, "snapshot");
        send({ ok:true, message: JSON.stringify(r?.data || r, null, 2).slice(0, 9000) });
      })
      .catch(e => send({ ok:false, error: e.message || String(e) }));
    return true;
  }
});

chrome.commands.onCommand.addListener(async c => {
  if (c === "open-webspider") {
    const t = await activeTab();
    if (t?.windowId) await chrome.sidePanel.open({ windowId:t.windowId });
  }
});

/* exported for the verification harness */
