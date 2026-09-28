/* Core tests for background.js: endpoint parsing, message trimming invariants,
   SSE assembly and the streaming fallback path. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const tmp  = join(here, ".tmp");
mkdirSync(tmp, { recursive: true });

let pass = 0;
const failures = [];
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; }
  else failures.push(`${name}${extra ? " — " + extra : ""}`);
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

/* ---- chrome stub: background.js touches these at import time ---- */
const store = {};
const signals = [];
globalThis.chrome = {
  storage: { local: {
    get: async k => { const o = {}; for (const key of [].concat(k)) if (key in store) o[key] = store[key]; return o; },
    set: async o => Object.assign(store, o),
    remove: async k => { for (const key of [].concat(k)) delete store[key]; }
  } },
  runtime: {
    onInstalled:{addListener(){}}, onStartup:{addListener(){}}, onMessage:{addListener(){}},
    sendMessage: async m => { signals.push(m); return {}; },
    getManifest: () => ({ version: "8.0.0" })
  },
  commands: { onCommand:{addListener(){}} },
  /* the tab channel the human-check watchdog polls through */
  tabs: {
    sendMessage: async () => ({ ok:true, data:{ present:false } }),
    get:   async id => ({ id, windowId:1, url:"https://page.test/", title:"Test" }),
    query: async () => [{ id:1, windowId:1, url:"https://page.test/", title:"Test" }],
    create: async o => ({ id:2, windowId:1, url:o?.url || "", title:"New" }),
    update: async () => {}, goBack: async () => {}, goForward: async () => {},
    captureVisibleTab: async () => "data:image/jpeg;base64,AAAA"
  },
  scripting: {}, notifications: {}, sidePanel: {}
};

/* background.js is an ES module; Node needs the .mjs extension to parse it as one */
const mjs = join(tmp, "background.mjs");
writeFileSync(mjs, readFileSync(join(root, "background.js"), "utf8"));
const bg = await import(pathToFileURL(mjs).href);

/* ---------------------------------------------------- endpoints */
const N = bg.normalizeEndpoint;
eq("normalize base url",        N("https://api.openai.com/v1"), { base:"https://api.openai.com/v1", chat:"https://api.openai.com/v1/chat/completions", models:"https://api.openai.com/v1/models" });
eq("normalize trailing slash",  N("https://api.openai.com/v1/").base, "https://api.openai.com/v1");
eq("normalize full path",       N("https://x.dev/v1/chat/completions"), { base:"https://x.dev/v1", chat:"https://x.dev/v1/chat/completions", models:"https://x.dev/v1/models" });
ok("normalize empty throws",    (() => { try { N(""); return false; } catch { return true; } })());
ok("normalize junk throws",     (() => { try { N("not a url"); return false; } catch { return true; } })());

eq("endpointList dedupes",      bg.endpointList("https://a.dev/v1", "https://b.dev/v1\nhttps://a.dev/v1").map(e => e.base), ["https://a.dev/v1", "https://b.dev/v1"]);
eq("endpointList empty fallback", bg.endpointList("https://a.dev/v1", "").length, 1);

/* ------------------------------------------------- trim invariants */
const convo = [
  { role:"system", content:"S" },
  { role:"user", content:"u1" },
  { role:"assistant", content:"", tool_calls:[{ id:"c1", type:"function", function:{ name:"snapshot", arguments:"{}" } }] },
  { role:"tool", tool_call_id:"c1", content:"r1" },
  { role:"assistant", content:"a2", tool_calls:[{ id:"c2", type:"function", function:{ name:"click", arguments:"{}" } }] },
  { role:"tool", tool_call_id:"c2", content:"r2" },
  { role:"assistant", content:"done" },
  { role:"user", content:"u2" },
  { role:"assistant", content:"", tool_calls:[{ id:"c3", type:"function", function:{ name:"type", arguments:"{}" } }] },
  { role:"tool", tool_call_id:"c3", content:"r3" },
  { role:"assistant", content:"final" }
];

function invariants(list) {
  const calls = new Set();
  for (const m of list) if (m.role === "assistant" && Array.isArray(m.tool_calls)) for (const c of m.tool_calls) calls.add(c.id);
  const replies = new Set(list.filter(m => m.role === "tool").map(m => m.tool_call_id));
  for (const m of list) {
    if (m.role === "tool") ok("tool reply has a parent call", calls.has(m.tool_call_id), JSON.stringify(m));
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) ok("tool call has a reply", replies.has(c.id), JSON.stringify(m));
    }
  }
  ok("head stays a system message", list.length === 0 || list[0].role !== "tool");
  ok("no tool message first", list.length === 0 || list[0].role !== "tool");
}

for (let limit = 2; limit <= 20; limit++) invariants(bg.trimMessages(convo, limit));

const t6 = bg.trimMessages(convo, 6);
ok("trim keeps the system prompt", t6[0].role === "system");
ok("trim window respected", t6.length <= 6, `len=${t6.length}`);
ok("trim never starts with tool", t6[1] ? t6[1].role !== "tool" : true);

/* cutting a window so the assistant tool_call survives but its reply is gone */
const cut = bg.trimMessages([
  { role:"system", content:"S" },
  { role:"assistant", content:"", tool_calls:[{ id:"x1", function:{ name:"a", arguments:"{}" } }] },
  { role:"tool", tool_call_id:"x1", content:"r" },
  { role:"assistant", content:"later" }
], 3);
invariants(cut);

/* the real dangling case: a run was cancelled mid-turn, so the assistant holds
   two tool calls but only the first one ever produced a reply. */
const dangling = bg.trimMessages([
  { role:"system", content:"S" },
  { role:"user", content:"u" },
  { role:"assistant", content:"", tool_calls:[
    { id:"d1", function:{ name:"click", arguments:"{}" } },
    { id:"d2", function:{ name:"type", arguments:"{}" } }
  ]},
  { role:"tool", tool_call_id:"d1", content:"r1" }
], 20);
invariants(dangling);
const dAsst = dangling.find(m => m.role === "assistant" && Array.isArray(m.tool_calls));
ok("dangling tool call dropped", !!dAsst && dAsst.tool_calls.length === 1 && dAsst.tool_calls[0].id === "d1", JSON.stringify(dAsst));

/* same shape but the assistant also produced text: keep the text, drop the calls */
const danglingText = bg.trimMessages([
  { role:"system", content:"S" },
  { role:"assistant", content:"I will click it", tool_calls:[{ id:"e1", function:{ name:"click", arguments:"{}" } }] }
], 20);
invariants(danglingText);
const dtAsst = danglingText.find(m => m.role === "assistant");
ok("text kept when calls are dropped", dtAsst && dtAsst.content === "I will click it" && !dtAsst.tool_calls, JSON.stringify(dtAsst));

/* a reply whose parent call was cut away must not survive either */
const orphan = bg.trimMessages([
  { role:"system", content:"S" },
  { role:"assistant", content:"old" },
  { role:"tool", tool_call_id:"gone", content:"r" },
  { role:"user", content:"next" }
], 20);
invariants(orphan);
ok("orphan reply removed", !orphan.some(m => m.role === "tool"), JSON.stringify(orphan));

const mm = bg.compactMessages([
  { role:"user", content:[{ type:"text", text:"hi" }, { type:"image_url", image_url:{ url:"data:x" } }] },
  { role:"assistant", content:"", tool_calls:[{ id:"k", function:{ name:"extract", arguments:"{}" } }] },
  { role:"tool", tool_call_id:"k", content:"z".repeat(20000) }
]);
ok("multimodal content preserved", Array.isArray(mm[0].content));
eq("orphan tool message dropped", bg.compactMessages([{ role:"tool", tool_call_id:"nobody", content:"x" }]).length, 0);
ok("tool payload truncated", mm[2] && mm[2].content.length === 9000, `len=${mm[2] && mm[2].content.length}`);

/* ----------------------------------------------------------- risk */
ok("risky detects delete",  bg.risky({ text:"Delete account" }));
ok("risky detects Persian", bg.risky({ label:"خرید نهایی" }));
ok("risky ignores search",  !bg.risky({ text:"Search products" }));
ok("human check detected",  bg.looksHumanCheck({ text:"I'm not a robot" }));
ok("human check negative",  !bg.looksHumanCheck({ text:"Search" }));

/* -------------------------------------------------------- SSE path */
const enc = new TextEncoder();
const sse = lines => new Response(new ReadableStream({
  start(c) { for (const l of lines) c.enqueue(enc.encode(l)); c.close(); }
}), { status:200, headers:{ "content-type":"text/event-stream" } });

let deltas = "";
const streamed = await bg.readSSE(sse([
  'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"lo "}}]}\n\n',
  ': keep-alive comment\n\n',
  'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"page_","arguments":"{\\"sel"}}]}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"snapshot","arguments":"ector\\":\\"a\\"}"}}]}}]}\n\n',
  'data: [DONE]\n\n'
]), null, d => { deltas += d; });

eq("stream content assembled", streamed.content, "Hello ");
eq("stream deltas forwarded",  deltas, "Hello ");
eq("stream tool name merged",  streamed.tool_calls[0].function.name, "page_snapshot");
eq("stream tool args merged",  streamed.tool_calls[0].function.arguments, '{"selector":"a"}');
eq("stream tool id kept",      streamed.tool_calls[0].id, "call_9");
eq("reasoning captured",       streamed.__reasoning, "thinking");

/* chunk boundaries that split a JSON line mid-way */
const split = await bg.readSSE(sse(['data: {"choices":[{"delta"', ':{"content":"AB"}}]}\n\n']), null, () => {});
eq("split line reassembled", split.content, "AB");

/* empty stream must be treated as a failure, not a silent success */
let threw = false;
try { await bg.readSSE(sse(["data: [DONE]\n\n"]), null, () => {}); } catch { threw = true; }
ok("empty stream rejects", threw);

/* ------------------------------------------------- streamChat paths */
const ep = bg.normalizeEndpoint("https://api.test/v1");

bg.__setFetchImpl(async () => sse(['data: {"choices":[{"delta":{"content":"streamed"}}]}\n\n', 'data: [DONE]\n\n']));
let seen = "";
const m1 = await bg.streamChat(ep, "k", { model:"m", messages:[] }, 5000, null, d => { seen += d; });
eq("streamChat content", m1.content, "streamed");
eq("streamChat onDelta", seen, "streamed");

bg.__setFetchImpl(async () => new Response(JSON.stringify({ choices:[{ message:{ role:"assistant", content:"json-mode" } }] }), {
  status:200, headers:{ "content-type":"application/json" }
}));
let seen2 = "";
const m2 = await bg.streamChat(ep, "k", { model:"m", messages:[] }, 5000, null, d => { seen2 += d; });
eq("json body detected", m2.content, "json-mode");
eq("json body delta emitted", seen2, "json-mode");

bg.__setFetchImpl(async () => new Response("nope", { status:401, headers:{} }));
let status = 0;
try { await bg.streamChat(ep, "k", {}, 5000, null, () => {}); } catch (e) { status = e.status; }
eq("http error surfaces status", status, 401);

bg.__setFetchImpl(null);

/* --------------------------------------------------- mode prompts */
ok("three modes defined", Object.keys(bg.MODE_PROMPTS).length === 3);
ok("plan mode forbids acting", /Do NOT act yet/.test(bg.MODE_PROMPTS.plan));
ok("research mode is read-only", /never click/.test(bg.MODE_PROMPTS.research));
ok("every tool has a schema", bg.TOOLS.every(t => t.type === "function" && t.function.parameters.type === "object"));
ok("press_key tool exists", bg.TOOLS.some(t => t.function.name === "press_key"));
ok("no tool shadows another", new Set(bg.TOOLS.map(t => t.function.name)).size === bg.TOOLS.length);

/* ------------------------------------------------- speed profiles */
{
  const P = bg.speedProfile;
  eq("default profile is balanced", P({}).speed, "balanced");
  ok("balanced caches snapshots", P({}).snapshotTtl > 0);
  eq("balanced verifies after mutating actions", P({}).verify, true);
  eq("fast disables verification", P({ speed:"fast" }).verify, false);
  ok("fast caches snapshots longer than balanced", P({ speed:"fast" }).snapshotTtl > P({ speed:"balanced" }).snapshotTtl);
  eq("thorough never caches a snapshot", P({ speed:"thorough" }).snapshotTtl, 0);
  eq("thorough still verifies", P({ speed:"thorough" }).verify, true);
  ok("thorough settles longer than fast", P({ speed:"thorough" }).settle > P({ speed:"fast" }).settle);
  eq("cacheSnapshot:false disables the cache", P({ cacheSnapshot:false }).snapshotTtl, 0);
  eq("autoVerify:false disables verification", P({ autoVerify:false }).verify, false);
  eq("an unknown speed falls back to balanced", P({ speed:"turbo" }).speed, "balanced");
  eq("cacheSnapshot:false still honours fast mode", P({ speed:"fast", cacheSnapshot:false }).snapshotTtl, 0);
}

/* ------------------------------------------------------ parseArgs */
{
  const P = bg.parseArgs;
  eq("parseArgs reads JSON arguments", P({ function:{ arguments:'{"a":1}' } }), { a:1 });
  eq("parseArgs tolerates malformed JSON", P({ function:{ arguments:"{" } }), {});
  eq("parseArgs tolerates a missing call", P(null), {});
  eq("parseArgs tolerates missing arguments", P({ function:{} }), {});
  eq("parseArgs tolerates a literal null", P({ function:{ arguments:"null" } }), {});
  eq("parseArgs handles an array payload", P({ function:{ arguments:"[1,2]" } }), [1,2]);
}

/* ------------------------------------------- execution-set invariants */
{
  const toolNames = new Set(bg.TOOLS.map(t => t.function.name));
  eq("every read-only name is a real tool", [...bg.READ_ONLY].filter(n => !toolNames.has(n)), []);
  eq("every verified action is a real tool", [...bg.VERIFY_AFTER].filter(n => !toolNames.has(n)), []);
  eq("read-only and verified sets are disjoint", [...bg.READ_ONLY].filter(n => bg.VERIFY_AFTER.has(n)), []);

  ok("page_snapshot is parallelised", bg.READ_ONLY.has("page_snapshot"));
  ok("query_elements is parallelised", bg.READ_ONLY.has("query_elements"));
  ok("audit is parallelised", bg.READ_ONLY.has("audit"));
  ok("mark_page is NOT parallelised (order matters)", !bg.READ_ONLY.has("mark_page"));
  ok("diff_page is NOT parallelised (order matters)", !bg.READ_ONLY.has("diff_page"));
  ok("set_dialog_policy is NOT parallelised", !bg.READ_ONLY.has("set_dialog_policy"));
  ok("click is verified afterwards", bg.VERIFY_AFTER.has("click"));
  ok("type is verified afterwards", bg.VERIFY_AFTER.has("type"));
  ok("submit_form is verified afterwards", bg.VERIFY_AFTER.has("submit_form"));
  ok("scroll is not verified (it cannot change content)", !bg.VERIFY_AFTER.has("scroll"));
  ok("highlight is not verified", !bg.VERIFY_AFTER.has("highlight"));
  ok("the read-only set is a meaningful size", bg.READ_ONLY.size >= 20, `size=${bg.READ_ONLY.size}`);
}

/* --------------------------------------------- tool schema quality */
{
  const toolNames = new Set(bg.TOOLS.map(t => t.function.name));
  ok("the tool surface grew past v7 (20 tools)", bg.TOOLS.length >= 40, `count=${bg.TOOLS.length}`);
  ok("every tool has a real description", bg.TOOLS.every(t => (t.function.description || "").length > 25));
  ok("every required property is declared", bg.TOOLS.every(t => (t.function.parameters.required || []).every(r => r in t.function.parameters.properties)));
  ok("every tool forbids additional properties", bg.TOOLS.every(t => t.function.parameters.additionalProperties === false));

  for (const n of ["page_state","detect_human_check","query_elements","get_table","get_form","find_in_page",
                   "get_selection","console_logs","dialog_log","network_log","styles_of","audit",
                   "mark_page","diff_page","clear_field","check","hover","focus","click_at","submit_form",
                   "scroll_to","wait_for_element","wait_for_text","wait_for_dom_stable","wait_for_network_idle",
                   "set_dialog_policy"]) {
    ok(`tool ${n} is declared`, toolNames.has(n));
  }

  const hv = bg.TOOLS.find(t => t.function.name === "human_verification");
  ok("human_verification never offers to solve a challenge", /never solve or bypass/i.test(hv.function.description));
  const dh = bg.TOOLS.find(t => t.function.name === "detect_human_check");
  ok("detect_human_check is advertised as detection-only", /detection only/i.test(dh.function.description));
}

/* ------------------------------------------------------ system prompt */
ok("system prompt forbids bypassing a challenge", /Do NOT bypass CAPTCHA/.test(bg.SYSTEM));
ok("system prompt promises automatic resume", /resumes automatically/.test(bg.SYSTEM));
ok("system prompt explains the after block", /returns an "after" block/.test(bg.SYSTEM));
ok("system prompt warns when the page did not change", /did not change/i.test(bg.SYSTEM));
ok("system prompt names the wait tools", /wait_for_element/.test(bg.SYSTEM));
ok("system prompt names the audit tool", /audit/.test(bg.SYSTEM));

/* --------------------------------- human-check watchdog / auto-resume */
/* This is the mechanism that makes "pass the registration step" work without
   bypassing anything: pause, watch, and resume the moment the user clears it. */
{
  bg.stopHumanWatch();
  signals.length = 0;
  chrome.tabs.sendMessage = async () => ({ ok:true, data:{ present:false } });
  let solved = 0;
  bg.watchHumanCheck(7, () => { solved++; }, { intervalMs: 15, maxMs: 600 });
  await new Promise(r => setTimeout(r, 90));
  bg.stopHumanWatch();
  eq("watchdog resumes the run once the challenge clears", solved, 1);
  ok("watchdog signals humanCheckSolved", signals.some(s => s.type === "humanCheckSolved"));
  await new Promise(r => setTimeout(r, 60));
  eq("watchdog does not fire a second time", solved, 1);

  /* challenge still present → keep waiting, never resume */
  bg.stopHumanWatch();
  signals.length = 0;
  chrome.tabs.sendMessage = async () => ({ ok:true, data:{ present:true } });
  let still = 0;
  bg.watchHumanCheck(7, () => { still++; }, { intervalMs: 15, maxMs: 500 });
  await new Promise(r => setTimeout(r, 110));
  bg.stopHumanWatch();
  eq("watchdog keeps waiting while the challenge is present", still, 0);
  ok("watchdog does not signal solved while present", !signals.some(s => s.type === "humanCheckSolved"));

  /* never completes → give up and say so, but still never resume */
  bg.stopHumanWatch();
  signals.length = 0;
  let late = 0;
  bg.watchHumanCheck(7, () => { late++; }, { intervalMs: 10, maxMs: 50 });
  await new Promise(r => setTimeout(r, 220));
  ok("watchdog signals a timeout when the user never finishes", signals.some(s => s.type === "humanCheckTimeout"), JSON.stringify(signals.map(s => s.type)));
  eq("watchdog never resumes on timeout", late, 0);

  /* the frame navigated away → keep watching rather than declaring success */
  bg.stopHumanWatch();
  signals.length = 0;
  chrome.tabs.sendMessage = async () => ({ ok:false, error:"Receiving end does not exist" });
  let gone = 0;
  bg.watchHumanCheck(7, () => { gone++; }, { intervalMs: 10, maxMs: 60 });
  await new Promise(r => setTimeout(r, 160));
  bg.stopHumanWatch();
  eq("watchdog keeps watching when the frame is unreachable", gone, 0);
  ok("an unreachable frame is not mistaken for a solved challenge", !signals.some(s => s.type === "humanCheckSolved"));

  bg.stopHumanWatch();
  bg.stopHumanWatch();
  ok("stopHumanWatch is safe to call repeatedly", true);
  bg.invalidateSnapshot();
  ok("invalidateSnapshot is callable", true);
}

/* ------------------------------------------- whole-run integration */
/* Until now the suite only exercised exported helpers, so a ReferenceError on
   the tool-execution path inside run() itself (an undefined `profile`) sailed
   through a fully green suite while the extension failed at the first tool call.
   Drive a real run end-to-end against a stubbed model. */
{
  bg.stopHumanWatch();
  signals.length = 0;
  Object.assign(store, {
    apiKey:"k", endpoint:"https://api.test/v1", model:"m", verifiedModels:["m"],
    maxSteps:6, streaming:true, requestTimeout:5000, retryCount:0,
    speed:"balanced", autoVerify:true, cacheSnapshot:true
  });

  const dispatched = [];
  chrome.tabs.sendMessage = async (_id, msg) => {
    dispatched.push(msg.type);
    if (msg.type === "snapshot")   return { ok:true, data:{ url:"https://page.test/", title:"Test", controls:[], text:"hello" } };
    if (msg.type === "page_state") return { ok:true, data:{ token:"t1", url:"https://page.test/", title:"Test", controls:3, textLength:100, busy:false } };
    if (msg.type === "human_check") return { ok:true, data:{ present:false } };
    return { ok:true, data:{ ok:true } };
  };

  const line = obj => `data: ${JSON.stringify(obj)}\n\n`;
  /* several calls in one turn: a read-only batch, then mutating calls that each
     act as a barrier, so the parallel path and the sequential path both run */
  const batch = (calls) => sse([
    ...calls.map((c, i) => line({ choices:[{ delta:{ tool_calls:[{ index:i, id:c.id, type:"function", function:{ name:c.name, arguments: JSON.stringify(c.args || {}) } }] } }] })),
    "data: [DONE]\n\n"
  ]);
  const answer = text => sse([ line({ choices:[{ delta:{ content:text } }] }), "data: [DONE]\n\n" ]);

  const queue = [
    batch([
      { id:"c1", name:"page_snapshot" }, { id:"c2", name:"query_elements", args:{ selector:"a" } },
      { id:"c3", name:"extract", args:{ format:"text" } }, { id:"c4", name:"screenshot" },
      { id:"c5", name:"click", args:{ selector:"#go" } }, { id:"c6", name:"type", args:{ selector:"#q", text:"hi" } },
      { id:"c7", name:"navigate", args:{ url:"https://page.test/next" } },
      { id:"c8", name:"open_tab", args:{ url:"https://page.test/new" } },
      { id:"c9", name:"submit_form", args:{ selector:"#f" } }, { id:"c10", name:"press_key", args:{ key:"Enter" } },
      { id:"c11", name:"scroll_to", args:{ y:400 } }, { id:"c12", name:"wait", args:{ ms:10 } }
    ]),
    answer("Done.")
  ];
  bg.__setFetchImpl(async () => queue.shift() || answer("extra"));

  let out = null, err = null;
  try { out = await bg.run("Click the button", "agent"); } catch (e) { err = e; }

  eq("a whole run completes without throwing", err && err.message, null);
  ok("a whole run returns the final answer", out === "Done.", `got ${JSON.stringify(out)}`);
  ok("a read-only tool reached the page", dispatched.includes("snapshot"), JSON.stringify(dispatched));
  ok("a mutating tool reached the page", dispatched.includes("click"), JSON.stringify(dispatched));
  for (const t of ["query_elements","extract","click","type","submit_form","key","scroll_to","wait"]) {
    ok(`tool ${t} executed during a run`, dispatched.includes(t), JSON.stringify(dispatched));
  }
  ok("the mutating actions were verified afterwards", dispatched.filter(t => t === "page_state").length >= 4, JSON.stringify(dispatched));

  bg.__setFetchImpl(null);
  bg.stopHumanWatch();
  chrome.tabs.sendMessage = async () => ({ ok:true, data:{ present:false } });
}

/* ---------------------------------------------------------- report */
console.log(`\nCORE: ${pass} passed, ${failures.length} failed`);
if (failures.length) for (const f of failures) console.log("  FAIL " + f);
globalThis.__wsResults = { stage:"CORE", pass, failed:failures.length };
process.exitCode = failures.length ? 1 : 0;
