// Electron quit re-entry probe.
//
//   pnpm --filter @pwrsnap/desktop probe:quit-reentry
//
// Measures, on the Electron this checkout ships, the one thing the unit model
// in src/main/__tests__/electron-quit-model.ts asserts and cannot itself
// prove: when a deferred quit is retried with app.quit(), does Electron
// still finish quitting? It exits non-zero if any case disagrees with the
// model, so re-run it on an Electron major bump.
//
// Why it can fail: Browser::Quit() writes `is_quitting_ = HandleBeforeQuit()`
// AFTER emitting before-quit, NotifyAndShutdown() writes
// `is_quitting_ = false` after a prevented will-quit, and an emit that
// starts from a native task runs a microtask checkpoint as it returns —
// inside those functions. A retry that settles in microtasks therefore runs
// nested and is overwritten. On 41.10.7 that is the ⌘Q stall: two
// before-quit passes, the Library closes, `window-all-closed` instead of
// `will-quit`, and the process lives on with no windows. See
// src/main/quit-retry.ts.
//
// Every child is a hidden window under the accessory activation policy:
// nothing is drawn, no Dock icon, no focus taken. "Native" quits are
// SIGTERM, which Electron turns into a posted Browser::Quit task — the same
// shape as ⌘Q's `terminate:`. POSIX only; Windows runs the JS cases.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const STALL_MS = 3_000;
const caseArg = process.argv.find((arg) => arg.startsWith("--case="));

void app.whenReady().then(() => {
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  if (caseArg === undefined) runMatrix();
  else void runCase(JSON.parse(caseArg.slice("--case=".length)));
});

function runMatrix() {
  // [stage deferred, how the retry is issued, how the quit starts, model says]
  const cases = [
    ["before-quit", "microtask", "native", "stall"],
    ["before-quit", "microtask", "js", "quit"],
    ["before-quit", "after-dispatch", "native", "quit"],
    ["before-quit", "after-dispatch", "js", "quit"],
    ["will-quit", "microtask", "native", "stall"],
    ["will-quit", "microtask", "js", "stall"],
    ["will-quit", "after-dispatch", "native", "quit"],
    ["will-quit", "after-dispatch", "js", "quit"]
  ].filter(([, , start]) => start === "js" || process.platform !== "win32");

  const script = fileURLToPath(import.meta.url);
  let mismatches = 0;
  console.log(`Electron ${process.versions.electron} on ${process.platform}`);
  for (const [stage, retry, start, expected] of cases) {
    const userData = mkdtempSync(join(tmpdir(), "pwrsnap-quit-probe-"));
    const run = spawnSync(
      process.execPath,
      [script, `--case=${JSON.stringify({ stage, retry, start, userData })}`],
      { encoding: "utf8", timeout: STALL_MS * 4 }
    );
    rmSync(userData, { recursive: true, force: true });
    const line = (run.stdout ?? "").split("\n").find((l) => l.startsWith("RESULT "));
    const result = line === undefined ? null : JSON.parse(line.slice("RESULT ".length));
    const observed = result === null ? "no result" : result.quit ? "quit" : "stall";
    const ok = observed === expected;
    if (!ok) mismatches += 1;
    console.log(
      `${ok ? "ok  " : "DIFF"} ${stage.padEnd(11)} retry=${retry.padEnd(14)} start=${start.padEnd(6)} ` +
        `model=${expected.padEnd(5)} electron=${observed}` +
        (result === null ? "" : `  [${result.events.join(", ")}]`)
    );
  }
  console.log(mismatches === 0 ? "model matches Electron" : `${mismatches} case(s) differ from the model`);
  app.exit(mismatches === 0 ? 0 : 1);
}

async function runCase({ stage, retry, start, userData }) {
  app.setPath("userData", userData);
  const events = [];
  const report = (quit) => {
    process.stdout.write(`RESULT ${JSON.stringify({ quit, events })}\n`);
  };
  // quit-retry.ts's retryQuitAfterDispatch, inlined: this file is plain JS.
  const reissue = () =>
    retry === "microtask"
      ? void Promise.resolve().then(() => app.quit())
      : void Promise.resolve().then(() => setImmediate(() => app.quit()));
  let deferred = false;
  const deferOnce = (event) => {
    if (deferred) return;
    deferred = true;
    event.preventDefault();
    reissue();
  };
  app.on("before-quit", (event) => {
    events.push("before-quit");
    if (stage === "before-quit") deferOnce(event);
  });
  app.on("will-quit", (event) => {
    events.push("will-quit");
    if (stage === "will-quit") deferOnce(event);
  });
  app.on("window-all-closed", () => events.push("window-all-closed"));
  app.on("quit", () => {
    events.push("quit");
    report(true);
  });
  const win = new BrowserWindow({ show: false });
  win.on("closed", () => events.push("closed"));
  await win.loadURL("data:text/html,");
  setTimeout(() => {
    report(false);
    app.exit(2);
  }, STALL_MS);
  if (start === "native") process.kill(process.pid, "SIGTERM");
  else setTimeout(() => app.quit(), 0);
}
