// Unit tests for DesktopSettingsService. Each test scopes itself to
// a fresh `mkdtempSync` directory so the file-system invariants
// (atomic rename, quarantine on corruption, lazy migration) can be
// asserted against a real fs without touching the user's userData.

import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Stub electron — the service module itself doesn't import electron, but
// codex-discovery (transitive) loads electron-log. electron-log's main
// entry handles being loaded outside Electron, but be explicit to keep
// the test env hermetic.
vi.mock("electron", () => ({
  app: {
    getPath: (name: string): string => {
      if (name === "userData") return "/tmp/pwrsnap-test-settings-service";
      throw new Error(`unexpected app.getPath: ${name}`);
    }
  },
  BrowserWindow: { getAllWindows: () => [] }
}));

import {
  DEFAULT_HOTKEYS,
  GRID_ZOOM_DEFAULT,
  GRID_ZOOM_MAX,
  GRID_ZOOM_MIN,
  acceleratorsAreEquivalent,
  defaultHotkeysForPlatform,
  shortcutPlatformFromString,
  type Settings
} from "@pwrsnap/shared";
import {
  DesktopSettingsService,
  defaultSettings,
  mergeSettings
} from "../desktop-settings-service";
import { DesktopSettingsStore } from "../desktop-settings-store";

let workDir = "";
const HOST_HOTKEY_DEFAULTS = defaultHotkeysForPlatform(
  shortcutPlatformFromString(process.platform)
);

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pwrsnap-settings-svc-"));
});

afterEach(() => {
  // Leave the dir on disk — mkdtemp gives a unique name, and dropping
  // it would make a failing test harder to diagnose.
});

function makeService(): DesktopSettingsService {
  return new DesktopSettingsService({ filePath: join(workDir, "settings.json") });
}

function deferredSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = () => done();
  });
  return { promise, resolve };
}

describe("DesktopSettingsService.read", () => {
  test("returns defaults when the file is missing", async () => {
    const svc = makeService();
    const settings = await svc.read();
    expect(settings).toEqual(defaultSettings());
  });

  test("returns defaults + quarantines the file on JSON parse failure", async () => {
    const filePath = join(workDir, "settings.json");
    writeFileSync(filePath, "not-json-{[", "utf8");
    const svc = new DesktopSettingsService({ filePath });
    const settings = await svc.read();
    expect(settings).toEqual(defaultSettings());
    const entries = readdirSync(workDir);
    const quarantine = entries.find((n) => n.includes("corrupt-"));
    expect(quarantine).toBeDefined();
  });

  test("returns defaults + quarantines on unrecognized shape", async () => {
    const filePath = join(workDir, "settings.json");
    writeFileSync(filePath, JSON.stringify({ banana: true, schemaVersion: 99 }), "utf8");
    const svc = new DesktopSettingsService({ filePath });
    const settings = await svc.read();
    expect(settings).toEqual(defaultSettings());
    const entries = readdirSync(workDir);
    expect(entries.some((n) => n.includes("corrupt-"))).toBe(true);
  });

  test("coalesces concurrent cold reads into one immutable hydration", async () => {
    const raw = JSON.stringify(defaultSettings());
    let releaseRead: () => void = () => undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readTextFile = vi.fn(async () => {
      await readGate;
      return raw;
    });
    const svc = new DesktopSettingsService({
      filePath: join(workDir, "settings.json"),
      readTextFile
    });

    const reads = [svc.read(), svc.read(), svc.read()];
    expect(readTextFile).toHaveBeenCalledTimes(1);
    releaseRead();
    const [first, second, third] = await Promise.all(reads);

    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.recording)).toBe(true);
    expect(readTextFile).toHaveBeenCalledTimes(1);
  });

  test("keeps external edits behind the process restart boundary", async () => {
    let diskSettings = defaultSettings();
    const readTextFile = vi.fn(async () => JSON.stringify(diskSettings));
    const svc = new DesktopSettingsService({
      filePath: join(workDir, "settings.json"),
      readTextFile
    });

    const initial = await svc.read();
    diskSettings = mergeSettings(diskSettings, {
      recording: { imageCaptureCursor: false }
    });

    const cached = await svc.read();
    expect(cached).toBe(initial);
    expect(cached.recording.imageCaptureCursor).toBe(true);
    expect(readTextFile).toHaveBeenCalledTimes(1);

    const restarted = new DesktopSettingsService({
      filePath: join(workDir, "settings.json"),
      readTextFile
    });
    expect((await restarted.read()).recording.imageCaptureCursor).toBe(false);
    expect(readTextFile).toHaveBeenCalledTimes(2);
  });

  test("leaves the store unhydrated after a transient read failure and retries", async () => {
    const persisted = mergeSettings(defaultSettings(), {
      general: { developerMode: true }
    });
    let attempt = 0;
    const readTextFile = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw Object.assign(new Error("settings temporarily busy"), {
          code: "EBUSY"
        });
      }
      return JSON.stringify(persisted);
    });
    const svc = new DesktopSettingsService({
      filePath: join(workDir, "settings.json"),
      readTextFile
    });

    await expect(svc.read()).rejects.toMatchObject({ code: "EBUSY" });
    expect(svc.getCurrentSnapshot()).toBeNull();

    const recovered = await svc.read();
    expect(recovered.general.developerMode).toBe(true);
    expect(readTextFile).toHaveBeenCalledTimes(2);
  });
});

describe("DesktopSettingsService.write", () => {
  test("custom selections persist only the provider so an older reader cannot send their model to Codex", async () => {
    const svc = makeService();
    const provider = "custom:12345678-1234-4234-8234-123456789001";
    await svc.write({ ai: { defaults: { enrichment: { provider, model: "vendor/private-model" } } } });

    const saved = JSON.parse(readFileSync(join(workDir, "settings.json"), "utf8"));
    expect(saved.ai.defaults.enrichment).toEqual({ provider });
    expect((await new DesktopSettingsService({ filePath: join(workDir, "settings.json") }).read()).ai.defaults.enrichment)
      .toEqual({ provider });
  });

  test("clears a legacy custom model string on an unrelated settings write", async () => {
    const filePath = join(workDir, "settings.json");
    const raw = defaultSettings();
    raw.ai.defaults.enrichment = {
      provider: "custom:12345678-1234-4234-8234-123456789001",
      model: "vendor/private-model"
    };
    writeFileSync(filePath, JSON.stringify(raw), "utf8");
    await new DesktopSettingsService({ filePath }).write({ general: { developerMode: true } });
    expect(JSON.parse(readFileSync(filePath, "utf8")).ai.defaults.enrichment)
      .toEqual({ provider: raw.ai.defaults.enrichment.provider });
  });

  test("preserves newer settings fields across a write by an older build", async () => {
    const filePath = join(workDir, "settings.json");
    const raw = defaultSettings() as Settings & { futureSetting?: { nested: string } };
    raw.futureSetting = { nested: "keep" };
    (raw.ai as Settings["ai"] & { futureAi?: { enabled: boolean } }).futureAi = { enabled: true };
    writeFileSync(filePath, JSON.stringify(raw), "utf8");

    await new DesktopSettingsService({ filePath }).write({ general: { developerMode: true } });
    const saved = JSON.parse(readFileSync(filePath, "utf8"));
    expect(saved.futureSetting).toEqual({ nested: "keep" });
    expect(saved.ai.futureAi).toEqual({ enabled: true });
  });

  test("preserves newer fields inside custom connections and models on an unrelated write", async () => {
    const filePath = join(workDir, "settings.json");
    const raw = defaultSettings();
    raw.ai.customConnections = [{ id: "12345678-1234-4234-8234-123456789001", name: "Vendor",
      baseUrl: "https://example.com/v1", protocol: "openai-chat", auth: { type: "none" },
      futureConnectionOption: true } as unknown as NonNullable<Settings["ai"]["customConnections"]>[number]];
    raw.ai.customModels = [{ id: "12345678-1234-4234-8234-123456789002",
      connectionId: "12345678-1234-4234-8234-123456789001", displayName: "Future model",
      modelId: "vendor/model", capabilities: { vision: true, streaming: true },
      maxOutputTokens: 4096, futureModelOption: true } as unknown as NonNullable<Settings["ai"]["customModels"]>[number]];
    writeFileSync(filePath, JSON.stringify(raw), "utf8");

    await new DesktopSettingsService({ filePath }).write({ general: { developerMode: true } });
    const saved = JSON.parse(readFileSync(filePath, "utf8"));
    expect(saved.ai.customConnections).toEqual(raw.ai.customConnections);
    expect(saved.ai.customModels).toEqual(raw.ai.customModels);

    // An explicit model-list replacement still takes effect.
    await new DesktopSettingsService({ filePath }).write({ ai: { customModels: [] } });
    expect(JSON.parse(readFileSync(filePath, "utf8")).ai.customModels).toEqual([]);
  });

  test("the enrichment rate limit round-trips, clears to null, and an unreadable one reads as the default", async () => {
    const filePath = join(workDir, "settings.json");
    const svc = new DesktopSettingsService({ filePath });
    expect((await svc.read()).ai.enrichmentRateLimit).toBeNull();
    await svc.write({ ai: { enrichmentRateLimit: { burst: 60, perMinute: 120 } } });
    expect(JSON.parse(readFileSync(filePath, "utf8")).ai.enrichmentRateLimit).toEqual({ burst: 60, perMinute: 120 });
    await svc.write({ ai: { enabled: true } });
    expect((await new DesktopSettingsService({ filePath }).read()).ai.enrichmentRateLimit).toEqual({
      burst: 60,
      perMinute: 120
    });
    await svc.write({ ai: { enrichmentRateLimit: null } });
    expect((await new DesktopSettingsService({ filePath }).read()).ai.enrichmentRateLimit).toBeNull();

    const raw = defaultSettings() as unknown as { ai: Record<string, unknown> };
    raw.ai.enrichmentRateLimit = { burst: 0, perMinute: 1e9 };
    writeFileSync(filePath, JSON.stringify(raw), "utf8");
    expect((await new DesktopSettingsService({ filePath }).read()).ai.enrichmentRateLimit).toBeNull();
  });

  test("write + read round-trips", async () => {
    const svc = makeService();
    const merged = await svc.write({
      codex: { mode: "pinned", pinnedPath: "/opt/codex" }
    });
    expect(merged.codex.mode).toBe("pinned");
    expect(merged.codex.pinnedPath).toBe("/opt/codex");

    const read = await svc.read();
    expect(read.codex.mode).toBe("pinned");
    expect(read.codex.pinnedPath).toBe("/opt/codex");
    // Untouched fields default
    expect(read.ai.enabled).toBe(false);
    expect(read.hotkeys.quickCapture).toBe(HOST_HOTKEY_DEFAULTS.quickCapture);
    // Region / window default UNBOUND now that Quick Capture covers both.
    expect(read.hotkeys.region).toBe("");
    expect(read.hotkeys.window).toBe("");
    // Video Capture is the new entry; default ⌘⇧V.
    expect(read.hotkeys.videoCapture).toBe(HOST_HOTKEY_DEFAULTS.videoCapture);
  });

  test("undefined patch fields leave existing values untouched", async () => {
    const svc = makeService();
    await svc.write({ codex: { pinnedPath: "/opt/codex" } });
    // Second write — patch ONLY ai.enabled; codex.pinnedPath must survive.
    await svc.write({ ai: { enabled: true } });
    const read = await svc.read();
    expect(read.codex.pinnedPath).toBe("/opt/codex");
    expect(read.ai.enabled).toBe(true);
  });

  test("empty-string pinnedPath IS a write (clears the pin)", async () => {
    const svc = makeService();
    await svc.write({ codex: { pinnedPath: "/opt/codex" } });
    await svc.write({ codex: { pinnedPath: "" } });
    const read = await svc.read();
    expect(read.codex.pinnedPath).toBe("");
  });

  test("serialized writes merge from the snapshot without re-reading disk", async () => {
    const readTextFile = vi.fn(async () => JSON.stringify(defaultSettings()));
    const svc = new DesktopSettingsService({
      filePath: join(workDir, "settings.json"),
      readTextFile
    });

    const first = svc.write({ general: { developerMode: true } });
    const second = svc.write({ recording: { imageCaptureCursor: false } });
    await Promise.all([first, second]);
    const current = await svc.read();

    expect(current.general.developerMode).toBe(true);
    expect(current.recording.imageCaptureCursor).toBe(false);
    expect(readTextFile).toHaveBeenCalledTimes(1);
  });

  test("a transient hydration failure blocks writes until the valid file is readable", async () => {
    const filePath = join(workDir, "settings.json");
    const persisted = mergeSettings(defaultSettings(), {
      codex: { mode: "pinned", pinnedPath: "/opt/preserved-codex" },
      general: { developerMode: true }
    });
    const originalJson = `${JSON.stringify(persisted, null, 2)}\n`;
    writeFileSync(filePath, originalJson, "utf8");
    let attempt = 0;
    const readTextFile = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw Object.assign(new Error("settings temporarily unavailable"), {
          code: "EIO"
        });
      }
      return readFileSync(filePath, "utf8");
    });
    const svc = new DesktopSettingsService({ filePath, readTextFile });

    await expect(
      svc.write({ recording: { imageCaptureCursor: false } })
    ).rejects.toMatchObject({ code: "EIO" });
    expect(svc.getCurrentSnapshot()).toBeNull();
    expect(readFileSync(filePath, "utf8")).toBe(originalJson);

    const written = await svc.write({
      recording: { imageCaptureCursor: false }
    });
    expect(written.codex.pinnedPath).toBe("/opt/preserved-codex");
    expect(written.general.developerMode).toBe(true);
    expect(written.recording.imageCaptureCursor).toBe(false);
    expect(readTextFile).toHaveBeenCalledTimes(2);
  });

  test("local-agent access is opt-in and round-trips independently", async () => {
    const svc = makeService();
    expect((await svc.read()).localAgents.enabled).toBe(false);

    await svc.write({ localAgents: { enabled: true } });
    const read = await svc.read();

    expect(read.localAgents.enabled).toBe(true);
    expect(read.localAgents.grants).toEqual([]);
    expect(read.localAgents.roles).toEqual(defaultSettings().localAgents.roles);
  });

  test("older local-agent settings without the gate migrate to disabled", async () => {
    const filePath = join(workDir, "settings.json");
    const raw = defaultSettings();
    delete (raw.localAgents as Partial<typeof raw.localAgents>).enabled;
    writeFileSync(filePath, JSON.stringify(raw), "utf8");

    const read = await new DesktopSettingsService({ filePath }).read();

    expect(read.localAgents.enabled).toBe(false);
    expect(readdirSync(workDir).some((name) => name.includes("corrupt-"))).toBe(false);
  });

  test("malformed local-agent enable state quarantines and fails closed", async () => {
    const filePath = join(workDir, "settings.json");
    const raw = defaultSettings();
    (raw.localAgents as unknown as { enabled: unknown }).enabled = "yes";
    writeFileSync(filePath, JSON.stringify(raw), "utf8");

    const read = await new DesktopSettingsService({ filePath }).read();

    expect(read.localAgents.enabled).toBe(false);
    expect(readdirSync(workDir).some((name) => name.includes("corrupt-"))).toBe(true);
  });

  test("atomic write: no `.tmp` sidecar persists after a successful write", async () => {
    const svc = makeService();
    await svc.write({ codex: { pinnedPath: "/opt/codex" } });
    const entries = readdirSync(workDir);
    expect(entries.some((n) => n.endsWith(".tmp"))).toBe(false);
    // Final file is present + parseable.
    const raw = readFileSync(join(workDir, "settings.json"), "utf8");
    expect(JSON.parse(raw).codex.pinnedPath).toBe("/opt/codex");
  });

  test("concurrent writes serialize: second sees the first's result", async () => {
    const svc = makeService();
    // Fire both writes without awaiting between — the queue MUST serialize
    // them so the second's read picks up the first's pinnedPath.
    const a = svc.write({ codex: { pinnedPath: "/a" } });
    const b = svc.write({ ai: { enabled: true } });
    const [r1, r2] = await Promise.all([a, b]);
    expect(r1.codex.pinnedPath).toBe("/a");
    expect(r2.codex.pinnedPath).toBe("/a"); // carried over
    expect(r2.ai.enabled).toBe(true);
    const read = await svc.read();
    expect(read.codex.pinnedPath).toBe("/a");
    expect(read.ai.enabled).toBe(true);
  });

  test("serialized settings operations wait through atomic write commit", async () => {
    const atomicWriteEntered = deferredSignal();
    const releaseAtomicWrite = deferredSignal();

    class DeferredAtomicWriteService extends DesktopSettingsService {
      protected override async atomicWriteJson(value: Settings): Promise<void> {
        atomicWriteEntered.resolve();
        await releaseAtomicWrite.promise;
        await super.atomicWriteJson(value);
      }
    }

    const svc = new DeferredAtomicWriteService({
      filePath: join(workDir, "settings.json")
    });
    const write = svc.write({ hotkeys: { quickCapture: "Control+Alt+X" } });
    await atomicWriteEntered.promise;

    const operation = vi.fn((current: Settings) => current.hotkeys.quickCapture);
    let operationSettled = false;
    const serialized = svc.withSerializedSettings(operation).then((value) => {
      operationSettled = true;
      return value;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(operation).not.toHaveBeenCalled();
    expect(operationSettled).toBe(false);

    releaseAtomicWrite.resolve();
    await expect(write).resolves.toMatchObject({
      hotkeys: { quickCapture: "Control+Alt+X" }
    });
    await expect(serialized).resolves.toBe("Control+Alt+X");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  test("stages external state inside the write queue and commits after persistence", async () => {
    const svc = makeService();
    const commit = vi.fn();
    const rollback = vi.fn();
    const prepare = vi.fn((current: Settings, merged: Settings) => {
      expect(current.hotkeys.quickCapture).toBe(DEFAULT_HOTKEYS.quickCapture);
      expect(merged.hotkeys.quickCapture).toBe("Control+Alt+C");
      return { commit, rollback };
    });

    await svc.write(
      { hotkeys: { quickCapture: "Control+Alt+C" } },
      { prepare }
    );

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(rollback).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(workDir, "settings.json"), "utf8")).hotkeys.quickCapture)
      .toBe("Control+Alt+C");
  });

  test("rolls back staged external state when the atomic disk write fails", async () => {
    class FailingAtomicSettingsService extends DesktopSettingsService {
      protected override async atomicWriteJson(_value: Settings): Promise<void> {
        throw new Error("synthetic atomic write failure");
      }
    }
    const svc = new FailingAtomicSettingsService({
      filePath: join(workDir, "settings.json")
    });
    const commit = vi.fn();
    const rollback = vi.fn();

    await expect(
      svc.write(
        { hotkeys: { quickCapture: "Control+Alt+C" } },
        { prepare: () => ({ commit, rollback }) }
      )
    ).rejects.toBeDefined();

    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledTimes(1);
  });
});

describe("DesktopSettingsService legacy-shape catalog", () => {
  test("a hand-crafted unrecognized v0 JSON quarantines + returns defaults", async () => {
    // Today's catalog has only v1. A v0-shaped file (no schemaVersion,
    // flat keys) is not recognized and is treated as corruption — that's
    // the right behavior with one shape entry. The TEST verifies the
    // catalog-based reader plugs into the corruption path, and that the
    // hook (adding a v0 entry) lands cleanly when needed.
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({ codexCommand: "/usr/local/bin/codex" }),
      "utf8"
    );
    const svc = new DesktopSettingsService({ filePath });
    const settings = await svc.read();
    expect(settings).toEqual(defaultSettings());
    const entries = readdirSync(workDir);
    expect(entries.some((n) => n.includes("corrupt-"))).toBe(true);
  });

  test("v1 shape with missing nested keys gets defaults filled in", async () => {
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({ schemaVersion: 1, codex: { mode: "pinned", pinnedPath: "/x", profile: "" } }),
      "utf8"
    );
    const svc = new DesktopSettingsService({ filePath });
    const settings = await svc.read();
    expect(settings.codex.pinnedPath).toBe("/x");
    expect(settings.codex.mode).toBe("pinned");
    expect(settings.ai.enabled).toBe(false); // filled
    expect(settings.hotkeys.quickCapture).toBe(HOST_HOTKEY_DEFAULTS.quickCapture); // filled
    // videoCapture wasn't in the older v1 shape — service fills it.
    expect(settings.hotkeys.videoCapture).toBe(HOST_HOTKEY_DEFAULTS.videoCapture);
  });

  test("v1 shape missing the newer hotkeys gets the defaults filled in", async () => {
    // Older PwrSnap installs wrote `hotkeys` without `videoCapture` /
    // `fullScreen` / `allScreens` / `timed` / `reshowFloatOver` /
    // `openLibrary`.
    // parseV1 must fill the gaps so the in-memory shape always has
    // every field — even though the file on disk doesn't yet. The
    // next write upgrades the file in place.
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        hotkeys: {
          quickCapture: "CommandOrControl+Shift+C",
          region: "",
          window: ""
        }
      }),
      "utf8"
    );
    const svc = new DesktopSettingsService({ filePath });
    const settings = await svc.read();
    expect(settings.hotkeys.videoCapture).toBe(HOST_HOTKEY_DEFAULTS.videoCapture);
    expect(settings.hotkeys.quickCapture).toBe(HOST_HOTKEY_DEFAULTS.quickCapture);
    // Capture-mode hotkeys are unbound by default (also tray-reachable).
    expect(settings.hotkeys.fullScreen).toBe("");
    expect(settings.hotkeys.allScreens).toBe("");
    expect(settings.hotkeys.timed).toBe("");
    // Re-show last Float-Over defaults to the three-modifier ⌘⌥⇧F chord.
    expect(settings.hotkeys.reshowFloatOver).toBe(HOST_HOTKEY_DEFAULTS.reshowFloatOver);
    // Open Library is unbound by default — ⌘⇧L is taken by editors and
    // by our own Sizzle window, so we never register it out of the box.
    expect(settings.hotkeys.openLibrary).toBe("");
  });

  test("v1 shape missing `library.gridZoom` gets the default filled in; out-of-range clamps", async () => {
    // gridZoom landed after v1 shipped, so older files won't carry it.
    // parseLibrarySettings fills the default without disturbing siblings,
    // and clamps a hand-edited out-of-range value into the valid band.
    const missingPath = join(workDir, "settings-missing.json");
    writeFileSync(
      missingPath,
      JSON.stringify({
        schemaVersion: 1,
        library: { detailRail: { pinned: false, lastSelectedTab: "info" }, confirmBeforeTrash: false }
      }),
      "utf8"
    );
    const missing = await new DesktopSettingsService({ filePath: missingPath }).read();
    expect(missing.library.gridZoom).toBe(GRID_ZOOM_DEFAULT);
    // Sibling library fields from the file are preserved.
    expect(missing.library.detailRail.pinned).toBe(false);
    expect(missing.library.confirmBeforeTrash).toBe(false);

    const oobPath = join(workDir, "settings-oob.json");
    writeFileSync(
      oobPath,
      JSON.stringify({ schemaVersion: 1, library: { gridZoom: 100000 } }),
      "utf8"
    );
    const oob = await new DesktopSettingsService({ filePath: oobPath }).read();
    expect(oob.library.gridZoom).toBe(GRID_ZOOM_MAX);

    const lowPath = join(workDir, "settings-low.json");
    writeFileSync(
      lowPath,
      JSON.stringify({ schemaVersion: 1, library: { gridZoom: 1 } }),
      "utf8"
    );
    const low = await new DesktopSettingsService({ filePath: lowPath }).read();
    expect(low.library.gridZoom).toBe(GRID_ZOOM_MIN);
  });

  test("v1 shape missing the shape tool's `strokeStyle` gets solid filled in — tool style AND bag slots", async () => {
    // strokeStyle landed after the tool bag shipped, so older files carry
    // shape styles (and shape bag slots) without it. Additive: no
    // schemaVersion bump, and sibling fields survive.
    const legacyShape = {
      color: "green",
      thickness: "large",
      filled: false,
      shape: "oval",
      skewDeg: 15,
      outline: "black"
    };
    const path = join(workDir, "settings-no-stroke-style.json");
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        editor: {
          toolStyles: { shape: legacyShape },
          toolBag: { slots: [{ tool: "shape", style: legacyShape }] }
        }
      }),
      "utf8"
    );
    const read = await new DesktopSettingsService({ filePath: path }).read();
    expect(read.editor.toolStyles.shape).toEqual({ ...legacyShape, strokeStyle: "solid" });
    expect(read.editor.toolBag.slots[0]).toEqual({
      tool: "shape",
      style: { ...legacyShape, strokeStyle: "solid" }
    });

    const junkPath = join(workDir, "settings-junk-stroke-style.json");
    writeFileSync(
      junkPath,
      JSON.stringify({
        schemaVersion: 1,
        editor: { toolStyles: { shape: { ...legacyShape, strokeStyle: "wavy" } } }
      }),
      "utf8"
    );
    const junk = await new DesktopSettingsService({ filePath: junkPath }).read();
    expect(junk.editor.toolStyles.shape.strokeStyle).toBe("solid");
  });

  test("shape `strokeStyle` write + read round-trips", async () => {
    const svc = makeService();
    await svc.write({ editor: { toolStyles: { shape: { strokeStyle: "dotted" } } } });
    const fresh = await makeService().read();
    expect(fresh.editor.toolStyles.shape.strokeStyle).toBe("dotted");
    // The rest of the shape style is untouched.
    expect(fresh.editor.toolStyles.shape.shape).toBe(defaultSettings().editor.toolStyles.shape.shape);
  });

  test("v1 shape missing `library.gridCopyPalette` gets the follow/collapsed defaults; junk falls back", async () => {
    // gridCopyPalette landed well after v1 shipped, so older files won't
    // carry it. It parses independently of detailRail (same rule as
    // gridZoom / confirmBeforeTrash) and a garbage anchor degrades to
    // the default rather than quarantining the whole file.
    const missingPath = join(workDir, "settings-gcp-missing.json");
    writeFileSync(
      missingPath,
      JSON.stringify({
        schemaVersion: 1,
        library: { detailRail: { pinned: false, lastSelectedTab: "ocr" } }
      }),
      "utf8"
    );
    const missing = await new DesktopSettingsService({ filePath: missingPath }).read();
    expect(missing.library.gridCopyPalette).toEqual({
      anchor: "follow",
    });
    expect(missing.library.detailRail.lastSelectedTab).toBe("ocr");

    const roundTripPath = join(workDir, "settings-gcp-roundtrip.json");
    writeFileSync(
      roundTripPath,
      JSON.stringify({
        schemaVersion: 1,
        library: { gridCopyPalette: { anchor: "pinned" } }
      }),
      "utf8"
    );
    const roundTrip = await new DesktopSettingsService({
      filePath: roundTripPath
    }).read();
    expect(roundTrip.library.gridCopyPalette).toEqual({
      anchor: "pinned",
    });

    const junkPath = join(workDir, "settings-gcp-junk.json");
    writeFileSync(
      junkPath,
      JSON.stringify({
        schemaVersion: 1,
        library: { gridCopyPalette: { anchor: "sticky" } }
      }),
      "utf8"
    );
    const junk = await new DesktopSettingsService({ filePath: junkPath }).read();
    expect(junk.library.gridCopyPalette).toEqual({
      anchor: "follow",
    });
  });

  test("library.editToolbarDock round-trips, and a missing or unknown value floats", async () => {
    const read = async (name: string, library: unknown) => {
      const filePath = join(workDir, name);
      writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, library }), "utf8");
      return (await new DesktopSettingsService({ filePath }).read()).library;
    };
    expect((await read("dock-top.json", { editToolbarDock: "top" })).editToolbarDock).toBe("top");
    // Files from before the field existed.
    const missing = await read("dock-missing.json", { confirmBeforeTrash: false });
    expect(missing.editToolbarDock).toBe("float");
    expect(missing.confirmBeforeTrash).toBe(false);
    // A value a newer build might write falls back instead of quarantining.
    expect((await read("dock-junk.json", { editToolbarDock: "sideways" })).editToolbarDock).toBe(
      "float"
    );
  });

  test("v1 shape missing `general.launchAtLogin` gets the opt-in default (false) filled in", async () => {
    // `general.launchAtLogin` landed after v1 shipped; older files
    // carry `general` with only `developerMode`. parseV1 fills the
    // gap without disturbing the sibling flag.
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({ schemaVersion: 1, general: { developerMode: true } }),
      "utf8"
    );
    const svc = new DesktopSettingsService({ filePath });
    const settings = await svc.read();
    expect(settings.general.developerMode).toBe(true);
    expect(settings.general.launchAtLogin).toBe(false);
  });

  test("`general.launchAtLogin` write + read round-trips without touching developerMode", async () => {
    const svc = makeService();
    const written = await svc.write({ general: { launchAtLogin: true } });
    expect(written.general.launchAtLogin).toBe(true);
    expect(written.general.developerMode).toBe(false);
    const reread = await makeService().read();
    expect(reread.general.launchAtLogin).toBe(true);
  });

  test("defaultSettings() seeds explicit platform hotkey defaults", () => {
    // Lock the renderer/main shared source: the Hotkeys page's "Reset to
    // defaults" reads the same object, so a drift here would silently
    // make Reset write a different chord than a fresh install.
    expect(defaultSettings("darwin").hotkeys).toEqual(DEFAULT_HOTKEYS);
    expect(defaultSettings("win32").hotkeys).toEqual(
      defaultHotkeysForPlatform("win32")
    );
    expect(defaultSettings("linux").hotkeys).toEqual(
      defaultHotkeysForPlatform("linux")
    );
  });

  test("migrates only physical matches for AltGr-unsafe non-Mac defaults", async () => {
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        lastDefaultsMigrationVersion: "1.0.0-beta.26",
        hotkeys: {
          quickCapture: "Control+Shift+C",
          videoCapture: "Control+Alt+C",
          reshowFloatOver: "Control+Alt+Shift+F",
          region: "Control+Alt+X"
        }
      }),
      "utf8"
    );

    const settings = await new DesktopSettingsService({
      filePath,
      shortcutPlatform: "win32"
    }).read();

    expect(settings.hotkeys).toMatchObject({
      quickCapture: "Control+Shift+C",
      videoCapture: "",
      reshowFloatOver: "",
      region: "Control+Alt+X"
    });
    expect(settings.lastDefaultsMigrationVersion).toBe("1.1.0-alpha.5");
    expect(
      acceleratorsAreEquivalent(
        "AltGr+C",
        "Control+Alt+C",
        "win32"
      )
    ).toBe(true);
  });

  test("preserves customized non-Mac chords during the managed-default migration", async () => {
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        lastDefaultsMigrationVersion: "1.0.0-beta.26",
        hotkeys: {
          videoCapture: "Control+Alt+V",
          reshowFloatOver: "Super+Alt+F"
        }
      }),
      "utf8"
    );

    const settings = await new DesktopSettingsService({
      filePath,
      shortcutPlatform: "win32"
    }).read();
    expect(settings.hotkeys.videoCapture).toBe("Control+Alt+V");
    expect(settings.hotkeys.reshowFloatOver).toBe("Super+Alt+F");
  });

  test("defaultSettings() leaves enrichment unpinned and records the defaults ledger", () => {
    const settings = defaultSettings();
    expect(settings.lastDefaultsMigrationVersion).toBe("1.1.0-alpha.5");
    expect(settings.codex.captionModel).toBe("gpt-5.6-luna");
    expect(settings.ai.defaults.enrichment).toEqual({});
  });

  test("v1 shape missing `codex.captionModel` gets the default filled in", async () => {
    // Same pattern as videoCapture above: `captionModel` landed after
    // v1 shipped, so older settings files won't have it. parseV1 fills
    // the gap so the in-memory shape always has every field.
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        codex: { mode: "auto", pinnedPath: "", profile: "" }
      }),
      "utf8"
    );
    const svc = new DesktopSettingsService({ filePath });
    const settings = await svc.read();
    expect(settings.codex.captionModel).toBe("gpt-5.6-luna");
    expect(settings.ai.defaults.enrichment).toEqual({});
    expect(settings.lastDefaultsMigrationVersion).toBe("1.1.0-alpha.5");
  });

  test("v1 shape with a newer `codex.captionModel` preserves the model id", async () => {
    // Codex model availability is dynamic by account/build. A model id
    // that was unknown to this app version can still be valid for the
    // installed Codex App Server, so parseV1 preserves valid id strings.
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        codex: {
          mode: "auto",
          pinnedPath: "",
          profile: "",
          captionModel: "gpt-5.5"
        }
      }),
      "utf8"
    );
    const svc = new DesktopSettingsService({ filePath });
    const settings = await svc.read();
    expect(settings.codex.captionModel).toBe("gpt-5.5");
  });

  test("defaultSettings() seeds recording cursor capture ON for both modes", () => {
    const d = defaultSettings();
    expect(d.recording.videoCaptureCursor).toBe(true);
    expect(d.recording.imageCaptureCursor).toBe(true);
  });

  test("defaultSettings() leaves both audio sources OFF", () => {
    // Recording either source is a privacy-relevant opt-in, so the
    // default is the quiet one. Pinned here because it is now the SOURCE
    // of `FALLBACK_RECORDING_DEFAULTS` in record-from-selection.ts —
    // what a capture falls back to when the settings read fails. That
    // constant used to restate these values by hand, and the test that
    // named it asserted a mocked module against its own literal, so
    // flipping `includeMicrophone` here would have hot-miked a user with
    // an unreadable settings file and passed every test.
    const d = defaultSettings();
    expect(d.recording.includeSystemAudio).toBe(false);
    expect(d.recording.includeMicrophone).toBe(false);
  });

  test("v1 recording block missing the cursor flags gets ON defaults filled in", async () => {
    // `videoCaptureCursor` / `imageCaptureCursor` are additive (no
    // schemaVersion bump). Older files have a `recording` block without
    // them; parseV1 fills ON so existing installs keep the pre-setting
    // behavior (video has always baked in the cursor).
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        recording: { includeSystemAudio: true, includeMicrophone: false }
      }),
      "utf8"
    );
    const svc = new DesktopSettingsService({ filePath });
    const settings = await svc.read();
    expect(settings.recording.videoCaptureCursor).toBe(true);
    expect(settings.recording.imageCaptureCursor).toBe(true);
    // Existing fields in the same block still parse.
    expect(settings.recording.includeSystemAudio).toBe(true);
  });

  test("v1 recording block missing the MP4 audio flags keeps every recorded track", async () => {
    // `mp4Include*` are additive. An install that predates the MP4 audio
    // toggle exported every recorded track; ON keeps that until the user
    // switches a track off on an export grid.
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({ schemaVersion: 1, recording: { includeMicrophone: true } }),
      "utf8"
    );
    const svc = new DesktopSettingsService({ filePath });
    const settings = await svc.read();
    expect(settings.recording.mp4IncludeMicrophone).toBe(true);
    expect(settings.recording.mp4IncludeSystemAudio).toBe(true);
  });

  test("an MP4 audio track switched off stays off across a restart", async () => {
    const filePath = join(workDir, "settings.json");
    const svc = new DesktopSettingsService({ filePath });
    await svc.write({ recording: { mp4IncludeMicrophone: false } });

    const restarted = await new DesktopSettingsService({ filePath }).read();
    expect(restarted.recording.mp4IncludeMicrophone).toBe(false);
    expect(restarted.recording.mp4IncludeSystemAudio).toBe(true);
    // Recording a microphone and exporting one are separate choices.
    expect(restarted.recording.includeMicrophone).toBe(false);
  });

  test("the recent-capture sidebar defaults ON, including for files that predate it", async () => {
    expect(defaultSettings().recording.showRecentCaptureSidebar).toBe(true);
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({ schemaVersion: 1, recording: { showRegionFrame: false } }),
      "utf8"
    );
    const settings = await new DesktopSettingsService({ filePath }).read();
    expect(settings.recording.showRecentCaptureSidebar).toBe(true);
    expect(settings.recording.showRegionFrame).toBe(false);
  });

  test("a hidden recent-capture sidebar stays hidden across a restart", async () => {
    const filePath = join(workDir, "settings.json");
    await new DesktopSettingsService({ filePath }).write({
      recording: { showRecentCaptureSidebar: false }
    });

    const restarted = await new DesktopSettingsService({ filePath }).read();
    expect(restarted.recording.showRecentCaptureSidebar).toBe(false);
    // Hiding the sidebar is not an AI choice.
    expect(restarted.ai).toEqual(defaultSettings().ai);

    await new DesktopSettingsService({ filePath }).write({
      recording: { showRecentCaptureSidebar: true }
    });
    expect(
      (await new DesktopSettingsService({ filePath }).read()).recording.showRecentCaptureSidebar
    ).toBe(true);
  });

  test("device choices default to none, survive a restart, and clear back to null", async () => {
    expect(defaultSettings().recording.microphoneDevice).toBeNull();
    expect(defaultSettings().recording.cameraDevice).toBeNull();
    const filePath = join(workDir, "settings.json");
    // A file from before the pickers has no device fields at all.
    writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, recording: {} }), "utf8");
    expect((await new DesktopSettingsService({ filePath }).read()).recording.microphoneDevice).toBeNull();

    const mic = { deviceId: "chromium-id-granola", label: "Granola Interface (USB)" };
    const camera = { deviceId: "chromium-id-bran", label: "Bran Flake Cam" };
    await new DesktopSettingsService({ filePath }).write({
      recording: { microphoneDevice: mic, cameraDevice: camera }
    });
    const restarted = await new DesktopSettingsService({ filePath }).read();
    expect(restarted.recording.microphoneDevice).toEqual(mic);
    expect(restarted.recording.cameraDevice).toEqual(camera);
    // Picking a device names it; it never arms the source.
    expect(restarted.recording.includeMicrophone).toBe(defaultSettings().recording.includeMicrophone);

    await new DesktopSettingsService({ filePath }).write({ recording: { microphoneDevice: null } });
    const cleared = await new DesktopSettingsService({ filePath }).read();
    expect(cleared.recording.microphoneDevice).toBeNull();
    expect(cleared.recording.cameraDevice).toEqual(camera);
  });

  test("a malformed device choice on disk reads as no choice, not a corrupt file", async () => {
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        recording: { microphoneDevice: { label: "Muesli Mic" }, cameraDevice: "cam", showRegionFrame: false }
      }),
      "utf8"
    );
    const settings = await new DesktopSettingsService({ filePath }).read();
    expect(settings.recording.microphoneDevice).toBeNull();
    expect(settings.recording.cameraDevice).toBeNull();
    // The rest of the block is untouched.
    expect(settings.recording.showRegionFrame).toBe(false);
  });

  test("v1 recording block preserves an explicit cursor:false choice", async () => {
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        recording: { videoCaptureCursor: false, imageCaptureCursor: false }
      }),
      "utf8"
    );
    const svc = new DesktopSettingsService({ filePath });
    const settings = await svc.read();
    expect(settings.recording.videoCaptureCursor).toBe(false);
    expect(settings.recording.imageCaptureCursor).toBe(false);
  });

  test("defaultSettings() seeds quickCaptureAction to ask", () => {
    // `ask` is the chooser default: the selector offers both Snap and
    // Record without adding a keystroke (↵ still snaps).
    expect(defaultSettings().recording.quickCaptureAction).toBe("ask");
  });

  test("v1 recording block missing quickCaptureAction gets the ask default", async () => {
    // Additive field, no schemaVersion bump — an existing install gains
    // the Record affordance and keeps ↵-to-snap.
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        recording: { includeSystemAudio: true }
      }),
      "utf8"
    );
    const settings = await new DesktopSettingsService({ filePath }).read();
    expect(settings.recording.quickCaptureAction).toBe("ask");
    expect(settings.recording.includeSystemAudio).toBe(true);
  });

  test("v1 recording block preserves an explicit quickCaptureAction and rejects junk", async () => {
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({ schemaVersion: 1, recording: { quickCaptureAction: "record" } }),
      "utf8"
    );
    expect(
      (await new DesktopSettingsService({ filePath }).read()).recording.quickCaptureAction
    ).toBe("record");

    const junkPath = join(workDir, "settings-junk.json");
    writeFileSync(
      junkPath,
      JSON.stringify({ schemaVersion: 1, recording: { quickCaptureAction: "video" } }),
      "utf8"
    );
    expect(
      (await new DesktopSettingsService({ filePath: junkPath }).read()).recording
        .quickCaptureAction
    ).toBe("ask");
  });

  test("ignores beta.25 captionModel and advances the managed-defaults ledger", async () => {
    // `ai.defaults.*` is additive. Older files won't have it; parseV1
    // fills empty objects for the two chat surfaces (= "Codex default").
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        codex: { mode: "auto", pinnedPath: "", profile: "", captionModel: "gpt-5.4-mini" },
        ai: { enabled: true }
      }),
      "utf8"
    );
    const svc = new DesktopSettingsService({ filePath });
    const settings = await svc.read();
    expect(settings.ai.defaults.libraryChat).toEqual({});
    expect(settings.ai.defaults.sizzleChat).toEqual({});
    expect(settings.lastDefaultsMigrationVersion).toBe("1.1.0-alpha.5");
    expect(settings.codex.captionModel).toBe("gpt-5.4-mini");
    expect(settings.ai.defaults.enrichment).toEqual({});

    // The additive watermark is written on the next normal settings write,
    // matching the service's lazy-migration convention.
    await svc.write({ general: { developerMode: true } });
    const persisted = JSON.parse(readFileSync(filePath, "utf8")) as {
      lastDefaultsMigrationVersion?: string;
      ai?: { defaults?: { enrichment?: unknown } };
    };
    expect(persisted.lastDefaultsMigrationVersion).toBe("1.1.0-alpha.5");
    expect(persisted.ai?.defaults?.enrichment).toEqual({});
  });

  test("the migration watermark preserves a later explicit gpt-5.4-mini choice", async () => {
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        lastDefaultsMigrationVersion: "1.0.0-beta.26",
        codex: {
          mode: "auto",
          pinnedPath: "",
          profile: "",
          captionModel: "gpt-5.4-mini"
        },
        ai: {
          defaults: {
            enrichment: { model: "gpt-5.4-mini", reasoning: "low" }
          }
        }
      }),
      "utf8"
    );

    const settings = await new DesktopSettingsService({ filePath }).read();
    expect(settings.codex.captionModel).toBe("gpt-5.4-mini");
    expect(settings.ai.defaults.enrichment).toEqual({
      model: "gpt-5.4-mini",
      reasoning: "low"
    });
  });

  test("clears the explicitly materialized historical gpt-5.4-mini Low pair", async () => {
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        codex: {
          mode: "auto",
          pinnedPath: "",
          profile: "",
          captionModel: "gpt-5.4-mini"
        },
        ai: {
          defaults: {
            enrichment: { model: "gpt-5.4-mini", reasoning: "low" }
          }
        }
      }),
      "utf8"
    );

    const settings = await new DesktopSettingsService({ filePath }).read();
    expect(settings.ai.defaults.enrichment).toEqual({});
    expect(settings.lastDefaultsMigrationVersion).toBe("1.1.0-alpha.5");
  });

  test("preserves an explicit enrichment effort instead of treating it as the old default", async () => {
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        codex: {
          mode: "auto",
          pinnedPath: "",
          profile: "",
          captionModel: "gpt-5.4-mini"
        },
        ai: {
          defaults: {
            enrichment: { model: "gpt-5.4-mini", reasoning: "high" }
          }
        }
      }),
      "utf8"
    );

    const settings = await new DesktopSettingsService({ filePath }).read();
    expect(settings.ai.defaults.enrichment).toEqual({
      model: "gpt-5.4-mini",
      reasoning: "high"
    });
  });

  test("v1 shape does not seed `ai.defaults.enrichment.model` from captionModel", async () => {
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        codex: { mode: "auto", pinnedPath: "", profile: "", captionModel: "gpt-5.5" }
      }),
      "utf8"
    );
    const svc = new DesktopSettingsService({ filePath });
    const settings = await svc.read();
    expect(settings.codex.captionModel).toBe("gpt-5.5");
    expect(settings.ai.defaults.enrichment).toEqual({});
  });

  test("an unknown future defaults watermark is preserved without replaying old cleanup", async () => {
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        lastDefaultsMigrationVersion: "1.0.0-beta.99",
        ai: {
          defaults: {
            enrichment: { model: "gpt-5.4-mini", reasoning: "low" }
          }
        }
      }),
      "utf8"
    );

    const svc = new DesktopSettingsService({ filePath });
    const settings = await svc.read();
    expect(settings.lastDefaultsMigrationVersion).toBe("1.0.0-beta.99");
    expect(settings.ai.defaults.enrichment).toEqual({
      model: "gpt-5.4-mini",
      reasoning: "low"
    });

    await svc.write({ general: { developerMode: true } });
    const persisted = JSON.parse(readFileSync(filePath, "utf8")) as {
      lastDefaultsMigrationVersion?: string;
      ai?: { defaults?: { enrichment?: unknown } };
    };
    expect(persisted.lastDefaultsMigrationVersion).toBe("1.0.0-beta.99");
    expect(persisted.ai?.defaults?.enrichment).toEqual({
      model: "gpt-5.4-mini",
      reasoning: "low"
    });
  });

  test("does NOT seed the Codex captionModel onto an ACP enrichment provider", async () => {
    // Regression: a file that switched the enrichment backend to an ACP agent
    // but never picked an agent model must NOT inherit `codex.captionModel`
    // (a Codex id the agent rejects). enrichment.model stays unset → the ACP
    // path resolves to "" = the agent's own default. The Codex-default chat
    // surfaces still keep behaving as before.
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        codex: { mode: "auto", pinnedPath: "", profile: "", captionModel: "gpt-5.4-mini" },
        ai: { enabled: true, defaults: { enrichment: { provider: "acp:kimi" } } }
      }),
      "utf8"
    );
    const settings = await new DesktopSettingsService({ filePath }).read();
    expect(settings.ai.defaults.enrichment.provider).toBe("acp:kimi");
    expect(settings.ai.defaults.enrichment.model).toBeUndefined();
  });

  test("an explicit ACP enrichment model is preserved", async () => {
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        codex: { mode: "auto", pinnedPath: "", profile: "", captionModel: "gpt-5.4-mini" },
        ai: {
          enabled: true,
          defaults: { enrichment: { provider: "acp:kimi", model: "kimi-code/kimi-for-coding" } }
        }
      }),
      "utf8"
    );
    const settings = await new DesktopSettingsService({ filePath }).read();
    expect(settings.ai.defaults.enrichment.model).toBe("kimi-code/kimi-for-coding");
  });

  test("v1 shape with explicit `ai.defaults` preserves provider/model/reasoning", async () => {
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        codex: { mode: "auto", pinnedPath: "", profile: "", captionModel: "gpt-5.4-mini" },
        ai: {
          enabled: true,
          defaults: {
            libraryChat: { provider: "acp:gemini", model: "gpt-5.5", reasoning: "high" },
            sizzleChat: { reasoning: "medium" },
            // Explicit enrichment model remains independent of captionModel.
            enrichment: { model: "gpt-5.5-mini" }
          }
        }
      }),
      "utf8"
    );
    const svc = new DesktopSettingsService({ filePath });
    const settings = await svc.read();
    expect(settings.ai.defaults.libraryChat).toEqual({
      provider: "acp:gemini",
      model: "gpt-5.5",
      reasoning: "high"
    });
    expect(settings.ai.defaults.sizzleChat).toEqual({ reasoning: "medium" });
    expect(settings.ai.defaults.enrichment.model).toBe("gpt-5.5-mini");
  });

  test("v1 shape drops a legacy free-text provider (now a backend selector)", async () => {
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        codex: { mode: "auto", pinnedPath: "", profile: "", captionModel: "gpt-5.4-mini" },
        ai: {
          enabled: true,
          // "openai" was the old free-text Codex modelProvider; provider is a
          // backend selector now, so it's dropped (→ Codex), model kept.
          defaults: { enrichment: { provider: "openai", model: "gpt-5.5-mini" } }
        }
      }),
      "utf8"
    );
    const settings = await new DesktopSettingsService({ filePath }).read();
    expect(settings.ai.defaults.enrichment).toEqual({ model: "gpt-5.5-mini" });
  });

  test("v1 shape drops empty-string and invalid `ai.defaults` leaves", async () => {
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        codex: { mode: "auto", pinnedPath: "", profile: "", captionModel: "gpt-5.4-mini" },
        ai: {
          enabled: true,
          defaults: {
            // Empty / whitespace strings and a malformed reasoning value are
            // dropped so the in-memory shape omits them (= Codex default).
            libraryChat: { provider: "  ", model: "", reasoning: "not an effort!" }
          }
        }
      }),
      "utf8"
    );
    const svc = new DesktopSettingsService({ filePath });
    const settings = await svc.read();
    expect(settings.ai.defaults.libraryChat).toEqual({});
  });

  test("v1 shape preserves protocol-advertised extended reasoning efforts", async () => {
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        codex: { mode: "auto", pinnedPath: "", profile: "", captionModel: "gpt-5.4-mini" },
        ai: {
          enabled: true,
          defaults: {
            libraryChat: { model: "gpt-5.6-terra", reasoning: "ultra" }
          }
        }
      }),
      "utf8"
    );

    const settings = await new DesktopSettingsService({ filePath }).read();
    expect(settings.ai.defaults.libraryChat).toEqual({
      model: "gpt-5.6-terra",
      reasoning: "ultra"
    });
  });

  test("fresh defaults have an empty `ai.acp.enabledAgentIds`", () => {
    expect(defaultSettings().ai.acp).toEqual({ enabledAgentIds: [], agents: {} });
  });

  test("v1 shape missing `ai.acp` defaults to an empty enabled set", async () => {
    // `ai.acp.*` is additive. Older files won't have it; parseV1 fills
    // an empty enabled set.
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        codex: { mode: "auto", pinnedPath: "", profile: "", captionModel: "gpt-5.4-mini" },
        ai: { enabled: true }
      }),
      "utf8"
    );
    const svc = new DesktopSettingsService({ filePath });
    const settings = await svc.read();
    expect(settings.ai.acp).toEqual({ enabledAgentIds: [], agents: {} });
  });

  test("v1 shape keeps recognized `ai.acp` agent ids and drops unknown / duplicate ones", async () => {
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        codex: { mode: "auto", pinnedPath: "", profile: "", captionModel: "gpt-5.4-mini" },
        ai: {
          enabled: true,
          // "bogus" is not a known agent; "kimi" is duplicated; 42 is not
          // a string. parseV1 keeps only recognized ids, de-duplicated,
          // in order.
          acp: { enabledAgentIds: ["kimi", "bogus", "qwen", "kimi", 42] }
        }
      }),
      "utf8"
    );
    const svc = new DesktopSettingsService({ filePath });
    const settings = await svc.read();
    expect(settings.ai.acp.enabledAgentIds).toEqual(["kimi", "qwen"]);
  });
});

describe("DesktopSettingsService.write ai.acp", () => {
  test("patching `ai.acp.enabledAgentIds` replaces the stored set wholesale", async () => {
    const svc = makeService();
    await svc.write({ ai: { acp: { enabledAgentIds: ["kimi", "qwen"] } } });
    let read = await svc.read();
    expect(read.ai.acp.enabledAgentIds).toEqual(["kimi", "qwen"]);

    // A subsequent patch replaces (does not merge) the set.
    await svc.write({ ai: { acp: { enabledAgentIds: ["gemini"] } } });
    read = await svc.read();
    expect(read.ai.acp.enabledAgentIds).toEqual(["gemini"]);
  });

  test("an empty `enabledAgentIds` array clears the set", async () => {
    const svc = makeService();
    await svc.write({ ai: { acp: { enabledAgentIds: ["grok"] } } });
    await svc.write({ ai: { acp: { enabledAgentIds: [] } } });
    const read = await svc.read();
    expect(read.ai.acp.enabledAgentIds).toEqual([]);
  });

  test("an undefined `ai.acp` leaves the stored set untouched", async () => {
    const svc = makeService();
    await svc.write({ ai: { acp: { enabledAgentIds: ["kimi"] } } });
    // Patch a different ai field; acp must survive.
    await svc.write({ ai: { enabled: true } });
    const read = await svc.read();
    expect(read.ai.acp.enabledAgentIds).toEqual(["kimi"]);
  });

  test("`ai.acp.agents` merges per agent (pick one without disturbing another)", async () => {
    const svc = makeService();
    await svc.write({ ai: { acp: { agents: { qwen: { selectedPath: "/nvm/qwen" } } } } });
    await svc.write({ ai: { acp: { agents: { grok: { overridePath: "/custom/grok" } } } } });
    const read = await svc.read();
    expect(read.ai.acp.agents).toEqual({
      qwen: { selectedPath: "/nvm/qwen" },
      grok: { overridePath: "/custom/grok" }
    });
  });

  test("an empty-string leaf clears that preference (revert to auto), dropping empty entries", async () => {
    const svc = makeService();
    await svc.write({ ai: { acp: { agents: { qwen: { selectedPath: "/nvm/qwen" } } } } });
    await svc.write({ ai: { acp: { agents: { qwen: { selectedPath: "" } } } } });
    const read = await svc.read();
    expect(read.ai.acp.agents).toEqual({});
  });

  test("patching enabledAgentIds leaves the agents map untouched", async () => {
    const svc = makeService();
    await svc.write({ ai: { acp: { agents: { qwen: { overridePath: "/p/qwen" } } } } });
    await svc.write({ ai: { acp: { enabledAgentIds: ["qwen"] } } });
    const read = await svc.read();
    expect(read.ai.acp.agents).toEqual({ qwen: { overridePath: "/p/qwen" } });
    expect(read.ai.acp.enabledAgentIds).toEqual(["qwen"]);
  });
});

describe("DesktopSettingsService write-queue serialization on rejection", () => {
  test("three queued writes where the middle one rejects: outer pair still applies; rejection bubbles only to its caller", async () => {
    const svc = makeService();
    // Patch the private atomicWriteJson to reject on the second call.
    // Cast through `unknown` to reach the private member without
    // exposing it on the public type. (`exactOptionalPropertyTypes`
    // doesn't object to this — we're replacing, not adding.)
    const internal = svc as unknown as {
      atomicWriteJson: (value: unknown) => Promise<void>;
    };
    const realAtomic = internal.atomicWriteJson.bind(svc);
    let callIdx = 0;
    internal.atomicWriteJson = async (value: unknown): Promise<void> => {
      callIdx += 1;
      if (callIdx === 2) {
        throw new Error("synthetic-write-failure");
      }
      await realAtomic(value);
    };

    // Three concurrent writes. The middle's rejection MUST NOT poison
    // the queue — first + third both apply, second's rejection bubbles
    // to its own awaiter.
    const a = svc.write({ codex: { pinnedPath: "/a" } });
    const b = svc.write({ ai: { enabled: true } });
    const c = svc.write({ codex: { profile: "/c-profile" } });

    const r1 = await a;
    await expect(b).rejects.toThrow("synthetic-write-failure");
    const r3 = await c;

    expect(r1.codex.pinnedPath).toBe("/a");
    // Third write builds on the first's committed state; the second
    // never landed, so ai.enabled stays at its default.
    expect(r3.codex.pinnedPath).toBe("/a");
    expect(r3.codex.profile).toBe("/c-profile");
    expect(r3.ai.enabled).toBe(false);

    // Queue isn't deadlocked — a fourth write resolves.
    const r4 = await svc.write({ general: { developerMode: true } });
    expect(r4.general.developerMode).toBe(true);
  });
});

function stubCodexDiscovery(codexDiscovery: typeof import("../codex-discovery")) {
  // Stub the discovery module so the snapshot is deterministic across
  // machines. We're testing the caching contract here, not Codex
  // discovery itself.
  const discoverSpy = vi
    .spyOn(codexDiscovery, "discoverCodexCommands")
    .mockImplementation(async ({ configuredCommand } = {}) => ({
      selectedCommand: configuredCommand ?? "codex",
      selectedSource: configuredCommand === undefined ? "path" : "config",
      candidates: [
        {
          command: configuredCommand ?? "codex",
          source: configuredCommand === undefined ? "path" : "config",
          executable: true,
          selected: true,
          version: "stub"
        }
      ]
    }));
  const authSpy = vi.spyOn(codexDiscovery, "probeCodexAuth").mockImplementation(async () => ({
    status: "authenticated",
    testedAt: "2026-05-19T12:00:00.000Z",
    durationMs: 1,
    detail: "Logged in using ChatGPT"
  }));
  return {
    discoverSpy,
    authSpy,
    restore: () => {
      discoverSpy.mockRestore();
      authSpy.mockRestore();
    }
  };
}

function makeStore(): DesktopSettingsStore {
  return new DesktopSettingsStore({ filePath: join(workDir, "settings.json") });
}

describe("DesktopSettingsStore.getCodexDiscoverySnapshot cache invalidation", () => {
  test("a codex.* write invalidates the snapshot cache so the next read reflects the new mode", async () => {
    const codexDiscovery = await import("../codex-discovery");
    const { discoverSpy, restore } = stubCodexDiscovery(codexDiscovery);

    try {
      const svc = makeStore();
      // Prime the cache against the default settings (mode=auto, no pin).
      const first = await svc.getCodexDiscoverySnapshot();
      // Resolution reuses the discovery snapshot — the resolved command
      // is the selected candidate ("codex" when no pin is set), and the
      // whole snapshot must cost exactly ONE discovery pass (it used to
      // call `resolveCodexCommand`, which re-ran a full second pass).
      expect(first.resolvedPath).toBe("codex");
      expect(first.auth?.status).toBe("authenticated");
      expect(discoverSpy).toHaveBeenCalledTimes(1);

      // Pin a path through the real write path.
      await svc.write({ codex: { mode: "pinned", pinnedPath: "/opt/codex-pinned" } });

      // Cache MUST have been invalidated — the next snapshot should
      // reflect the new pin, not the prior `codex` resolved path.
      const second = await svc.getCodexDiscoverySnapshot();
      expect(second.resolvedPath).toBe("/opt/codex-pinned");
      expect(discoverSpy).toHaveBeenCalledTimes(2);
    } finally {
      restore();
    }
  });

  test("a trusted peer snapshot invalidates discovery and resolves the relayed pin", async () => {
    const codexDiscovery = await import("../codex-discovery");
    const { discoverSpy, restore } = stubCodexDiscovery(codexDiscovery);

    try {
      const filePath = join(workDir, "settings.json");
      writeFileSync(filePath, JSON.stringify(defaultSettings()), "utf8");
      const svc = new DesktopSettingsStore({ filePath });
      expect((await svc.getCodexDiscoverySnapshot()).resolvedPath).toBe("codex");

      const external = mergeSettings(defaultSettings(), {
        codex: { mode: "pinned", pinnedPath: "/opt/external-codex" }
      });
      svc.adoptTrustedPeerSnapshot(external);

      expect((await svc.getCodexDiscoverySnapshot()).resolvedPath).toBe(
        "/opt/external-codex"
      );
      expect(discoverSpy).toHaveBeenCalledTimes(2);
    } finally {
      restore();
    }
  });

  test("concurrent non-forced snapshot reads coalesce onto one discovery pass", async () => {
    const codexDiscovery = await import("../codex-discovery");
    const { discoverSpy, restore } = stubCodexDiscovery(codexDiscovery);

    try {
      const svc = makeStore();
      // Fire three reads before any resolves — the Library, float-over,
      // and Settings windows all refresh on the same broadcast.
      const [a, b, c] = await Promise.all([
        svc.getCodexDiscoverySnapshot(),
        svc.getCodexDiscoverySnapshot(),
        svc.getCodexDiscoverySnapshot()
      ]);
      expect(discoverSpy).toHaveBeenCalledTimes(1);
      expect(a).toBe(b);
      expect(b).toBe(c);
    } finally {
      restore();
    }
  });

  test("a codex.* write during an in-flight snapshot keeps the stale result out of the cache", async () => {
    const codexDiscovery = await import("../codex-discovery");
    const { discoverSpy, restore } = stubCodexDiscovery(codexDiscovery);

    // Gate the first discovery so we can land a write mid-computation.
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    discoverSpy.mockImplementation(async ({ configuredCommand } = {}) => {
      call += 1;
      if (call === 1) await firstGate;
      const command = configuredCommand ?? "codex";
      return {
        selectedCommand: command,
        selectedSource: configuredCommand === undefined ? ("path" as const) : ("config" as const),
        candidates: [
          {
            command,
            source: configuredCommand === undefined ? ("path" as const) : ("config" as const),
            executable: true,
            selected: true,
            version: "stub"
          }
        ]
      };
    });

    try {
      const svc = makeStore();
      const inflight = svc.getCodexDiscoverySnapshot();
      // The write invalidates while the first computation is parked.
      await svc.write({ codex: { mode: "pinned", pinnedPath: "/opt/codex-pinned" } });
      releaseFirst();
      // A stale completion cannot publish over the newer settings
      // fingerprint. The original caller is advanced to the current
      // publication, and the next read reuses it.
      const current = await inflight;
      expect(current.resolvedPath).toBe("/opt/codex-pinned");
      const fresh = await svc.getCodexDiscoverySnapshot();
      expect(fresh.resolvedPath).toBe("/opt/codex-pinned");
    } finally {
      restore();
    }
  });
});

describe("DesktopSettingsStore.testCodexForUserRequest", () => {
  test("unset when no Codex binary resolves", async () => {
    const svc = new DesktopSettingsStore({
      filePath: join(workDir, "settings.json"),
      discoverCodex: async () => {
        throw new Error("no codex");
      }
    });
    const result = await svc.testCodexForUserRequest();
    expect(result.status).toBe("unset");
    expect(result.account).toBeNull();
    expect(result.testedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("mergeSettings", () => {
  test("undefined fields preserve current; defined fields overwrite", () => {
    const current = defaultSettings();
    const merged = mergeSettings(current, {
      codex: { pinnedPath: "/x" },
      hotkeys: { quickCapture: "" }
    });
    expect(merged.codex.pinnedPath).toBe("/x");
    expect(merged.codex.mode).toBe("auto"); // preserved
    expect(merged.hotkeys.quickCapture).toBe(""); // "" IS a write
    // Region defaults to "" (unbound) now; preserved from `current`.
    expect(merged.hotkeys.region).toBe("");
    expect(merged.hotkeys.videoCapture).toBe(HOST_HOTKEY_DEFAULTS.videoCapture);
  });

  test("appearance.theme patch overwrites only the specified field", () => {
    const current = defaultSettings();
    expect(current.appearance.theme).toBe("system");
    const merged = mergeSettings(current, { appearance: { theme: "light" } });
    expect(merged.appearance.theme).toBe("light");
    // Other sections untouched.
    expect(merged.codex.mode).toBe(current.codex.mode);
  });

  test("library.gridZoom patch overwrites only that field and clamps to range", () => {
    const current = defaultSettings();
    expect(current.library.gridZoom).toBe(GRID_ZOOM_DEFAULT);
    const merged = mergeSettings(current, { library: { gridZoom: 280 } });
    expect(merged.library.gridZoom).toBe(280);
    // Sibling library fields preserved.
    expect(merged.library.confirmBeforeTrash).toBe(current.library.confirmBeforeTrash);
    expect(merged.library.detailRail).toEqual(current.library.detailRail);
    // Out-of-range patches clamp rather than corrupt the stored value.
    expect(mergeSettings(current, { library: { gridZoom: 9999 } }).library.gridZoom).toBe(
      GRID_ZOOM_MAX
    );
    expect(mergeSettings(current, { library: { gridZoom: 10 } }).library.gridZoom).toBe(
      GRID_ZOOM_MIN
    );
  });

  test("library.gridCopyPalette patch merges per-field and leaves siblings alone", () => {
    const current = defaultSettings();
    expect(current.library.gridCopyPalette).toEqual({
      anchor: "follow",
    });
    // A drag writes only `anchor`; the drawer's open/closed state must
    // survive (and vice versa) — hence mergeSection, not replacement.
    const dragged = mergeSettings(current, {
      library: { gridCopyPalette: { anchor: "pinned" } }
    });
    expect(dragged.library.gridCopyPalette).toEqual({
      anchor: "pinned",
    });
    // Sibling library fields preserved.
    expect(dragged.library.detailRail).toEqual(current.library.detailRail);
    expect(dragged.library.gridZoom).toBe(current.library.gridZoom);
  });

  test("library.editToolbarDock defaults to float and a patch moves only it", () => {
    const current = defaultSettings();
    expect(current.library.editToolbarDock).toBe("float");
    const docked = mergeSettings(current, { library: { editToolbarDock: "right" } });
    expect(docked.library.editToolbarDock).toBe("right");
    expect(docked.library.gridZoom).toBe(current.library.gridZoom);
    // A patch that does not name it leaves the dock where it was.
    expect(mergeSettings(docked, { library: { gridZoom: 280 } }).library.editToolbarDock).toBe(
      "right"
    );
  });

  test("storage.filenameTimestampZone patch overwrites only the specified field", () => {
    const current = defaultSettings();
    expect(current.storage.filenameTimestampZone).toBe("local");
    const merged = mergeSettings(current, {
      storage: { filenameTimestampZone: "utc" }
    });
    expect(merged.storage.filenameTimestampZone).toBe("utc");
    expect(merged.codex.mode).toBe(current.codex.mode);
  });

  test("ai.defaults patch merges one surface field-by-field without clobbering others", () => {
    const current = defaultSettings();
    const merged = mergeSettings(current, {
      ai: { defaults: { libraryChat: { model: "gpt-5.5", reasoning: "high" } } }
    });
    expect(merged.ai.defaults.libraryChat).toEqual({
      model: "gpt-5.5",
      reasoning: "high"
    });
    // Other surfaces untouched.
    expect(merged.ai.defaults.sizzleChat).toEqual({});
    expect(merged.ai.defaults.enrichment).toEqual({});
    // Other ai fields untouched.
    expect(merged.ai.enabled).toBe(current.ai.enabled);
  });

  test("ai.defaults patch with empty-string clears a previously-set leaf", () => {
    const current = {
      ...defaultSettings(),
      ai: {
        ...defaultSettings().ai,
        defaults: {
          libraryChat: { provider: "openai", model: "gpt-5.5", reasoning: "high" as const },
          sizzleChat: {},
          enrichment: {}
        }
      }
    };
    const merged = mergeSettings(current, {
      ai: { defaults: { libraryChat: { provider: "", reasoning: "" } } }
    });
    // provider + reasoning cleared; model preserved (undefined = leave alone).
    expect(merged.ai.defaults.libraryChat).toEqual({ model: "gpt-5.5" });
  });
});

describe("DesktopSettingsService.appearance defaulting", () => {
  test("v1 file written before `appearance` landed gets the default filled in", async () => {
    // Older PwrSnap installs wrote settings without `appearance`. The
    // in-memory shape must always have it; the next write rewrites
    // the file with the field present.
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        codex: { mode: "auto", pinnedPath: "", profile: "" }
      }),
      "utf8"
    );
    const svc = new DesktopSettingsService({ filePath });
    const settings = await svc.read();
    expect(settings.appearance.theme).toBe("system");
  });

  test("invalid theme value on disk falls back to the default", async () => {
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        appearance: { theme: "neon" }
      }),
      "utf8"
    );
    const svc = new DesktopSettingsService({ filePath });
    const settings = await svc.read();
    expect(settings.appearance.theme).toBe("system");
  });

  test("write({ appearance: { theme: \"dark\" } }) persists and round-trips", async () => {
    const svc = makeService();
    const written = await svc.write({ appearance: { theme: "dark" } });
    expect(written.appearance.theme).toBe("dark");
    const reread = await svc.read();
    expect(reread.appearance.theme).toBe("dark");
  });
});

describe("DesktopSettingsService.storage", () => {
  test("v1 file written before `storage` landed gets additive storage defaults", async () => {
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        codex: { mode: "auto", pinnedPath: "", profile: "" }
      }),
      "utf8"
    );
    const svc = new DesktopSettingsService({ filePath });
    const settings = await svc.read();
    expect(settings.storage.filenameTimestampZone).toBe("local");
    expect(settings.storage.capturesLocation).toBe("documents");
  });

  test("invalid filename timestamp zone on disk falls back to local", async () => {
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        storage: { filenameTimestampZone: "mars" }
      }),
      "utf8"
    );
    const svc = new DesktopSettingsService({ filePath });
    const settings = await svc.read();
    expect(settings.storage.filenameTimestampZone).toBe("local");
  });

  test("write({ storage: { filenameTimestampZone: \"utc\" } }) persists and round-trips", async () => {
    const svc = makeService();
    const written = await svc.write({ storage: { filenameTimestampZone: "utc" } });
    expect(written.storage.filenameTimestampZone).toBe("utc");
    const reread = await svc.read();
    expect(reread.storage.filenameTimestampZone).toBe("utc");
  });

  test("home captures location persists and invalid on-disk values fall back", async () => {
    const svc = makeService();
    const written = await svc.write({ storage: { capturesLocation: "home" } });
    expect(written.storage.capturesLocation).toBe("home");
    expect((await svc.read()).storage.capturesLocation).toBe("home");

    const filePath = join(workDir, "invalid-location.json");
    writeFileSync(
      filePath,
      JSON.stringify({ schemaVersion: 1, storage: { capturesLocation: "desktop" } }),
      "utf8"
    );
    const invalid = await new DesktopSettingsService({ filePath }).read();
    expect(invalid.storage.capturesLocation).toBe("documents");
  });
});

describe("DesktopSettingsService.library.detailRail", () => {
  test("v1 file written before `library` landed gets the default filled in", async () => {
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        codex: { mode: "auto", pinnedPath: "", profile: "" }
      }),
      "utf8"
    );
    const svc = new DesktopSettingsService({ filePath });
    const settings = await svc.read();
    expect(settings.library.detailRail.pinned).toBe(true);
    expect(settings.library.detailRail.lastSelectedTab).toBe("info");
  });

  test("invalid lastSelectedTab on disk falls back to the default", async () => {
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        library: { detailRail: { pinned: false, lastSelectedTab: "magic" } }
      }),
      "utf8"
    );
    const svc = new DesktopSettingsService({ filePath });
    const settings = await svc.read();
    expect(settings.library.detailRail.pinned).toBe(false);
    expect(settings.library.detailRail.lastSelectedTab).toBe("info");
  });

  test("write({ library: { detailRail: { lastSelectedTab: \"properties\" } } }) round-trips", async () => {
    const svc = makeService();
    const written = await svc.write({
      library: { detailRail: { lastSelectedTab: "properties" } }
    });
    expect(written.library.detailRail.lastSelectedTab).toBe("properties");
    // Pinned untouched — keep the prior value.
    expect(written.library.detailRail.pinned).toBe(true);
    const reread = await svc.read();
    expect(reread.library.detailRail.lastSelectedTab).toBe("properties");
  });

  test("write({ library: { detailRail: { pinned: false } } }) does not stomp the tab", async () => {
    const svc = makeService();
    await svc.write({ library: { detailRail: { lastSelectedTab: "chat" } } });
    const written = await svc.write({
      library: { detailRail: { pinned: false } }
    });
    expect(written.library.detailRail.pinned).toBe(false);
    expect(written.library.detailRail.lastSelectedTab).toBe("chat");
  });
});

describe("DesktopSettingsService.library.confirmBeforeTrash", () => {
  test("defaults to true when absent on disk", async () => {
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        library: { detailRail: { pinned: true, lastSelectedTab: "info" } }
      }),
      "utf8"
    );
    const svc = new DesktopSettingsService({ filePath });
    const settings = await svc.read();
    expect(settings.library.confirmBeforeTrash).toBe(true);
  });

  test("a malformed detailRail still preserves confirmBeforeTrash", async () => {
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        library: { detailRail: 42, confirmBeforeTrash: false }
      }),
      "utf8"
    );
    const svc = new DesktopSettingsService({ filePath });
    const settings = await svc.read();
    expect(settings.library.confirmBeforeTrash).toBe(false);
    // detailRail fell back to the default.
    expect(settings.library.detailRail.pinned).toBe(true);
  });

  test("write({ library: { confirmBeforeTrash: false } }) round-trips without stomping detailRail", async () => {
    const svc = makeService();
    await svc.write({ library: { detailRail: { lastSelectedTab: "chat" } } });
    const written = await svc.write({
      library: { confirmBeforeTrash: false }
    });
    expect(written.library.confirmBeforeTrash).toBe(false);
    expect(written.library.detailRail.lastSelectedTab).toBe("chat");
    const reread = await svc.read();
    expect(reread.library.confirmBeforeTrash).toBe(false);
  });
});

describe("DesktopSettingsService updates train/track", () => {
  test("defaults the update selection from the running app version", async () => {
    const svc = makeService();
    const initial = await svc.read();
    expect(initial.updates).toEqual({
      channel: "latest",
      train: "stable",
      selectionSource: "inferred"
    });

    await svc.write({ updates: { channel: "prerelease", train: "beta" } });
    expect(JSON.parse(readFileSync(join(workDir, "settings.json"), "utf8")).updates).toEqual({
      channel: "prerelease",
      train: "beta",
      selectionSource: "user"
    });
    expect((await svc.read()).updates).toEqual({
      channel: "prerelease",
      train: "beta",
      selectionSource: "user"
    });

    await svc.write({ updates: { channel: "latest", train: "stable" } });
    expect(JSON.parse(readFileSync(join(workDir, "settings.json"), "utf8")).updates).toEqual({
      channel: "latest",
      train: "stable",
      selectionSource: "user"
    });
    expect((await svc.read()).updates).toEqual({
      channel: "latest",
      train: "stable",
      selectionSource: "user"
    });
  });

  test("infers Beta Prerelease from an alpha desktop version when both keys are absent", async () => {
    const svc = new DesktopSettingsService({
      filePath: join(workDir, "settings.json"),
      appVersion: "1.1.0-alpha.7"
    });
    expect((await svc.read()).updates).toEqual({
      channel: "prerelease",
      train: "beta",
      selectionSource: "inferred"
    });
  });

  // The bug this replaced: a pre-`train` settings file carrying only
  // `channel` read as a deliberate Stable pin, so a 1.1.0-alpha install
  // was offered v1.0.3 and never told about the newer alpha it came from.
  // A half pair proves nothing about intent, so the binary decides.
  test("re-infers a legacy half-written config from the running binary", async () => {
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({ schemaVersion: 1, updates: { channel: "prerelease" } }),
      "utf8"
    );
    const svc = new DesktopSettingsService({
      filePath,
      appVersion: "1.1.0-beta.2"
    });
    expect((await svc.read()).updates).toEqual({
      channel: "latest",
      train: "beta",
      selectionSource: "inferred"
    });
  });

  test("moves a legacy Stable/Latest config onto the alpha feed it is running", async () => {
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({ schemaVersion: 1, updates: { channel: "latest", train: "stable" } }),
      "utf8"
    );
    const svc = new DesktopSettingsService({
      filePath,
      appVersion: "1.1.0-alpha.4"
    });
    expect((await svc.read()).updates).toEqual({
      channel: "prerelease",
      train: "beta",
      selectionSource: "inferred"
    });
  });

  // Any non-default pair on a pre-`selectionSource` file could only have
  // come from a click or the old seeding path — both mean "leave it".
  test("treats a legacy non-default pair as an existing pin", async () => {
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({ schemaVersion: 1, updates: { channel: "latest", train: "beta" } }),
      "utf8"
    );
    const svc = new DesktopSettingsService({
      filePath,
      appVersion: "1.0.3"
    });
    expect((await svc.read()).updates).toEqual({
      channel: "latest",
      train: "beta",
      selectionSource: "user"
    });
  });

  test("keeps an explicit Stable choice on a Beta binary", async () => {
    const filePath = join(workDir, "settings.json");
    const svc = new DesktopSettingsService({
      filePath,
      appVersion: "1.1.0-beta.2"
    });
    expect((await svc.read()).updates.train).toBe("beta");
    await svc.write({ updates: { train: "stable", channel: "latest" } });
    expect((await svc.read()).updates).toEqual({
      channel: "latest",
      train: "stable",
      selectionSource: "user"
    });
    expect(JSON.parse(readFileSync(filePath, "utf8")).updates).toEqual({
      channel: "latest",
      train: "stable",
      selectionSource: "user"
    });

    // And the pin survives a fresh process on the same alpha/beta binary —
    // without `selectionSource` this is exactly the read that would undo it.
    const reopened = new DesktopSettingsService({ filePath, appVersion: "1.1.0-beta.2" });
    expect((await reopened.read()).updates).toEqual({
      channel: "latest",
      train: "stable",
      selectionSource: "user"
    });
  });

  // A pin whose file lost one axis (truncated write, hand edit with a typo)
  // must keep the axis that survived AND stay pinned — re-inferring the pair
  // would silently move a deliberate Stable pin onto the alpha feed.
  test("keeps a pin whose stored pair lost one axis", async () => {
    const filePath = join(workDir, "settings.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        updates: { train: "stable", channel: "lates", selectionSource: "user" }
      }),
      "utf8"
    );
    const svc = new DesktopSettingsService({ filePath, appVersion: "1.1.0-alpha.4" });
    expect((await svc.read()).updates).toEqual({
      channel: "latest",
      train: "stable",
      selectionSource: "user"
    });
  });

  test("a patch naming only one axis still pins the pair", async () => {
    const filePath = join(workDir, "settings.json");
    const svc = new DesktopSettingsService({ filePath, appVersion: "1.1.0-alpha.4" });
    await svc.write({ updates: { train: "stable" } });
    expect((await svc.read()).updates).toEqual({
      channel: "prerelease",
      train: "stable",
      selectionSource: "user"
    });
  });
});

describe("DesktopSettingsService — the Draw tool family", () => {
  test("a settings file from before Draw existed reads the factory Draw style", async () => {
    const filePath = join(workDir, "settings.json");
    const raw = defaultSettings();
    delete (raw.editor.toolStyles as Partial<Settings["editor"]["toolStyles"]>).draw;
    writeFileSync(filePath, JSON.stringify(raw), "utf8");
    const settings = await new DesktopSettingsService({ filePath }).read();
    expect(settings.editor.toolStyles.draw).toEqual({
      mode: "pen",
      color: "accent",
      thickness: "auto"
    });
  });

  test("a Draw slot round-trips, and an eraser slot (a hand edit) reads as a pen of the same color", async () => {
    const filePath = join(workDir, "settings.json");
    const raw = defaultSettings();
    raw.editor.toolBag.slots[8] = {
      tool: "draw",
      style: { mode: "marker", color: "yellow", thickness: "large" }
    };
    raw.editor.toolBag.slots[7] = {
      tool: "draw",
      style: { mode: "eraser", color: "green", thickness: "small" }
    };
    writeFileSync(filePath, JSON.stringify(raw), "utf8");
    const settings = await new DesktopSettingsService({ filePath }).read();
    expect(settings.editor.toolBag.slots[8]).toEqual({
      tool: "draw",
      style: { mode: "marker", color: "yellow", thickness: "large" }
    });
    expect(settings.editor.toolBag.slots[7]).toEqual({
      tool: "draw",
      style: { mode: "pen", color: "green", thickness: "small" }
    });
  });

  test("a slot naming a tool this build does not know reads as empty — what a pre-Draw build does with a Draw slot", async () => {
    const filePath = join(workDir, "settings.json");
    const raw = defaultSettings() as unknown as { editor: { toolBag: { slots: unknown[] } } };
    raw.editor.toolBag.slots[8] = { tool: "lasso", style: { color: "red" } };
    writeFileSync(filePath, JSON.stringify(raw), "utf8");
    const settings = await new DesktopSettingsService({ filePath }).read();
    expect(settings.editor.toolBag.slots[8]).toBeNull();
  });

  test("an unrelated write keeps a bag slot this build cannot read; only a bag edit replaces it", async () => {
    // This is the forward-compat half of the older-build note in
    // docs/architecture.md: the raw slots array survives untouched
    // until the bag itself is written.
    const filePath = join(workDir, "settings.json");
    const raw = defaultSettings() as unknown as { editor: { toolBag: { slots: unknown[] } } };
    const future = { tool: "lasso", style: { color: "red" } };
    raw.editor.toolBag.slots[8] = future;
    writeFileSync(filePath, JSON.stringify(raw), "utf8");
    const svc = new DesktopSettingsService({ filePath });
    await svc.write({ general: { developerMode: true } });
    expect(JSON.parse(readFileSync(filePath, "utf8")).editor.toolBag.slots[8]).toEqual(future);
  });
});
