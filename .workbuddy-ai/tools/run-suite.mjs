/* Runs the whole WebSpider verification suite in-process and prints one summary.
   Usage:  NODE_PATH=<workspace>/node_modules node run-suite.mjs
   (Spawning node.exe from node.exe is unreliable on Windows — EBUSY on the
   managed binary — so the stages are imported rather than spawned.) */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const stages = ["check-syntax.mjs", "test-core.mjs", "test-panel.mjs", "test-content.mjs"];

const results = [];
for (const stage of stages) {
  console.log(`\n──────── ${stage} ────────`);
  globalThis.__wsResults = null;
  process.exitCode = 0;
  let crashed = null;
  try {
    await import(pathToFileURL(join(here, stage)).href + "?t=" + Date.now());
  } catch (e) {
    crashed = e && e.message ? e.message : String(e);
  }
  const r = globalThis.__wsResults;
  results.push({
    stage,
    ok: !crashed && (process.exitCode || 0) === 0,
    summary: crashed ? "CRASH — " + crashed
      : r ? (r.summary || `${r.pass} passed, ${r.failed} failed`)
      : "(no summary)"
  });
}

const failed = results.filter(r => !r.ok);
console.log("\n════════ SUITE SUMMARY ════════");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.stage.padEnd(18)} ${r.summary}`);
console.log(failed.length ? `\n${failed.length} stage(s) failed` : "\nALL STAGES PASS");
process.exitCode = failed.length ? 1 : 0;
