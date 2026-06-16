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
  GRID_ZOOM_MIN
} from "@pwrsnap/shared";
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

  test("defaultSettings() seeds recording cursor capture ON for both modes", () => {
    const d = defaultSettings();
    expect(d.recording.videoCaptureCursor).toBe(true);
    expect(d.recording.imageCaptureCursor).toBe(true);
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

  test("v1 shape missing `ai.defaults` gets empty per-surface defaults filled in", async () => {
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
    // Enrichment model is seeded from the legacy captionModel for
    // back-compat (existing enrichment model selection is preserved).
    expect(settings.ai.defaults.enrichment.model).toBe("gpt-5.4-mini");
  });

  test("v1 shape seeds `ai.defaults.enrichment.model` from a newer captionModel", async () => {
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
    expect(settings.ai.defaults.enrichment.model).toBe("gpt-5.5");
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

  test("an explicit ACP enrichment model is preserved (not overridden by the seed)", async () => {
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
            // Explicit enrichment model wins over the captionModel seed.
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
            // Empty / whitespace strings and a bad reasoning value are
            // dropped so the in-memory shape omits them (= Codex default).
            libraryChat: { provider: "  ", model: "", reasoning: "ultra" }
          }
        }
      }),
      "utf8"
    );
    const svc = new DesktopSettingsService({ filePath });
    const settings = await svc.read();
    expect(settings.ai.defaults.libraryChat).toEqual({});
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
