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
//   --no-fiducials      skip step 6 (which costs a SECOND portal prompt)
//   --out=<dir>         where to write grabbed PNGs (default: a temp dir)

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, desktopCapturer, nativeImage, screen } from "electron";

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
const DO_FIDUCIALS = !flag("no-fiducials");

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


// The measurement that needs no human eye: put a known pattern ON the screen,
// grab it, and find the pattern inside the grab.
//
// Every other step compares a number main reported against a number main also
// reported. This one closes the loop through the actual capture pipeline: the
// overlay paints four corner fiducials at coordinates we chose, the portal
// hands back a frame, and the frame says where those corners ended up. The
// difference IS the screen-to-grab transform — translation and scale, per
// axis, in pixels — with nothing inferred and nothing eyeballed.
//
// Fullscreen, because a bare overlay leaves gnome-shell's top bar and dock
// painted OVER it: those would land on top of the fiducials and corrupt the
// very corners being measured.
const FIDUCIAL = 120;
const FIDUCIALS = [
  { key: "top-left", rgb: [255, 0, 0], name: "red" },
  { key: "top-right", rgb: [0, 255, 0], name: "green" },
  { key: "bottom-left", rgb: [0, 0, 255], name: "blue" },
  { key: "bottom-right", rgb: [255, 255, 255], name: "white" }
];
const FIELD = [255, 0, 255]; // magenta everywhere else

/** Electron documents toBitmap() as platform-dependent. Probe it with one
 *  opaque red pixel, the same way `electronBitmapPixelFormat()` does in the
 *  app, rather than assuming a channel order and misreading every colour. */
function bitmapChannelOrder() {
  const px = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
  );
  const b = px.toBitmap({ scaleFactor: 1 });
  if (b.length < 4) return null;
  if (b[0] > 0xf0 && b[1] < 0x10 && b[2] < 0x10) return "rgba";
  if (b[2] > 0xf0 && b[0] < 0x10 && b[1] < 0x10) return "bgra";
  return null;
}

async function reportGrabAlignment(display) {
  head("6. Grab alignment — where the screen actually lands inside the frame");
  const order = bitmapChannelOrder();
  if (order === null) {
    say("  skipped: could not determine this Electron's bitmap channel order.");
    return;
  }
  say("  Painting four corner fiducials at known coordinates, then grabbing.");
  say("  THE PORTAL WILL PROMPT A SECOND TIME — pick the same source as before.");
  say("  The screen will be solid magenta with coloured corners for a moment.");

  const win = new BrowserWindow({
    x: display.bounds.x, y: display.bounds.y,
    width: display.bounds.width, height: display.bounds.height,
    show: false, frame: false, resizable: false, movable: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  win.setAlwaysOnTop(true, "screen-saver");
  const css = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
  const corner = (f) => {
    const pos = {
      "top-left": "top:0;left:0", "top-right": "top:0;right:0",
      "bottom-left": "bottom:0;left:0", "bottom-right": "bottom:0;right:0"
    }[f.key];
    return `<div style="position:fixed;${pos};width:${FIDUCIAL}px;height:${FIDUCIAL}px;background:${css(f.rgb)}"></div>`;
  };
  await win.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;overflow:hidden;background:${css(FIELD)}}</style>` +
        FIDUCIALS.map(corner).join("")
    )}`
  );
  win.show();
  // Cover gnome-shell's top bar and dock, which otherwise paint OVER a plain
  // always-on-top window and land on the very corners being measured. macOS
  // uses the same call the real selector does.
  if (process.platform === "darwin") win.setSimpleFullScreen(true);
  else win.setFullScreen(true);
  // Wait for the compositor to have actually shown this, not just for the
  // main-side call to return: a grab taken during the fullscreen transition
  // photographs the screen as it was and finds no fiducial at all.
  await win.webContents.executeJavaScript(
    "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))"
  );
  await new Promise((r) => setTimeout(r, 1500));

  let image = null;
  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        width: Math.round(display.bounds.width * display.scaleFactor),
        height: Math.round(display.bounds.height * display.scaleFactor)
      }
    });
    const pick = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    if (pick !== undefined && !pick.thumbnail.isEmpty()) image = pick.thumbnail;
  } catch (cause) {
    say(`  grab THREW: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  win.hide();
  win.destroy();
  if (image === null) {
    say("  skipped: no usable grab.");
    return;
  }

  const { width: gw, height: gh } = image.getSize(1);
  const buf = image.toBitmap({ scaleFactor: 1 });
  if (buf.length !== gw * gh * 4) {
    say(`  skipped: bitmap is ${buf.length} bytes, expected ${gw * gh * 4}.`);
    return;
  }
  // Classify by NEAREST reference colour rather than by per-channel tolerance.
  // A display colour profile shifts pure channels — a painted rgb(255,0,255)
  // came back with green around 50 on the macOS control run — so an absolute
  // threshold rejects every fiducial while the frame is plainly correct. The
  // five references are maximally separated, so nearest-match is unambiguous
  // and immune to that shift.
  const REFS = [...FIDUCIALS.map((f) => ({ key: f.key, rgb: f.rgb })), { key: "field", rgb: FIELD }];
  const CUTOFF_SQ = 140 * 140;
  const boxes = new Map();
  for (let y = 0; y < gh; y += 1) {
    for (let x = 0; x < gw; x += 1) {
      const o = (y * gw + x) * 4;
      const r = order === "rgba" ? buf[o] : buf[o + 2];
      const g = buf[o + 1];
      const b = order === "rgba" ? buf[o + 2] : buf[o];
      let key = null;
      let best = CUTOFF_SQ;
      for (const ref of REFS) {
        const dr = r - ref.rgb[0];
        const dg = g - ref.rgb[1];
        const db = b - ref.rgb[2];
        const d = dr * dr + dg * dg + db * db;
        if (d < best) { best = d; key = ref.key; }
      }
      if (key === null) continue;
      let cur = boxes.get(key);
      if (cur === undefined) {
        // Per-axis histograms rather than a running min/max. A raw bbox is
        // decided by its two most extreme pixels, so a single stray match
        // anywhere in the frame — an antialiased edge, the composited mouse
        // cursor — stretches it across the whole image and destroys the
        // measurement. Histograms let the span be trimmed by mass instead.
        cur = { xs: new Int32Array(gw), ys: new Int32Array(gh), n: 0 };
        boxes.set(key, cur);
      }
      cur.xs[x] += 1;
      cur.ys[y] += 1;
      cur.n += 1;
    }
  }
  /**
   * Smallest span holding all but `drop` of the mass, walked in from both ends.
   *
   * `drop` must stay far below the share of the mass in one row or column of a
   * real fiducial, or trimming becomes a systematic inset: a 240x240 block has
   * 240 pixels per column, so a 1% budget over 57,600 pixels eats two whole
   * columns and every corner reads +2. At 0.2% the budget is smaller than one
   * real column but still far above an isolated stray.
   */
  const span = (counts, n, drop = 0.002) => {
    const budget = Math.floor(n * drop);
    let lo = 0;
    let hi = counts.length - 1;
    let spent = 0;
    while (lo < hi && spent + counts[lo] <= budget) { spent += counts[lo]; lo += 1; }
    spent = 0;
    while (hi > lo && spent + counts[hi] <= budget) { spent += counts[hi]; hi -= 1; }
    return [lo, hi];
  };
  for (const [, v] of boxes) {
    const [x0, x1] = span(v.xs, v.n);
    const [y0, y1] = span(v.ys, v.n);
    v.x0 = x0; v.x1 = x1; v.y0 = y0; v.y1 = y1;
  }

  say("");
  say(`  grab ${gw}x${gh}, channel order ${order}, screen ${display.bounds.width}x${display.bounds.height} @${num(display.scaleFactor)}`);
  const field = boxes.get("field");
  if (field === undefined) {
    say("  The magenta field is NOT in the grab at all.");
    say("");
    // Say what WAS there. "Not found" alone cannot distinguish a grab of the
    // wrong source from a grab taken before the overlay painted.
    const tally = new Map();
    for (let i = 0; i < buf.length; i += 4 * 97) {
      const r = order === "rgba" ? buf[i] : buf[i + 2];
      const g = buf[i + 1];
      const b = order === "rgba" ? buf[i + 2] : buf[i];
      const key = `${r >> 5},${g >> 5},${b >> 5}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const sampled = [...tally.values()].reduce((a, b) => a + b, 0);
    say("  Most common colours in the frame (8-level buckets, % of samples):");
    for (const [key, n] of top) {
      const [r, g, b] = key.split(",").map((v) => Number(v) * 32);
      say(`    rgb(~${r},~${g},~${b})  ${num((n / sampled) * 100)}%`);
    }
    say("");
    say("  Mostly magenta-ish (~224,0,~224) would mean the overlay painted but");
    say("  the corner match is too strict. Anything else means the frame is not");
    say("  showing our overlay: either the grab beat it onto the screen, or the");
    say("  portal handed back a source that is not this display.");
    return;
  }
  say(`  magenta field spans ${field.x0},${field.y0} .. ${field.x1},${field.y1}`);
  say("");
  say("  fiducial      drawn at (screen px)     found at (grab px)      delta");
  const sx = gw / display.bounds.width;
  const sy = gh / display.bounds.height;
  const deltas = [];
  for (const f of FIDUCIALS) {
    const drawnX = f.key.endsWith("left") ? 0 : display.bounds.width - FIDUCIAL;
    const drawnY = f.key.startsWith("top") ? 0 : display.bounds.height - FIDUCIAL;
    const expX = Math.round(drawnX * sx);
    const expY = Math.round(drawnY * sy);
    const got = boxes.get(f.key);
    if (got === undefined) {
      say(`  ${f.key.padEnd(13)} ${String(drawnX + "," + drawnY).padEnd(23)} NOT FOUND (${f.name})`);
      continue;
    }
    const dx = got.x0 - expX;
    const dy = got.y0 - expY;
    deltas.push({ key: f.key, dx, dy, w: got.x1 - got.x0 + 1, h: got.y1 - got.y0 + 1 });
    say(
      `  ${f.key.padEnd(13)} ${String(drawnX + "," + drawnY).padEnd(23)} ` +
        `${String(got.x0 + "," + got.y0).padEnd(23)} ${dx >= 0 ? "+" : ""}${dx},${dy >= 0 ? "+" : ""}${dy}`
    );
  }
  if (deltas.length === 0) {
    say("");
    say("  No fiducial was found. The grab is not showing our overlay.");
    return;
  }
  const same =
    deltas.every((d) => d.dx === deltas[0].dx) && deltas.every((d) => d.dy === deltas[0].dy);
  say("");
  if (same && deltas[0].dx === 0 && deltas[0].dy === 0) {
    say("  VERDICT: the grab is EXACTLY this screen. Pixel (0,0) of the frame is");
    say("           pixel (0,0) of the display, at 1:1. The misalignment is not");
    say("           in the grab — look at what the selector does with it.");
  } else if (same) {
    say(`  VERDICT: the grab is TRANSLATED by ${deltas[0].dx},${deltas[0].dy} grab px and not scaled.`);
    say("           Every corner moved by the same amount, so the frame covers a");
    say("           region offset from the display origin. Painting it at the");
    say("           overlay's origin shifts every pixel by exactly this much —");
    say("           which is the reported duplication, measured.");
  } else {
    say("  VERDICT: the corners moved by DIFFERENT amounts — the frame is scaled");
    say("           or cropped, not merely offset:");
    for (const d of deltas) {
      say(`           ${d.key.padEnd(13)} delta ${d.dx},${d.dy}  size ${d.w}x${d.h} (drawn ${Math.round(FIDUCIAL * sx)}x${Math.round(FIDUCIAL * sy)})`);
    }
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
    if (DO_OVERLAY) {
      await reportSelectorSimulation(target, grabbed);
      if (DO_FIDUCIALS) await reportGrabAlignment(target);
      else {
        head("6. Grab alignment");
        say("  skipped (--no-fiducials)");
      }
    } else {
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
