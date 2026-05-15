// E2E coverage for the Settings substrate (Slice A — PR #20).
//
// Drives the `settings:*` command surface end-to-end through the E2E
// bridge (`__PWRSNAP_TEST__.dispatch`) plus the BrowserWindow + IPC
// plumbing. The unit-test suite under
// `src/main/handlers/__tests__/settings-handlers.test.ts` already
// covers handler logic against a mocked Electron — this file proves
// the same flows survive the real `app.getPath("userData")`,
// the real BrowserWindow lifecycle, the real renderer's
// `useActivePage` hook, and the real file-on-disk persistence.
//
// Each spec is independent: it launches its own Electron process
// against a tmpdir HOME and tears it down on finally. Specs follow
// the `smoke.spec.ts` shape; the more-elaborate seeding patterns
// from `library-source-filter.spec.ts` are intentionally avoided.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchPwrSnap } from "./fixtures/electron-app";

/**
 * Poll Electron's BrowserWindow list for a window whose URL hash
 * carries `stage=settings`. Returns the first matching Playwright
 * Page once its renderer has at least `domcontentloaded`.
 *
 * We match by URL hash, not document.title — the Settings window's
 * native title is "PwrSnap Settings" (set in `window.ts`) but it's
 * also the only window whose hash includes `stage=settings`, so the
 * hash is the more specific selector.
 */
async function waitForSettingsWindow(
  app: Awaited<ReturnType<typeof launchPwrSnap>>
): Promise<ReturnType<typeof app.electronApp.windows>[number]> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const candidate of app.electronApp.windows()) {
      if (candidate.url().includes("stage=settings")) {
        await candidate.waitForLoadState("domcontentloaded").catch(() => undefined);
        return candidate;
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("settings window never appeared");
}

function countSettingsWindows(app: Awaited<ReturnType<typeof launchPwrSnap>>): number {
  let total = 0;
  for (const w of app.electronApp.windows()) {
    if (w.url().includes("stage=settings")) total++;
  }
  return total;
}

test("settings:open creates a new Settings window", async () => {
  const app = await launchPwrSnap();
  try {
    expect(countSettingsWindows(app)).toBe(0);

    const result = await app.dispatch("settings:open", {});
    expect(result.ok).toBe(true);

    const settingsWindow = await waitForSettingsWindow(app);
    expect(countSettingsWindows(app)).toBe(1);
    expect(settingsWindow.url()).toContain("stage=settings");
  } finally {
    await app.close();
  }
});

test("settings:open is idempotent", async () => {
  const app = await launchPwrSnap();
  try {
    const first = await app.dispatch("settings:open", {});
    expect(first.ok).toBe(true);
    await waitForSettingsWindow(app);

    const second = await app.dispatch("settings:open", {});
    expect(second.ok).toBe(true);

    // Give the window list a beat to settle if a second window were
    // (incorrectly) racing through `ready-to-show`.
    await new Promise((r) => setTimeout(r, 250));
    expect(countSettingsWindows(app)).toBe(1);
  } finally {
    await app.close();
  }
});

test("settings:open with a page deep-links and re-navigates the existing window", async () => {
  const app = await launchPwrSnap();
  try {
    // First open with a deep link — main appends `page=ai` to the
    // hash before constructing the window, so the URL carries it
    // from first paint.
    const first = await app.dispatch("settings:open", { page: "ai" });
    expect(first.ok).toBe(true);
    const settingsWindow = await waitForSettingsWindow(app);
    expect(settingsWindow.url()).toContain("page=ai");

    // Second open with a different page — the window is already
    // there, so main fires `EVENT_CHANNELS.settingsNavigate`. The
    // renderer's `useActivePage` hook calls `setActivePage(hotkeys)`,
    // which flips `window.location.hash`. We poll the URL because
    // the navigate event is async across processes.
    const second = await app.dispatch("settings:open", { page: "hotkeys" });
    expect(second.ok).toBe(true);
    await expect.poll(() => settingsWindow.url(), { timeout: 5_000 }).toContain(
      "page=hotkeys"
    );

    // Sanity-check the count: deep-link nav must not spawn a 2nd window.
    expect(countSettingsWindows(app)).toBe(1);
  } finally {
    await app.close();
  }
});

test("settings:read returns defaults on a fresh launch", async () => {
  const app = await launchPwrSnap();
  try {
    const result = await app.dispatch("settings:read", {});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(result.value.schemaVersion).toBe(1);
    expect(result.value.codex.mode).toBe("auto");
    expect(result.value.ai.enabled).toBe(false);
    expect(result.value.experimental.v2FileFormat).toBe(false);
    // Shape sanity — every top-level key the protocol promises is present.
    expect(result.value).toHaveProperty("hotkeys");
    expect(typeof result.value.hotkeys.quickCapture).toBe("string");
  } finally {
    await app.close();
  }
});

test("settings:write persists to pwrsnap-settings.json under userData", async () => {
  // Fixture sets `PWRSNAP_USER_DATA=homeRoot` (see electron-app.ts), so
  // the settings file lands at `<homeRoot>/pwrsnap-settings.json`. We
  // verify (a) the write returns the merged result, (b) a follow-up
  // read sees the new value in the same process, and (c) the file
  // exists on disk with the expected JSON content. (c) covers
  // "persisted across relaunch" without paying for a second Electron
  // boot — the on-disk file is the only thing a relaunch would
  // re-read, and `DesktopSettingsService` is already unit-tested
  // against its own reload path.
  const app = await launchPwrSnap();
  try {
    const writeResult = await app.dispatch("settings:write", {
      experimental: { v2FileFormat: true }
    });
    expect(writeResult.ok).toBe(true);
    if (!writeResult.ok) throw new Error("unreachable");
    expect(writeResult.value.experimental.v2FileFormat).toBe(true);

    const readResult = await app.dispatch("settings:read", {});
    expect(readResult.ok).toBe(true);
    if (!readResult.ok) throw new Error("unreachable");
    expect(readResult.value.experimental.v2FileFormat).toBe(true);

    // The file lives directly under PWRSNAP_USER_DATA (== homeRoot).
    const settingsPath = path.join(app.homeRoot, "pwrsnap-settings.json");
    const fileInfo = await stat(settingsPath);
    expect(fileInfo.isFile()).toBe(true);
    const raw = await readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as { experimental?: { v2FileFormat?: boolean } };
    expect(parsed.experimental?.v2FileFormat).toBe(true);
  } finally {
    await app.close();
  }
});

test("events:settings:changed broadcasts on write", async () => {
  // Open the library window's renderer and install a subscriber via
  // the preload's generic `pwrsnapApi.on(channel, handler)` surface.
  // The handler stashes the latest payload on `window` so the test
  // can read it back via page.evaluate after dispatching the write.
  const app = await launchPwrSnap();
  try {
    await app.window.evaluate(() => {
      type SettingsChangedPayload = {
        settings: unknown;
        secrets: unknown;
      };
      const api = (globalThis as unknown as {
        pwrsnapApi: {
          on: (channel: string, handler: (payload: unknown) => void) => () => void;
        };
      }).pwrsnapApi;
      const sink = globalThis as unknown as {
        __settingsChanged?: SettingsChangedPayload | null;
      };
      sink.__settingsChanged = null;
      api.on("events:settings:changed", (payload) => {
        sink.__settingsChanged = payload as SettingsChangedPayload;
      });
    });

    const writeResult = await app.dispatch("settings:write", {
      ai: { enabled: true }
    });
    expect(writeResult.ok).toBe(true);

    // Wait for the broadcast to land in the renderer.
    const payload = await app.window
      .waitForFunction(
        () =>
          (globalThis as unknown as { __settingsChanged?: unknown }).__settingsChanged ?? null,
        null,
        { timeout: 5_000 }
      )
      .then((handle) => handle.jsonValue() as Promise<{
        settings: { ai: { enabled: boolean } };
        secrets: Record<string, unknown>;
      }>);

    expect(payload).toBeTruthy();
    expect(payload.settings.ai.enabled).toBe(true);
    expect(typeof payload.secrets).toBe("object");
    expect(payload.secrets).not.toBeNull();
  } finally {
    await app.close();
  }
});

test("settings:refreshCodexDiscovery returns a snapshot", async () => {
  const app = await launchPwrSnap();
  try {
    const result = await app.dispatch("settings:refreshCodexDiscovery", { force: false });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    // The snapshot shape is platform-independent; specific candidates
    // depend on the host PATH and aren't asserted on. CI runs Linux
    // xvfb where Codex is not installed; the call must still succeed
    // and return an array + a refreshedAt timestamp.
    expect(Array.isArray(result.value.candidates)).toBe(true);
    expect(typeof result.value.refreshedAt).toBe("string");
    // `resolvedPath` is `string | null`; assert the discriminator
    // without pinning the value.
    expect(
      result.value.resolvedPath === null ||
        typeof result.value.resolvedPath === "string"
    ).toBe(true);
  } finally {
    await app.close();
  }
});

test("settings:replaceSecret rejects unknown secret names with validation error", async () => {
  const app = await launchPwrSnap();
  try {
    const result = await app.dispatch("settings:replaceSecret", {
      name: "notARealSecret" as never,
      value: "x"
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("validation");
    expect(result.error.code).toBe("invalid_secret_name");
  } finally {
    await app.close();
  }
});

test("settings:write rejects null over a non-nullable field", async () => {
  const app = await launchPwrSnap();
  try {
    const result = await app.dispatch("settings:write", {
      codex: { pinnedPath: null as never }
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("validation");
    expect(result.error.code).toContain("invalid");
  } finally {
    await app.close();
  }
});
