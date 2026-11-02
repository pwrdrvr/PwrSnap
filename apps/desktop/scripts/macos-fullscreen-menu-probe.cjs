// Does macOS add its own full-screen item to PwrSnap's View menu?
//
// PwrSuite menu standard, decision E: drop the stock `togglefullscreen`
// role from View on macOS ONLY if AppKit already inserts its own
// "Enter Full Screen" there, so the menu would list it twice. Electron's
// menu model cannot answer that — AppKit's item never appears in
// `Menu.getApplicationMenu()` — so this probe reads the real NSMenu
// through Accessibility, for a View menu built with and without the
// stock role, before and while the menu is open.
//
// Measured 2026-10-06, Electron 41.10.7, macOS 15.7.7 (PwrSuiteLab VM):
//
//   with the stock role     Reload Window, -, Actual Size, Zoom In,
//                           Zoom Out, -, Toggle Full Screen
//   without it              Reload Window, -, Actual Size, Zoom In,
//                           Zoom Out, Enter Full Screen   (AppKit's)
//
// One item either way: AppKit adds its own only when the menu has none, so
// the stock role is NOT duplicated and stays (application-menu.ts).
//
// It opens a window and drives the menu bar, so run it in the
// PwrSuiteLab macOS VM, never on the operator's desktop (AGENTS.md
// §Workflow). The parent process needs Accessibility (System Events).
// Plain Electron, no build:
//
//   electron apps/desktop/scripts/macos-fullscreen-menu-probe.cjs [outDir]
//
// Writes <outDir>/result.json. No screenshot: `screencapture` from a lab
// job raises a screen-recording consent prompt for the job's shell, and
// the menu is a separate window it would not show anyway.

const { app, BrowserWindow, Menu } = require("electron");
const { execFile } = require("node:child_process");
const { mkdirSync, writeFileSync } = require("node:fs");
const { release } = require("node:os");
const { resolve } = require("node:path");

const outDir = resolve(process.argv[2] ?? "fullscreen-menu-probe");

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

function run(command, args) {
  return new Promise((done) => {
    execFile(command, args, { timeout: 15_000 }, (error, stdout, stderr) => {
      done({
        ok: error === null,
        stdout: String(stdout).trim(),
        stderr: String(stderr).trim(),
        ...(error !== null ? { error: error.message } : {})
      });
    });
  });
}

function systemEvents(body) {
  const script =
    `tell application "System Events" to tell (first process whose unix id is ${process.pid})\n` +
    `${body}\nend tell`;
  return run("osascript", ["-e", script]);
}

const readViewItems = () =>
  systemEvents('get name of every menu item of menu 1 of menu bar item "View" of menu bar 1');

/** The View menu PwrSnap ships, with or without the stock full-screen role. */
function viewMenu(withStockFullScreen) {
  return [
    { role: "reload", label: "Reload Window" },
    { type: "separator" },
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    ...(withStockFullScreen ? [{ type: "separator" }, { role: "togglefullscreen" }] : [])
  ];
}

async function probeVariant(name, withStockFullScreen) {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { label: "View", submenu: viewMenu(withStockFullScreen) },
      { role: "windowMenu" }
    ])
  );
  await delay(1_000);
  const beforeOpen = await readViewItems();
  // AppKit may only insert its item as the menu is about to show, so read
  // the items again with the menu open.
  const open = await systemEvents('click menu bar item "View" of menu bar 1');
  await delay(1_000);
  const whileOpen = await readViewItems();
  await systemEvents("key code 53");
  await delay(500);
  return { name, withStockFullScreen, beforeOpen, open, whileOpen };
}

app.whenReady().then(async () => {
  mkdirSync(outDir, { recursive: true });
  const window = new BrowserWindow({
    width: 640,
    height: 400,
    fullscreenable: true,
    resizable: true,
    title: "Full-screen menu probe"
  });
  await window.loadURL("data:text/html,<h1>Full-screen menu probe</h1>");
  app.focus({ steal: true });
  window.focus();
  await delay(1_500);

  const result = {
    electron: process.versions.electron,
    darwinRelease: release(),
    variants: [
      await probeVariant("with-stock-togglefullscreen", true),
      await probeVariant("without-stock-togglefullscreen", false)
    ]
  };
  writeFileSync(resolve(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  app.exit(0);
});
