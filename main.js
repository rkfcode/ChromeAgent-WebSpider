/* ============================================================
   WebSpider MAIN-world bridge — v8
   Runs at document_start inside the page's own JS world, where the
   isolated content script cannot reach.

   The two worlds share the DOM, so they talk through it:
     #__webspider_console   JSON array of captured console entries
     #__webspider_dialogs   JSON array of captured native dialogs
     <html data-webspider-dialogs="record|accept|dismiss">   policy
     <html data-webspider-main="1">                          bridge alive

   Policy default is "record": every dialog is logged and then handed to
   the original browser implementation, so page behaviour is unchanged.
   "accept"/"dismiss" answer the dialog without showing it, which is what
   an automated run needs so a modal cannot hang the agent.
   ============================================================ */
(() => {
if (window.__webspiderMain) return;
window.__webspiderMain = true;

const MAX_LOG = 200;
const MAX_DIALOG = 50;

function slot(id) {
  let n = document.getElementById(id);
  if (!n) {
    n = document.createElement("script");
    n.type = "application/json";
    n.id = id;
    n.setAttribute("aria-hidden", "true");
    try { (document.documentElement || document.head || document.body).appendChild(n); } catch { return null; }
  }
  return n;
}
function read(id) {
  try { return JSON.parse(document.getElementById(id)?.textContent || "[]"); } catch { return []; }
}
function write(id, arr) {
  const n = slot(id);
  if (!n) return;
  try { n.textContent = JSON.stringify(arr); } catch {}
}

function clip(v, max = 300) {
  try {
    if (v === null) return "null";
    if (v === undefined) return "undefined";
    if (typeof v === "string") return v.length > max ? v.slice(0, max) + "…" : v;
    if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
    if (v instanceof Error) return `${v.name}: ${v.message}`.slice(0, max);
    if (typeof v === "function") return `[function ${v.name || "anonymous"}]`;
    if (v && v.nodeType === 1) return `<${String(v.tagName).toLowerCase()}${v.id ? "#" + v.id : ""}>`;
    const seen = new WeakSet();
    return JSON.stringify(v, (_k, val) => {
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) return "[circular]";
        seen.add(val);
      }
      if (typeof val === "function") return "[function]";
      if (typeof val === "string" && val.length > max) return val.slice(0, max) + "…";
      return val;
    }).slice(0, max);
  } catch { return "[unserialisable]"; }
}

/* ------------------------------------------------ console capture */
for (const level of ["log", "info", "warn", "error", "debug"]) {
  const original = console[level];
  if (typeof original !== "function") continue;
  console[level] = function (...args) {
    try {
      const arr = read("__webspider_console");
      arr.push({ level, text: args.map(a => clip(a)).join(" ").slice(0, 600), t: Date.now(), url: location.href });
      while (arr.length > MAX_LOG) arr.shift();
      write("__webspider_console", arr);
    } catch {}
    return original.apply(this, args);
  };
}

/* ------------------------------------------------- dialog capture */
function policy() {
  try { return document.documentElement.getAttribute("data-webspider-dialogs") || "record"; } catch { return "record"; }
}
function recordDialog(kind, message) {
  try {
    const arr = read("__webspider_dialogs");
    arr.push({ kind, message: String(message ?? "").slice(0, 400), t: Date.now(), policy: policy() });
    while (arr.length > MAX_DIALOG) arr.shift();
    write("__webspider_dialogs", arr);
  } catch {}
}

const nativeAlert = window.alert;
const nativeConfirm = window.confirm;
const nativePrompt = window.prompt;

window.alert = function (message) {
  recordDialog("alert", message);
  const p = policy();
  if (p === "accept" || p === "dismiss") return undefined;
  return nativeAlert.apply(window, arguments);
};

window.confirm = function (message) {
  recordDialog("confirm", message);
  const p = policy();
  if (p === "accept") return true;
  if (p === "dismiss") return false;
  return nativeConfirm.apply(window, arguments);
};

window.prompt = function (message, fallback) {
  recordDialog("prompt", message);
  const p = policy();
  if (p === "accept") return String(fallback ?? "");
  if (p === "dismiss") return null;
  return nativePrompt.apply(window, arguments);
};

try { document.documentElement.setAttribute("data-webspider-main", "1"); } catch {}
})();
