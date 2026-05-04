// "Target windows" test harness — opens N off-screen-or-foreground
// BrowserWindows painted with named solid colors at known rects, so
// region-selection specs can:
//
//   • drive ⌘⇧P (or its programmatic equivalent) and verify the
//     selector highlights the right window borders;
//   • assert the captured PNG sampled at the rect center matches the
//     expected color (a red 200×200 window at (300, 300) should hand
//     back a PNG whose center pixel is #ff0000);
//   • test multi-display + window-overlap scenarios — overlap two
//     painted windows and verify our snap-to-window logic picks the
//     foreground one;
//   • verify the selector resize handles snap to displayed pixels.
//
// Each target is a single sandboxed BrowserWindow loading a
// `data:text/html` URL — no extra renderer build wiring, no need for
// a separate webpack entry. The HTML payload is one solid-color div.

import { expect, type ElectronApplication } from "@playwright/test";

export type TargetWindowSpec = {
  /** Stable id used by tests to reference this target. */
  id: string;
  /** CSS color — both painted on the body and used as the assertion
   *  baseline. Use 6-digit hex so we can compare without regex. */
  color: string;
  /** Display-local pixel rect. */
  rect: { x: number; y: number; width: number; height: number };
  /** Optional title shown in the window's titlebar. Defaults to id. */
  title?: string;
};

export type SpawnedTargets = {
  /** Targets that were actually opened, in the order requested. */
  specs: readonly TargetWindowSpec[];
  /** Tear them down. Idempotent. */
  close(): Promise<void>;
};

/**
 * Spawn a window per spec inside the running Electron app's main
 * process. They are created with `alwaysOnTop: true` and `frame: false`
 * so the painted color is the only visible content and the window
 * positions honor the spec's rect.
 */
export async function spawnTargetWindows(
  electronApp: ElectronApplication,
  specs: readonly TargetWindowSpec[]
): Promise<SpawnedTargets> {
  const ids = await electronApp.evaluate(async ({ BrowserWindow }, list) => {
    const created: number[] = [];
    for (const spec of list) {
      const html =
        "data:text/html;charset=utf-8," +
        encodeURIComponent(
          `<!doctype html>
<html><head><title>${spec.title ?? spec.id}</title>
<style>html,body{margin:0;padding:0;width:100%;height:100%;background:${spec.color};color:#fff;font:600 24px/1.2 system-ui,sans-serif;display:flex;align-items:center;justify-content:center}</style>
</head><body>${spec.title ?? spec.id}</body></html>`
        );
      const w = new BrowserWindow({
        x: spec.rect.x,
        y: spec.rect.y,
        width: spec.rect.width,
        height: spec.rect.height,
        frame: false,
        alwaysOnTop: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        focusable: false,
        title: spec.title ?? spec.id,
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false
        }
      });
      await w.loadURL(html);
      w.show();
      // Tag the window with the test id so we can find it again to
      // close. We park it on a global Map keyed by id.
      const store = (
        globalThis as unknown as {
          __PWRSNAP_TARGETS__?: Map<string, Electron.BrowserWindow>;
        }
      );
      if (store.__PWRSNAP_TARGETS__ === undefined) {
        store.__PWRSNAP_TARGETS__ = new Map();
      }
      store.__PWRSNAP_TARGETS__.set(spec.id, w);
      created.push(w.id);
    }
    return created;
  }, specs);

  // Wait for paint — Chromium fires `did-finish-load` synchronously on
  // data: URLs, but on Linux under xvfb the compositor still needs a
  // frame to commit the pixel. Poll briefly.
  await expect.poll(async () => ids.length).toBe(specs.length);

  return {
    specs,
    close: async () => {
      await electronApp.evaluate((_electron) => {
        const store = (
          globalThis as unknown as {
            __PWRSNAP_TARGETS__?: Map<string, Electron.BrowserWindow>;
          }
        ).__PWRSNAP_TARGETS__;
        if (store === undefined) return;
        for (const win of store.values()) {
          if (!win.isDestroyed()) win.destroy();
        }
        store.clear();
      });
    }
  };
}

/**
 * High-contrast 4-target preset: red, green, blue, yellow tiles in a
 * 2×2 grid starting at (200, 200). Useful for quick smoke checks.
 */
export const FOUR_TILE_GRID: readonly TargetWindowSpec[] = [
  { id: "tile-red", color: "#ff0000", rect: { x: 200, y: 200, width: 200, height: 200 } },
  { id: "tile-green", color: "#00aa00", rect: { x: 420, y: 200, width: 200, height: 200 } },
  { id: "tile-blue", color: "#0066ff", rect: { x: 200, y: 420, width: 200, height: 200 } },
  { id: "tile-yellow", color: "#ffaa00", rect: { x: 420, y: 420, width: 200, height: 200 } }
];
