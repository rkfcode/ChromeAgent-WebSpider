/* Syntax gate. Classic scripts are parsed with vm.Script; background.js is a
   real ES module and is parsed by importing it with a chrome stub installed.
   (Spawning node.exe from node.exe is unreliable on Windows — EBUSY — so this
   runs fully in-process.) */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const tmp = join(here, ".tmp");
mkdirSync(tmp, { recursive: true });

let failures = 0;

for (const file of ["content.js", "main.js", "sidepanel.js"]) {
  const src = readFileSync(join(root, file), "utf8");
  try {
    new vm.Script(src, { filename: file });
    console.log(`  ok   ${file}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${file} — ${e.message}`);
  }
}

/* background.js — parse by importing (no side effects beyond chrome listeners) */
let bg = null;
try {
  globalThis.chrome = {
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    runtime: { onInstalled:{addListener(){}}, onStartup:{addListener(){}}, onMessage:{addListener(){}}, sendMessage: async () => ({}), getManifest: () => ({ version:"0" }) },
    commands: { onCommand:{addListener(){}} }
  };
  const mjs = join(tmp, "syntax-background.mjs");
  writeFileSync(mjs, readFileSync(join(root, "background.js"), "utf8"));
  bg = await import(pathToFileURL(mjs).href + "?t=" + Date.now());
  if (typeof bg.trimMessages !== "function") throw new Error("expected exports are missing");
  console.log("  ok   background.js (ES module, exports verified)");
} catch (e) {
  failures++;
  console.log(`  FAIL background.js — ${e.message}`);
}

/* ── static reference checks ──────────────────────────────────────────
   Four whole classes of silent failure in this codebase:
     · an <use href="#i-x"> whose symbol does not exist renders nothing
     · a data-i18n key missing from the dictionary renders the raw key
     · a $("#id") that matches no element returns null and fails later
     · a tool the worker dispatches with no handler in the content script
       resolves to {ok:false,"Unknown action"} and the agent stalls
   ------------------------------------------------------------------- */
const html = readFileSync(join(root, "sidepanel.html"), "utf8");
const panel = readFileSync(join(root, "sidepanel.js"), "utf8");
const content = readFileSync(join(root, "content.js"), "utf8");
const worker = readFileSync(join(root, "background.js"), "utf8");
const all = html + "\n" + panel;

const definedIcons = new Set([...html.matchAll(/<symbol id="(i-[a-z0-9-]+)"/g)].map(m => m[1]));
/* icons are referenced both as <use href="#i-x"> in markup and as "#i-x"
   strings in script (the theme button swaps its icon at runtime) */
const usedIcons = new Set([...all.matchAll(/"#(i-[a-z0-9-]+)"/g)].map(m => m[1]));
const missingIcons = [...usedIcons].filter(i => !definedIcons.has(i));
if (missingIcons.length) {
  failures++;
  console.log(`  FAIL icon references without a symbol — ${missingIcons.join(", ")}`);
} else {
  console.log(`  ok   icons (${usedIcons.size} referenced, ${definedIcons.size} defined)`);
}
const unusedIcons = [...definedIcons].filter(i => !usedIcons.has(i));
if (unusedIcons.length) console.log(`  warn unused symbols: ${unusedIcons.join(", ")}`);

/* i18n dictionaries */
const enStart = panel.indexOf("en:{");
const faStart = panel.indexOf("fa:{");
const dictEnd = panel.indexOf("\n}};", faStart);
const keysOf = block => {
  const bare = block.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  return new Set([...bare.matchAll(/(?:^|[\s,{])([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map(m => m[1]));
};
const enKeys = keysOf(panel.slice(enStart + 4, faStart));
const faKeys = keysOf(panel.slice(faStart + 4, dictEnd));

const usedKeys = new Set([...html.matchAll(/data-i18n(?:-ph|-title)?="([^"]+)"/g)].map(m => m[1]));
for (const m of panel.matchAll(/tr\("([A-Za-z0-9_]+)"\)/g)) usedKeys.add(m[1]);
for (const m of panel.matchAll(/tr\((\w+) === "agent" \? "(\w+)" : \w+ === "plan" \? "(\w+)" : "(\w+)"\)/g)) {
  usedKeys.add(m[2]); usedKeys.add(m[3]); usedKeys.add(m[4]);
}

const missingKeys = [...usedKeys].filter(k => !enKeys.has(k));
if (missingKeys.length) {
  failures++;
  console.log(`  FAIL i18n keys used but not defined — ${missingKeys.join(", ")}`);
} else {
  console.log(`  ok   i18n (${usedKeys.size} keys used, ${enKeys.size} en / ${faKeys.size} fa defined)`);
}
const notTranslated = [...enKeys].filter(k => !faKeys.has(k));
const orphanFa = [...faKeys].filter(k => !enKeys.has(k));
if (notTranslated.length || orphanFa.length) {
  failures++;
  console.log(`  FAIL dictionary drift — missing in fa: [${notTranslated.join(", ")}] | missing in en: [${orphanFa.join(", ")}]`);
} else {
  console.log("  ok   en/fa dictionaries are in sync");
}

/* DOM ids referenced from the panel script */
const htmlIds = new Set([...html.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map(m => m[1]));
const jsIds = new Set([...panel.matchAll(/"#([A-Za-z0-9_-]+)/g)].map(m => m[1]));
const missingIds = [...jsIds].filter(id => !htmlIds.has(id) && !definedIcons.has(id));
if (missingIds.length) {
  failures++;
  console.log(`  FAIL selectors with no matching element — ${missingIds.join(", ")}`);
} else {
  console.log(`  ok   DOM references (${jsIds.size} selectors, ${htmlIds.size} ids)`);
}

/* worker → content-script tool wiring.
   Every type the worker sends must exist in the content script's HANDLERS map,
   otherwise the call returns "Unknown action" and the agent silently stalls. */
const handlerBlock = content.slice(content.indexOf("const HANDLERS = Object.assign("), content.indexOf("chrome.runtime.onMessage.addListener"));
/* entries look like `  snapshot,` or `  page_state: pageState,` — and the last
   one has no trailing comma, so the terminator is a comma or end of line */
const handlers = new Set([...handlerBlock.matchAll(/^ {2}([a-z_][a-z0-9_]*)\s*(?::[^,\n]*)?(?:,|$)/gm)].map(m => m[1]));
const dispatched = new Set([...worker.matchAll(/(?:sendTab|tabAction)\(\s*[^,]+,\s*"([a-z_]+)"/g)].map(m => m[1]));
const unhandled = [...dispatched].filter(t => !handlers.has(t));
if (unhandled.length) {
  failures++;
  console.log(`  FAIL dispatched without a content handler — ${unhandled.join(", ")}`);
} else {
  console.log(`  ok   tool wiring (${dispatched.size} dispatched, ${handlers.size} handlers)`);
}
const unreachable = [...handlers].filter(h => !dispatched.has(h));
if (unreachable.length) console.log(`  warn handlers never dispatched: ${unreachable.join(", ")}`);

/* every declared tool must be dispatched by act() */
if (bg) {
  const declared = new Set(bg.TOOLS.map(t => t.function.name));
  const actBlock = worker.slice(worker.indexOf("async function act("), worker.indexOf("/* ------------------------------------------------------------- run */"));
  const wired = new Set([...actBlock.matchAll(/name === "([a-z_]+)"/g)].map(m => m[1]));
  const orphans = [...declared].filter(t => !wired.has(t) && t !== "screenshot");
  if (orphans.length) {
    failures++;
    console.log(`  FAIL declared tools with no act() branch — ${orphans.join(", ")}`);
  } else {
    console.log(`  ok   tool schemas (${declared.size} declared, ${wired.size} act() branches)`);
  }
}

/* the Tools tab must document exactly the tools that actually exist —
   a catalogue that drifts from the real surface is worse than no catalogue */
const catStart = panel.indexOf("const TOOLS_INFO = [");
const catEnd = panel.indexOf("\n];", catStart);
if (bg && catStart >= 0 && catEnd > catStart) {
  const catalogue = new Set([...panel.slice(catStart, catEnd).matchAll(/\["([a-z_]+)"/g)].map(m => m[1]));
  const declaredTools = new Set(bg.TOOLS.map(t => t.function.name));
  const missingFromCatalogue = [...declaredTools].filter(t => !catalogue.has(t));
  const phantom = [...catalogue].filter(t => !declaredTools.has(t));
  if (missingFromCatalogue.length || phantom.length) {
    failures++;
    console.log(`  FAIL tool catalogue drift — missing from the Tools tab: [${missingFromCatalogue.join(", ")}] | listed but not a tool: [${phantom.join(", ")}]`);
  } else {
    console.log(`  ok   tool catalogue (${catalogue.size} tools documented in the panel)`);
  }
} else {
  failures++;
  console.log("  FAIL tool catalogue — TOOLS_INFO was not found in sidepanel.js");
}

try {
  const m = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  const need = ["manifest_version", "name", "version", "background", "side_panel", "content_scripts", "icons", "permissions"];
  const missing = need.filter(k => !(k in m));
  if (missing.length) throw new Error("missing keys: " + missing.join(", "));
  if (m.manifest_version !== 3) throw new Error("manifest_version must be 3");
  if (m.background.type !== "module") throw new Error("background.type must be module for ESM");
  for (const size of ["16", "32", "48", "128"]) if (!m.icons[size]) throw new Error(`icons.${size} missing`);
  if (m.side_panel.default_path !== "sidepanel.html") throw new Error("side_panel.default_path mismatch");

  const scripts = m.content_scripts.flatMap(c => c.js || []);
  if (!scripts.includes("content.js")) throw new Error("content.js not registered");
  const main = m.content_scripts.find(c => (c.js || []).includes("main.js"));
  if (!main) throw new Error("main.js not registered");
  if (main.world !== "MAIN") throw new Error("main.js must declare world: MAIN");
  if (main.run_at !== "document_start") throw new Error("main.js must run at document_start");
  if (!main.all_frames) throw new Error("main.js must run in all frames");

  const declared = new Set(m.permissions);
  const used = new Set(["storage", "tabs", "scripting", "activeTab", "sidePanel", "notifications"]);
  const unused = [...declared].filter(p => !used.has(p));
  if (unused.length) console.log(`  warn unused permissions: ${unused.join(", ")}`);
  console.log(`  ok   manifest.json (v${m.version}, MV${m.manifest_version})`);
} catch (e) {
  failures++;
  console.log("  FAIL manifest.json — " + e.message);
}

console.log(failures ? `\nSYNTAX: ${failures} failure(s)` : "\nSYNTAX: all files parse");
globalThis.__wsResults = { stage:"STATIC", summary: failures ? `${failures} failure(s)` : "parse + icons + i18n + DOM refs + tool wiring + manifest" };
process.exitCode = failures ? 1 : 0;
