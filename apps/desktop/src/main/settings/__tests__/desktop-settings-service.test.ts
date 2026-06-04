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

import { DEFAULT_HOTKEYS } from "@pwrsnap/shared";
import {
  DesktopSettingsService,
  defaultSettings,
  mergeSettings
} from "../desktop-settings-service";

let workDir = "";

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
});

describe("DesktopSettingsService.write", () => {
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
    expect(read.hotkeys.quickCapture).toBe("CommandOrControl+Shift+C");
    // Region / window default UNBOUND now that Quick Capture covers both.
    expect(read.hotkeys.region).toBe("");
    expect(read.hotkeys.window).toBe("");
    // Video Capture is the new entry; default ⌘⇧V.
    expect(read.hotkeys.videoCapture).toBe("CommandOrControl+Alt+C");
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
    expect(settings.hotkeys.quickCapture).toBe("CommandOrControl+Shift+C"); // filled
    // videoCapture wasn't in the older v1 shape — service fills it.
    expect(settings.hotkeys.videoCapture).toBe("CommandOrControl+Alt+C");
  });

  test("v1 shape missing the newer hotkeys gets the defaults filled in", async () => {
    // Older PwrSnap installs wrote `hotkeys` without `videoCapture` /
    // `fullScreen` / `allScreens` / `timed` / `reshowFloatOver`.
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
    expect(settings.hotkeys.videoCapture).toBe("CommandOrControl+Alt+C");
    expect(settings.hotkeys.quickCapture).toBe("CommandOrControl+Shift+C");
    // Capture-mode hotkeys are unbound by default (also tray-reachable).
    expect(settings.hotkeys.fullScreen).toBe("");
    expect(settings.hotkeys.allScreens).toBe("");
    expect(settings.hotkeys.timed).toBe("");
    // Re-show last Float-Over defaults to the three-modifier ⌘⌥⇧F chord.
    expect(settings.hotkeys.reshowFloatOver).toBe("CommandOrControl+Alt+Shift+F");
  });

  test("defaultSettings() seeds hotkeys from the shared DEFAULT_HOTKEYS", () => {
    // Lock the renderer/main shared source: the Hotkeys page's "Reset to
    // defaults" reads the same object, so a drift here would silently
    // make Reset write a different chord than a fresh install.
    expect(defaultSettings().hotkeys).toEqual(DEFAULT_HOTKEYS);
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
    expect(settings.codex.captionModel).toBe("gpt-5.4-mini");
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

describe("DesktopSettingsService.getCodexDiscoverySnapshot cache invalidation", () => {
  test("a codex.* write invalidates the snapshot cache so the next read reflects the new mode", async () => {
    // Stub the discovery + resolve modules so the snapshot is
    // deterministic across machines. We're testing the cache
    // invalidation contract here, not Codex discovery itself.
    const codexDiscovery = await import("../codex-discovery");
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
    const resolveSpy = vi
      .spyOn(codexDiscovery, "resolveCodexCommand")
      .mockImplementation(async ({ command }) => ({
        command,
        source: "config" as const,
        version: "stub"
      }));
    const authSpy = vi
      .spyOn(codexDiscovery, "probeCodexAuth")
      .mockImplementation(async () => ({
        status: "authenticated",
        testedAt: "2026-05-19T12:00:00.000Z",
        durationMs: 1,
        detail: "Logged in using ChatGPT"
      }));

    try {
      const svc = makeService();
      // Prime the cache against the default settings (mode=auto, no pin).
      const first = await svc.getCodexDiscoverySnapshot();
      // `resolveCodexCommand` is called with "codex" when no pin is set.
      expect(first.resolvedPath).toBe("codex");
      expect(first.auth?.status).toBe("authenticated");

      // Pin a path through the real write path.
      await svc.write({ codex: { mode: "pinned", pinnedPath: "/opt/codex-pinned" } });

      // Cache MUST have been invalidated — the next snapshot should
      // reflect the new pin, not the prior `codex` resolved path.
      const second = await svc.getCodexDiscoverySnapshot();
      expect(second.resolvedPath).toBe("/opt/codex-pinned");
    } finally {
      discoverSpy.mockRestore();
      resolveSpy.mockRestore();
      authSpy.mockRestore();
    }
  });
});

describe("DesktopSettingsService.testCodex", () => {
  test("unset when no Codex binary resolves", async () => {
    const codexDiscovery = await import("../codex-discovery");
    const resolveSpy = vi
      .spyOn(codexDiscovery, "resolveCodexCommand")
      .mockImplementation(async () => {
        throw new Error("no codex");
      });
    try {
      const svc = makeService();
      const result = await svc.testCodex();
      expect(result.status).toBe("unset");
      expect(result.account).toBeNull();
      expect(result.testedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      resolveSpy.mockRestore();
    }
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
    expect(merged.hotkeys.videoCapture).toBe("CommandOrControl+Alt+C");
  });

  test("appearance.theme patch overwrites only the specified field", () => {
    const current = defaultSettings();
    expect(current.appearance.theme).toBe("system");
    const merged = mergeSettings(current, { appearance: { theme: "light" } });
    expect(merged.appearance.theme).toBe("light");
    // Other sections untouched.
    expect(merged.codex.mode).toBe(current.codex.mode);
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

describe("DesktopSettingsService.storage filename timestamp zone", () => {
  test("v1 file written before `storage` landed gets local-time filename default", async () => {
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

  test("write({ library: { detailRail: { lastSelectedTab: \"ocr\" } } }) round-trips", async () => {
    const svc = makeService();
    const written = await svc.write({
      library: { detailRail: { lastSelectedTab: "ocr" } }
    });
    expect(written.library.detailRail.lastSelectedTab).toBe("ocr");
    // Pinned untouched — keep the prior value.
    expect(written.library.detailRail.pinned).toBe(true);
    const reread = await svc.read();
    expect(reread.library.detailRail.lastSelectedTab).toBe("ocr");
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
