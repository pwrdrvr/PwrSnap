// Linux capture diagnostic probe.
//
// Answers, in one run, every question the region-selector design has an
// unverifiable assumption about on Linux — and which no test on this repo's
// CI can answer, because the Docker/xvfb E2E harness has neither an
// xdg-desktop-portal nor a window manager:
//
//   1. Is this an X11 or a Wayland session, and which ozone backend did
//      Electron actually pick? (A Wayland session commonly runs Electron as
//      an XWayland *X11* client, which behaves differently again.)
//   2. Does `desktopCapturer.getSources({types:["screen"]})` return one
//      source per display with a usable `display_id` (what
//      `captureDisplayNativeImage` matches on), or a single opaque
//      portal/PipeWire source with `display_id: ""`?
//   3. Do the returned pixels have the dimensions the selector assumes —
//      `display.bounds * display.scaleFactor`? The renderer paints the grab
//      with `object-fit: fill`, so a mismatch is STRETCHED rather than
//      reported, and the crop then maps the user's rect through
//      `display.scaleFactor` onto pixels that are not at that scale.
//   4. Does a selector-shaped window (frameless, transparent, always-on-top,
//      constructed at `display.bounds`) actually land where it was asked to?
//      A Wayland-native client cannot place its own toplevel at all, but an
//      XWayland one usually can — and under fractional scaling can land at
//      the wrong size. Measured, not assumed: on GNOME/XWayland it has been
//      seen honoured exactly.
//   5. Does `screen.getCursorScreenPoint()` report the real pointer? It is
//      how `pickRegion` chooses which display to show the selector on, and
//      Wayland has no protocol to query the global pointer.
//   6. And the one that infers nothing: paint the grab into the overlay
//      exactly as the selector does, at partial opacity, so the frozen copy
//      can be compared against the live desktop underneath it. Aligned looks
//      faded but single; misaligned doubles every edge, and a 100px ruler
//      says by how much and in which direction.
//
// Run it on the affected machine:
//
//   node_modules/.bin/electron apps/desktop/scripts/linux-capture-probe.mjs
//
// or, from the repo root:
//
//   pnpm --filter @pwrsnap/desktop probe:linux-capture
//
// Two steps put something on screen and expect you to LOOK at it.
//
// Step 3 shows an EMPTY full-display overlay with edge, corner and centre
// markers: do those sit on the real edges and centre of the monitor, or are
// they pushed off them? Step 5 paints the grabbed frame into that same
// overlay at 55% opacity: does the screen merely look faded (aligned), or
// does every edge double (misaligned)? If it doubles, read the offset off
// the ruler — that number is the bug.
//
// Step 4 raises the OS screen-share prompt and source picker on a portal
// session; pick "Entire screen" / the monitor you are looking at, which is
// what a user would pick. Nothing is captured to the library and no PwrSnap
// state is touched: the probe runs with its own throwaway userData.
//
// Flags:
//   --no-overlay        skip both on-screen steps (3 and 5)
//   --no-capture        skip the screen grab (step 4) — no portal prompt
//   --overlay-ms=<n>    how long to leave the overlay up (default 4000)
//   --grabs=<n>         repeat the grab n times (default 1) to see whether
//                       the portal re-prompts per call
//   --out=<dir>         where to write grabbed PNGs (default: a temp dir)

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, desktopCapturer, screen } from "electron";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const DO_OVERLAY = !flag("no-overlay");
const DO_CAPTURE = !flag("no-capture");
const OVERLAY_MS = Number(value("overlay-ms", "4000"));
const GRABS = Math.max(1, Number(value("grabs", "1")));

const lines = [];
function say(text = "") {
  lines.push(text);
  // eslint-disable-next-line no-console
  console.log(text);
}
function head(text) {
  say("");
  say(`── ${text} ${"─".repeat(Math.max(0, 66 - text.length))}`);
}
const num = (n) => (typeof n === "number" && Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : String(n));
const rect = (b) => (b === undefined || b === null ? "—" : `${num(b.x)},${num(b.y)} ${num(b.width)}×${num(b.height)}`);

// Keep the probe entirely out of the real app's profile.
app.setPath("userData", join(tmpdir(), `pwrsnap-capture-probe-${process.pid}`));
app.setName("PwrSnapCaptureProbe");

async function reportEnvironment() {
  head("1. Session + ozone backend");
  const env = [
    "XDG_SESSION_TYPE",
    "WAYLAND_DISPLAY",
    "DISPLAY",
    "XDG_CURRENT_DESKTOP",
    "XDG_SESSION_DESKTOP",
    "GDMSESSION",
    "DESKTOP_SESSION",
    "GDK_BACKEND",
    "QT_QPA_PLATFORM",
    "ELECTRON_OZONE_PLATFORM_HINT"
  ];
  for (const key of env) {
    say(`  ${key.padEnd(28)} ${process.env[key] ?? "(unset)"}`);
  }
  say(`  ${"process.platform".padEnd(28)} ${process.platform}`);
  say(`  ${"electron".padEnd(28)} ${process.versions.electron}`);
  say(`  ${"chrome".padEnd(28)} ${process.versions.chrome}`);
  const ozoneArg = process.argv.find((a) => a.startsWith("--ozone-platform"));
  say(`  ${"--ozone-platform*".padEnd(28)} ${ozoneArg ?? "(not passed)"}`);

  const sessionType = (process.env.XDG_SESSION_TYPE ?? "").toLowerCase();
  const waylandSession = sessionType === "wayland" || (process.env.WAYLAND_DISPLAY ?? "") !== "";
  say("");
  say(`  VERDICT: session is ${waylandSession ? "WAYLAND" : sessionType === "x11" ? "X11" : `UNKNOWN (${sessionType || "no XDG_SESSION_TYPE"})`}`);
  if (waylandSession && (process.env.DISPLAY ?? "") !== "") {
    say("  NOTE:    DISPLAY is also set — Electron may be running as an XWayland");
    say("           (X11) client inside a Wayland session. Window positioning can");
    say("           then work while the screen grab still goes through the portal.");
  }
  return { waylandSession, sessionType };
}

function reportDisplays() {
  head("2. Displays + cursor");
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  for (const d of displays) {
    say(`  display ${d.id}${d.id === primary.id ? " (primary)" : ""}`);
    say(`    bounds        ${rect(d.bounds)}`);
    say(`    workArea      ${rect(d.workArea)}`);
    say(`    scaleFactor   ${num(d.scaleFactor)}`);
    say(`    rotation      ${num(d.rotation)}`);
    say(`    expected grab ${Math.round(d.bounds.width * d.scaleFactor)}×${Math.round(d.bounds.height * d.scaleFactor)} px`);
  }
  let cursor = null;
  try {
    cursor = screen.getCursorScreenPoint();
    say(`  getCursorScreenPoint()  ${num(cursor.x)},${num(cursor.y)}`);
    const nearest = screen.getDisplayNearestPoint(cursor);
    say(`  getDisplayNearestPoint  display ${nearest.id}`);
    if (cursor.x === 0 && cursor.y === 0) {
      say("  WARNING: cursor reads (0,0). If the pointer is not actually in the");
      say("           top-left corner, the global pointer position is unavailable —");
      say("           pickRegion() would route the selector to the wrong display.");
    }
  } catch (cause) {
    say(`  getCursorScreenPoint()  THREW: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return { displays, primary, cursor };
}

async function reportOverlayGeometry(display, strategy) {
  const label = {
    bare: "as createSelectorWindow() + show() leaves it on Linux today",
    fullscreen: "with setFullScreen(true) — what Windows already does",
    reanchor: "with setBounds(display.bounds) re-asserted after show()"
  }[strategy];
  say("");
  say(`  ── ${strategy.toUpperCase()}: ${label}`);
  say(`     On screen for ${OVERLAY_MS}ms — LOOK AT IT: the markers should sit on`);
  say(`     the real edges and centre of the monitor.`);

  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  win.setAlwaysOnTop(true, "screen-saver");

  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;overflow:hidden;background:rgba(255,138,31,.12);
      font:600 13px/1.4 system-ui,sans-serif;color:#fff;-webkit-user-select:none}
    .edge{position:fixed;background:#ff8a1f}
    .t,.b{left:0;right:0;height:4px}.t{top:0}.b{bottom:0}
    .l,.r{top:0;bottom:0;width:4px}.l{left:0}.r{right:0}
    .c{position:fixed;width:80px;height:80px;border:4px solid #ff8a1f}
    .tl{top:0;left:0;border-right:0;border-bottom:0}
    .tr{top:0;right:0;border-left:0;border-bottom:0}
    .bl{bottom:0;left:0;border-right:0;border-top:0}
    .br{bottom:0;right:0;border-left:0;border-top:0}
    .x,.y{position:fixed;background:#ff8a1f}
    .x{left:0;right:0;top:50%;height:2px}.y{top:0;bottom:0;left:50%;width:2px}
    #info{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
      background:#000;padding:14px 18px;border:2px solid #ff8a1f;white-space:pre;text-align:center}
  </style>
  <div class="edge t"></div><div class="edge b"></div><div class="edge l"></div><div class="edge r"></div>
  <div class="c tl"></div><div class="c tr"></div><div class="c bl"></div><div class="c br"></div>
  <div class="x"></div><div class="y"></div>
  <div id="info">PwrSnap overlay geometry probe
The orange border should hug the monitor edges
and the cross should meet at its centre.</div>`;

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  win.show();
  if (strategy === "fullscreen") win.setFullScreen(true);
  if (strategy === "reanchor") {
    // A window manager that ignores the constructor position may still honour
    // an explicit move once the window is mapped. Give it a beat to place the
    // window first, otherwise this races the placement it is meant to undo.
    await new Promise((r) => setTimeout(r, 200));
    win.setBounds(display.bounds);
  }
  await new Promise((r) => setTimeout(r, 600));

  const actualBounds = win.getBounds();
  const actualContent = win.getContentBounds();
  let rendererView = null;
  try {
    rendererView = await win.webContents.executeJavaScript(
      `({innerWidth:window.innerWidth,innerHeight:window.innerHeight,` +
        `outerWidth:window.outerWidth,outerHeight:window.outerHeight,` +
        `devicePixelRatio:window.devicePixelRatio,` +
        `screenW:window.screen.width,screenH:window.screen.height,` +
        `availW:window.screen.availWidth,availH:window.screen.availHeight,` +
        // The renderer's own idea of where it is on screen. Chromium derives
        // this from the window's real position rather than from what main
        // asked for, so when it disagrees with getBounds() the window manager
        // has moved us and getBounds() is reporting the request, not reality.
        `screenX:window.screenX,screenY:window.screenY})`
    );
  } catch (cause) {
    say(`  executeJavaScript THREW: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  await new Promise((r) => setTimeout(r, Math.max(0, OVERLAY_MS - 300)));
  win.hide();
  win.destroy();

  say("");
  say(`     requested bounds      ${rect(display.bounds)}`);
  say(`     getBounds()           ${rect(actualBounds)}`);
  say(`     getContentBounds()    ${rect(actualContent)}`);
  if (rendererView !== null) {
    say(`     renderer screenX/Y    ${num(rendererView.screenX)},${num(rendererView.screenY)}`);
  }
  if (rendererView !== null) {
    say(`     renderer inner        ${num(rendererView.innerWidth)}×${num(rendererView.innerHeight)} CSS px`);
    say(`     renderer outer        ${num(rendererView.outerWidth)}×${num(rendererView.outerHeight)} CSS px`);
    say(`     devicePixelRatio      ${num(rendererView.devicePixelRatio)}`);
    say(`     window.screen         ${num(rendererView.screenW)}×${num(rendererView.screenH)} (avail ${num(rendererView.availW)}×${num(rendererView.availH)})`);
  }

  // NOTE for a macOS control run: the real selector follows construction with
  // `setSimpleFullScreen(true)` (`enterMenuBarOverlayMode`) and this probe
  // deliberately does not, so macOS reports the window parked below the menu
  // bar and "position honoured = NO". That is the probe being honest about a
  // bare window, not a product bug — and it is a useful demonstration of the
  // failure mode, since a window asked for 0,0 that lands at 0,29 paints the
  // snapshot 29px down and doubles every edge by 29px. On Linux nothing calls
  // setSimpleFullScreen, so there the verdict means what it says.
  // `getBounds()` is what Chromium ASKED the window manager for. The renderer's
  // `window.screenX/Y` is derived from where the window actually is. When the
  // two disagree, the WM has placed us somewhere else and main cannot tell
  // from the main side alone — which is exactly how a misaligned selector
  // ships without anything logging a complaint.
  const trueX = rendererView === null ? actualBounds.x : rendererView.screenX;
  const trueY = rendererView === null ? actualBounds.y : rendererView.screenY;
  const offsetX = trueX - display.bounds.x;
  const offsetY = trueY - display.bounds.y;
  const positioned = offsetX === 0 && offsetY === 0;
  const sized =
    actualBounds.width === display.bounds.width && actualBounds.height === display.bounds.height;
  say("");
  say(`     VERDICT: really at ${num(trueX)},${num(trueY)} — offset ${num(offsetX)},${num(offsetY)} from the display origin`);
  say(`              position honoured = ${positioned ? "YES" : "NO"}, size honoured = ${sized ? "YES" : "NO"}`);
  if (!positioned && actualBounds.x === display.bounds.x && actualBounds.y === display.bounds.y) {
    say("              ^ getBounds() REPORTS 0,0 AND IS WRONG. Nothing on the main");
    say("                side can see this; only the renderer knows where it is.");
  }
  if (rendererView !== null) {
    const cssScale = rendererView.innerWidth / display.bounds.width;
    say(`              renderer CSS px per display logical px = ${num(cssScale)}`);
    if (Math.abs(cssScale - 1) > 0.01) {
      say("              ^ the selector's coord space is NOT 1:1 with display logical px.");
      say("                region-selector.ts's header states the design depends on that.");
    }
  }
  if (!positioned || !sized) {
    say(`              ^ a frozen snapshot painted into this window appears shifted`);
    say(`                by ${num(offsetX)},${num(offsetY)} — every edge doubles by that much.`);
  }
  return { actualBounds, actualContent, rendererView, positioned, sized, offsetX, offsetY };
}

async function reportCapture(displays, outDir) {
  head("4. desktopCapturer screen sources");
  let grabbed = null;
  const target = displays[0];
  const requested = {
    width: Math.max(1, Math.round(target.bounds.width * target.scaleFactor)),
    height: Math.max(1, Math.round(target.bounds.height * target.scaleFactor))
  };
  say(`  Calling getSources({types:["screen"], thumbnailSize: ${requested.width}×${requested.height}})`);
  say("  — the exact call captureDisplayNativeImage() makes for display");
  say(`    ${target.id}. On a portal session this raises the share prompt + picker.`);

  for (let attempt = 1; attempt <= GRABS; attempt += 1) {
    const startedAt = Date.now();
    let sources;
    try {
      sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: requested });
    } catch (cause) {
      say(`  grab ${attempt}: THREW after ${Date.now() - startedAt}ms: ${cause instanceof Error ? cause.message : String(cause)}`);
      continue;
    }
    say("");
    say(`  grab ${attempt}: ${sources.length} source(s) in ${Date.now() - startedAt}ms`);
    for (const [i, s] of sources.entries()) {
      const size = s.thumbnail.isEmpty() ? null : s.thumbnail.getSize();
      say(`    [${i}] id=${s.id}`);
      say(`        name        ${JSON.stringify(s.name)}`);
      say(`        display_id  ${JSON.stringify(s.display_id)}`);
      say(`        thumbnail   ${size === null ? "EMPTY" : `${size.width}×${size.height}`}`);
      if (size !== null) {
        const aspect = size.width / size.height;
        const expectAspect = target.bounds.width / target.bounds.height;
        const drift = Math.abs(aspect - expectAspect) / expectAspect;
        say(`        aspect      ${num(aspect)} vs display ${num(expectAspect)} (${num(drift * 100)}% off)`);
        if (drift > 0.01) {
          say("        ^ ASPECT MISMATCH. The selector paints this with object-fit:fill,");
          say("          so it is STRETCHED to the window — content shifts away from");
          say("          where it really is, by a different amount on each axis.");
        }
        if (size.width !== requested.width || size.height !== requested.height) {
          say(`        ^ size != requested ${requested.width}×${requested.height}; the snapshot crop maps the`);
          say(`          user's rect through display.scaleFactor (${num(target.scaleFactor)}), which`);
          say("          assumes exactly the requested size.");
        }
        if (outDir !== null) {
          const file = join(outDir, `grab${attempt}-source${i}.png`);
          try {
            await writeFile(file, s.thumbnail.toPNG());
            say(`        written     ${file}`);
          } catch (cause) {
            say(`        write FAILED ${cause instanceof Error ? cause.message : String(cause)}`);
          }
        }
        if (grabbed === null) grabbed = { dataUrl: s.thumbnail.toDataURL(), size };
      }
    }

    const matched = sources.find((s) => s.display_id === String(target.id));
    const strategy =
      matched !== undefined
        ? "display_id (correct — the authoritative match)"
        : sources.length === 1
          ? "single_source (taken WITHOUT a warning — the log line the bug report"
          : "display_index / first_source (logs 'no source matched display_id')";
    say("");
    say(`    screencapture.ts would select via: ${strategy}`);
    if (matched === undefined && sources.length === 1) {
      say("      suggests grepping for is NEVER emitted on this configuration).");
      say("      Whatever the portal picker returned is treated as this display.");
    }
  }
  return grabbed;
}


// The step that reproduces the reported symptom instead of inferring it.
//
// The selector paints the frozen grab as a full-window background with
// `object-fit: fill` and the user drags against THAT, so "misaligned" means
// the painted copy of the desktop does not sit on top of the desktop it was
// copied from. At full opacity — which is what the real selector uses — a
// shift is only visible where something of PwrSnap's own is still on screen
// to compare against, which is why the bug reads as vague "duplication".
//
// Painting the same grab the same way but at partial opacity turns that into
// a measurement: where the copy lines up, the screen looks washed out but
// single; where it does not, every edge doubles, and the ruler says by how
// many pixels and in which direction.
async function reportSelectorSimulation(display, grabbed) {
  head("5. Selector simulation — the frozen grab painted over the live screen");
  if (grabbed === null) {
    say("  skipped (no grab to paint)");
    return;
  }
  say(`  Painting the ${grabbed.size.width}x${grabbed.size.height} grab into a`);
  say(`  ${display.bounds.width}x${display.bounds.height} overlay with object-fit:fill — exactly what`);
  say("  RegionSelector.tsx does — but at 55% opacity so the live desktop shows");
  say("  through it.");
  say("");
  say(`  WATCH FOR ${OVERLAY_MS}ms:`);
  say("    aligned  -> the screen looks faded but SINGLE. No doubled edges.");
  say("    offset   -> every window edge, the top bar and the dock appear TWICE.");
  say("                Read the shift off the 100px ruler and note its direction.");

  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  win.setAlwaysOnTop(true, "screen-saver");

  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;overflow:hidden;background:transparent;
      font:600 11px/1 ui-monospace,monospace;color:#ff8a1f;-webkit-user-select:none}
    #snap{position:fixed;inset:0;width:100%;height:100%;object-fit:fill;opacity:.55;z-index:0}
    #grid{position:fixed;inset:0;z-index:1;pointer-events:none}
    .v,.h{position:absolute;background:rgba(255,138,31,.55)}
    .v{top:0;bottom:0;width:1px}.h{left:0;right:0;height:1px}
    .v.major,.h.major{background:#ff8a1f}
    .lbl{position:absolute;background:#000;padding:1px 3px}
    #edge{position:fixed;inset:0;border:2px solid #ff8a1f;z-index:2;pointer-events:none}
    #info{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:3;
      background:#000;padding:12px 16px;border:2px solid #ff8a1f;white-space:pre;
      text-align:center;font:600 13px/1.5 system-ui,sans-serif;color:#fff}
  </style>
  <img id="snap" alt="">
  <div id="grid"></div><div id="edge"></div>
  <div id="info">Frozen grab at 55% over the live desktop.
Doubled edges = misaligned. Read the shift off the 100px ruler.</div>
  <script>
    const g = document.getElementById("grid");
    for (let x = 0; x < window.innerWidth; x += 100) {
      const l = document.createElement("div");
      l.className = "v" + (x % 500 === 0 ? " major" : "");
      l.style.left = x + "px"; g.appendChild(l);
      if (x % 200 === 0) {
        const t = document.createElement("div");
        t.className = "lbl"; t.style.left = (x + 2) + "px"; t.style.top = "2px";
        t.textContent = "x" + x; g.appendChild(t);
      }
    }
    for (let y = 0; y < window.innerHeight; y += 100) {
      const l = document.createElement("div");
      l.className = "h" + (y % 500 === 0 ? " major" : "");
      l.style.top = y + "px"; g.appendChild(l);
      if (y % 200 === 0) {
        const t = document.createElement("div");
        t.className = "lbl"; t.style.left = "2px"; t.style.top = (y + 2) + "px";
        t.textContent = "y" + y; g.appendChild(t);
      }
    }
  <\/script>`;

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  // The grab rides in through executeJavaScript rather than the page URL: a
  // full-screen PNG as a nested data: URL makes the outer URL enormous.
  await win.webContents.executeJavaScript(
    `new Promise((resolve) => { const i = document.getElementById("snap");
       i.onload = () => resolve(true); i.onerror = () => resolve(false);
       i.src = ${JSON.stringify(grabbed.dataUrl)}; })`
  );
  win.show();

  // Does the pointer ever become readable once one of our windows is up? The
  // earlier (0,0) reading is taken with nothing of ours on screen, and on
  // Wayland a client only learns the pointer position from events delivered
  // to its own surfaces — so this is the fairer test of whether pickRegion
  // could route by cursor at the moment it actually needs to.
  const samples = [];
  const started = Date.now();
  while (Date.now() - started < OVERLAY_MS) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const p = screen.getCursorScreenPoint();
      samples.push(`${p.x},${p.y}`);
    } catch {
      samples.push("threw");
    }
  }
  win.hide();
  win.destroy();

  const unique = [...new Set(samples)];
  say("");
  say(`  getCursorScreenPoint() while the overlay was up: ${unique.join("  ")}`);
  if (unique.length === 1 && unique[0] === "0,0") {
    say("  ^ never moved off 0,0. The global pointer is genuinely unavailable,");
    say("    so pickRegion() cannot route by cursor and the selector's opening");
    say("    crosshair lands in the top-left regardless of where the mouse is.");
  } else if (unique.length > 1) {
    say("  ^ it tracks. Move the mouse during this step to confirm it follows.");
  }
}

app.whenReady().then(async () => {
  say("PwrSnap Linux capture probe");
  say(`run at ${new Date().toISOString()}`);

  const { waylandSession } = await reportEnvironment();
  const { displays, primary, cursor } = reportDisplays();
  const target =
    cursor === null ? primary : screen.getDisplayNearestPoint(cursor);

  let overlay = null;
  if (DO_OVERLAY) {
    head("3. Selector-shaped overlay geometry");
    say(`  Two windows, both constructed exactly like createSelectorWindow() at`);
    say(`  display ${target.id} bounds ${rect(target.bounds)}. The only difference is`);
    say("  whether anything re-anchors them after show(). Linux currently does");
    say("  not: enterMenuBarOverlayMode() returns early for every platform that");
    say("  is neither win32 nor darwin, so the window manager places the");
    say("  selector wherever it likes.");
    const bare = await reportOverlayGeometry(target, "bare");
    const full = await reportOverlayGeometry(target, "fullscreen");
    const anchored = await reportOverlayGeometry(target, "reanchor");
    overlay = { bare, full, anchored };
    const offsets = (r) => `${num(r.offsetX)},${num(r.offsetY)}`;
    say("");
    say("  A/B/C offsets from the display origin");
    say(`    bare        ${offsets(bare)}${bare.positioned ? "   <- correct" : ""}`);
    say(`    fullscreen  ${offsets(full)}${full.positioned ? "   <- correct" : ""}`);
    say(`    reanchor    ${offsets(anchored)}${anchored.positioned ? "   <- correct" : ""}`);
    const winners = [
      full.positioned ? "setFullScreen(true)" : null,
      anchored.positioned ? "setBounds() after show()" : null
    ].filter((x) => x !== null);
    say("");
    if (bare.positioned) {
      say("  The bare window was already correct on this machine — the offset is");
      say("  not reproduced here, so look elsewhere before changing placement.");
    } else if (winners.length > 0) {
      say(`  FIX CONFIRMED: ${winners.join(" and ")} land${winners.length === 1 ? "s" : ""} the overlay on the`);
      say("  display origin. Linux makes neither call today; Windows already makes");
      say("  the first. That is the shipped bug.");
    } else {
      say("  Neither candidate lands the overlay correctly. The window manager is");
      say("  refusing both, and the selector needs to compensate for its own real");
      say("  position (renderer screenX/Y) rather than assume display.bounds.");
    }
  } else {
    head("3. Selector-shaped overlay geometry");
    say("  skipped (--no-overlay)");
  }

  let outDir = null;
  if (DO_CAPTURE) {
    const requestedOut = value("out", null);
    outDir = requestedOut ?? (await mkdtemp(join(tmpdir(), "pwrsnap-probe-")));
    const grabbed = await reportCapture(
      [target, ...displays.filter((d) => d.id !== target.id)],
      outDir
    );
    if (DO_OVERLAY) await reportSelectorSimulation(target, grabbed);
    else {
      head("5. Selector simulation");
      say("  skipped (--no-overlay)");
    }
  } else {
    head("4. desktopCapturer screen sources");
    say("  skipped (--no-capture)");
  }

  head("Summary");
  say(`  session            ${waylandSession ? "Wayland" : "X11 / unknown"}`);
  say(`  displays           ${displays.length}`);
  if (outDir !== null) say(`  grabbed PNGs in    ${outDir}`);
  say("");
  say("  Paste this whole report back. The grabbed PNG answers the last");
  say("  question on its own: open it and see whether it is the monitor you");
  say("  expected, at the size this report says the selector assumes.");

  const reportPath = join(
    value("out", null) ?? tmpdir(),
    `pwrsnap-capture-probe-${Date.now()}.txt`
  );
  try {
    await writeFile(reportPath, `${lines.join("\n")}\n`, "utf8");
    // eslint-disable-next-line no-console
    console.log(`\nreport written to ${reportPath}`);
  } catch {
    /* best effort */
  }
  app.exit(0);
});

app.on("window-all-closed", () => {
  /* the probe controls its own exit */
});
