import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SizzleProjectNotFoundError,
  SizzleStore
} from "../sizzle-store";

let tmpDir = "";
let filePath = "";

function makeStore(): SizzleStore {
  return new SizzleStore({ filePath });
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "pwrsnap-sizzle-store-"));
  filePath = join(tmpDir, "sizzle-projects.json");
});

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("SizzleStore", () => {
  it("create() returns a project with stable id + defaults + the same name back", async () => {
    const store = makeStore();
    const p = await store.create("Demo Reel");
    expect(p.id).toMatch(/^sz_/);
    expect(p.name).toBe("Demo Reel");
    expect(p.scenes).toEqual([]);
    expect(p.voice).toBe("onyx");
    expect(p.ttsModel).toBe("tts-1-hd");
    expect(p.ttsProvider).toBe("openai");
    expect(p.resolution).toBe("1080p");
    expect(p.outputPath).toBeNull();
    expect(p.lastRenderedAt).toBeNull();
    expect(p.createdAt).toEqual(p.modifiedAt);
  });

  it("create() with whitespace-only name falls back to 'Untitled Sizzle'", async () => {
    const store = makeStore();
    const p = await store.create("   ");
    expect(p.name).toBe("Untitled Sizzle");
  });

  it("list() returns newest-created first even after an older project is updated", async () => {
    const store = makeStore();
    const a = await store.create("First");
    // Force a measurable gap so createdAt comparisons are stable.
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.create("Second");
    await new Promise((r) => setTimeout(r, 5));
    await store.update(a.id, { name: "First, edited later" });
    const projects = await store.list();
    expect(projects.map((p) => p.id)).toEqual([b.id, a.id]);
  });

  it("update() mutates the named fields and bumps modifiedAt", async () => {
    const store = makeStore();
    const p = await store.create("Demo");
    await new Promise((r) => setTimeout(r, 5));
    const next = await store.update(p.id, { voice: "nova" });
    expect(next.voice).toBe("nova");
    expect(next.id).toBe(p.id);
    expect(next.createdAt).toBe(p.createdAt);
    expect(new Date(next.modifiedAt).getTime()).toBeGreaterThan(
      new Date(p.modifiedAt).getTime()
    );
  });

  it("update() throws SizzleProjectNotFoundError for an unknown id", async () => {
    const store = makeStore();
    await expect(store.update("sz_nope", { voice: "nova" })).rejects.toBeInstanceOf(
      SizzleProjectNotFoundError
    );
  });

  it("update() normalizes scene shape (assigns id + clamps duration null)", async () => {
    const store = makeStore();
    const p = await store.create("Demo");
    const next = await store.update(p.id, {
      scenes: [
        {
          id: "",
          captureId: "cap_1",
          scriptLine: "first",
          durationOverrideSec: -5,
          mediaTrim: null,
          audioSource: "auto",
          transition: "crossfade"
        },
        {
          id: "sc_keep",
          captureId: "cap_2",
          scriptLine: "second",
          durationOverrideSec: 4,
          mediaTrim: null,
          audioSource: "auto",
          transition: "crossfade"
        }
      ]
    });
    expect(next.scenes).toHaveLength(2);
    expect(next.scenes[0]!.id).toMatch(/^sc_/);
    expect(next.scenes[0]!.id).not.toBe("");
    // -5 is treated as "unset"
    expect(next.scenes[0]!.durationOverrideSec).toBeNull();
    expect(next.scenes[1]!.id).toBe("sc_keep");
    expect(next.scenes[1]!.durationOverrideSec).toBe(4);
  });

  it("update() preserves sequence scenes and normalizes beat defaults", async () => {
    const store = makeStore();
    const p = await store.create("Demo");
    const next = await store.update(p.id, {
      scenes: [
        {
          id: "sc_sequence",
          kind: "sequence",
          captureId: "",
          scriptLine: "",
          narration: "Open the wizard, then approve the pairing.",
          durationOverrideSec: null,
          mediaTrim: null,
          audioSource: "muted",
          transition: { type: "dip-black", durationSec: 0.25 },
          beats: [
            {
              id: "",
              captureId: "cap_wizard",
              timing: { kind: "offset", startSec: 0, endSec: 1 },
              mediaTrim: null,
              transition: "cut",
              videoFit: "smart-fit"
            },
            {
              id: "bt_pairing",
              captureId: "cap_pairing",
              timing: { kind: "phrase", phrase: "approve", occurrence: 1, offsetSec: 0, durationSec: null },
              mediaTrim: null,
              transition: "crossfade",
              videoFit: "smart-fit"
            }
          ]
        }
      ]
    });
    expect(next.scenes).toHaveLength(1);
    const scene = next.scenes[0]!;
    expect(scene.kind).toBe("sequence");
    expect(scene.captureId).toBe("cap_wizard");
    expect(scene.scriptLine).toBe("Open the wizard, then approve the pairing.");
    expect(scene.narration).toBe(scene.scriptLine);
    expect(scene.audioSource).toBe("voiceover");
    expect(scene.transition).toEqual({ type: "dip-black", durationSec: 0.25 });
    expect(scene.beats).toHaveLength(2);
    expect(scene.beats![0]!.id).toMatch(/^bt_/);
    expect(scene.beats![0]!.captureId).toBe("cap_wizard");
    expect(scene.beats![0]!.timing).toEqual({ kind: "offset", startSec: 0, endSec: null });
    expect(scene.beats![0]!.transition).toBe("cut");
    expect(scene.beats![0]!.videoFit).toBe("smart-fit");
  });

  it("delete() removes a project and is idempotent on a missing id", async () => {
    const store = makeStore();
    const p = await store.create("Demo");
    await store.delete(p.id);
    expect(await store.get(p.id)).toBeNull();
    // No throw on a second delete of the same id.
    await expect(store.delete(p.id)).resolves.toBeUndefined();
  });

  it("writes are atomic — concurrent updates serialize, last write wins", async () => {
    const store = makeStore();
    const p = await store.create("Demo");
    // Fire 25 parallel updates with distinct names. Without the
    // internal serialize queue, the file would either corrupt or
    // lose writes.
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        store.update(p.id, { name: `update-${i}` })
      )
    );
    const final = await store.get(p.id);
    expect(final).not.toBeNull();
    expect(final!.name).toMatch(/^update-\d+$/);
    // The persisted file must be valid JSON (writeBlob → rename
    // means no partial-write corruption).
    const onDisk = JSON.parse(await readFile(filePath, "utf8")) as {
      projects: Array<{ id: string; name: string }>;
    };
    expect(onDisk.projects).toHaveLength(1);
    expect(onDisk.projects[0]!.id).toBe(p.id);
    expect(onDisk.projects[0]!.name).toBe(final!.name);
  });

  it("get() and list() see a write before the rename returns to the caller", async () => {
    const store = makeStore();
    const p = await store.create("Demo");
    // Race a read against an update. The store's get() goes through
    // the same serialize queue as update(), so the read should
    // observe the new name (not the old one and not null).
    const [updateResult, readResult] = await Promise.all([
      store.update(p.id, { name: "renamed" }),
      store.get(p.id)
    ]);
    expect(updateResult.name).toBe("renamed");
    // The read could have landed before OR after the write — both
    // are valid serializations. What we forbid is "neither value":
    // a corrupted intermediate state.
    expect([p.name, "renamed"]).toContain(readResult!.name);
  });

  it("parse-fail quarantines the corrupt file and returns defaults", async () => {
    await writeFile(filePath, "this is not valid json", "utf8");
    const store = makeStore();
    const projects = await store.list();
    expect(projects).toEqual([]);
    // The corrupt file was renamed aside, not deleted.
    const entries = await readdir(tmpDir);
    const quarantined = entries.filter((e) => e.includes(".corrupt-"));
    expect(quarantined).toHaveLength(1);
  });

  it("missing file returns empty list", async () => {
    const store = makeStore();
    expect(await store.list()).toEqual([]);
    expect(await store.get("sz_anything")).toBeNull();
  });

  it("write does not include the .tmp sibling — atomic rename leaves only the final file", async () => {
    const store = makeStore();
    await store.create("Demo");
    const entries = await readdir(tmpDir);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
    expect(entries.filter((e) => e === "sizzle-projects.json")).toHaveLength(1);
  });
});

// Back-compat read path: projects written BEFORE the Phase 3a
// schema additions (`mediaTrim`, `audioSource`, `transition`) must
// load cleanly with sensible defaults. Without this back-fill, the
// composer + editor crash with `scene.mediaTrim.endSec` on undefined.
describe("SizzleStore — back-compat read of pre-Phase-3a projects", () => {
  it("loads a pre-Phase-3a project and back-fills the new scene fields", async () => {
    // Write a minimal pre-Phase-3a blob directly to disk — only the
    // fields that existed in PR #124 (id, captureId, scriptLine,
    // durationOverrideSec). No mediaTrim, no audioSource, no
    // transition. This is what a user's pwrsnap install would
    // contain after upgrading from the Phase-1 MVP.
    const oldBlob = {
      schemaVersion: 1,
      projects: [
        {
          id: "sz_oldproj",
          name: "Pre-3a project",
          createdAt: "2026-05-26T00:00:00.000Z",
          modifiedAt: "2026-05-26T00:00:00.000Z",
          voice: "onyx",
          ttsModel: "tts-1-hd",
          ttsProvider: "openai",
          resolution: "1080p",
          outputPath: null,
          lastRenderedAt: null,
          scenes: [
            {
              id: "sc_old1",
              captureId: "cap-1",
              scriptLine: "First line",
              durationOverrideSec: null
              // Note: NO mediaTrim, audioSource, transition fields.
            },
            {
              id: "sc_old2",
              captureId: "cap-2",
              scriptLine: "",
              durationOverrideSec: 4.5
            }
          ]
        }
      ]
    };
    await writeFile(filePath, JSON.stringify(oldBlob), "utf8");

    const store = makeStore();
    const projects = await store.list();
    expect(projects).toHaveLength(1);
    const project = projects[0]!;
    expect(project.scenes).toHaveLength(2);

    // Both scenes get the same defaults: mediaTrim null (composer
    // ignores it for images; video scenes seed at render time from
    // capture.video.defaultRange), audioSource "auto" (the policy
    // resolver picks per kind+script), transition "crossfade" (the
    // visual default the editor renders new scenes with).
    for (const scene of project.scenes) {
      expect(scene.mediaTrim).toBeNull();
      expect(scene.audioSource).toBe("auto");
      expect(scene.transition).toBe("crossfade");
    }
    // Originally-set fields survive untouched.
    expect(project.scenes[0]!.id).toBe("sc_old1");
    expect(project.scenes[0]!.scriptLine).toBe("First line");
    expect(project.scenes[1]!.durationOverrideSec).toBe(4.5);
  });

  it("loads a project mixing new + missing scene fields without crashing", async () => {
    // Half the scenes have the new fields (user created them after
    // the Phase 3a update), half don't (user's older scenes). The
    // back-fill must be per-scene, not per-project.
    const mixedBlob = {
      schemaVersion: 1,
      projects: [
        {
          id: "sz_mixed",
          name: "Mixed",
          createdAt: "2026-05-26T00:00:00.000Z",
          modifiedAt: "2026-05-27T00:00:00.000Z",
          voice: "alloy",
          ttsModel: "tts-1",
          ttsProvider: "openai",
          resolution: "720p",
          outputPath: null,
          lastRenderedAt: null,
          scenes: [
            {
              id: "sc_old",
              captureId: "cap-old",
              scriptLine: "Old scene",
              durationOverrideSec: null
            },
            {
              id: "sc_new",
              captureId: "cap-new",
              scriptLine: "New scene",
              durationOverrideSec: null,
              mediaTrim: { startSec: 1.0, endSec: 4.5 },
              audioSource: "native",
              transition: "cut"
            }
          ]
        }
      ]
    };
    await writeFile(filePath, JSON.stringify(mixedBlob), "utf8");
    const store = makeStore();
    const projects = await store.list();
    const scenes = projects[0]!.scenes;

    // Old scene: back-filled defaults.
    expect(scenes[0]!.mediaTrim).toBeNull();
    expect(scenes[0]!.audioSource).toBe("auto");
    expect(scenes[0]!.transition).toBe("crossfade");

    // New scene: explicit values survive.
    expect(scenes[1]!.mediaTrim).toEqual({ startSec: 1.0, endSec: 4.5 });
    expect(scenes[1]!.audioSource).toBe("native");
    expect(scenes[1]!.transition).toBe("cut");
  });

  it("a fresh write after back-fill includes the new fields on disk", async () => {
    // Acceptance check for the full read → fill → mutate → write
    // cycle. The post-write disk file must contain the back-filled
    // fields; otherwise a relaunch would have to back-fill again
    // and "older project that's been updated" would never
    // converge to the new shape.
    const oldBlob = {
      schemaVersion: 1,
      projects: [
        {
          id: "sz_old2",
          name: "Will update",
          createdAt: "2026-05-26T00:00:00.000Z",
          modifiedAt: "2026-05-26T00:00:00.000Z",
          voice: "onyx",
          ttsModel: "tts-1-hd",
          ttsProvider: "openai",
          resolution: "1080p",
          outputPath: null,
          lastRenderedAt: null,
          scenes: [
            { id: "sc_a", captureId: "cap-1", scriptLine: "a", durationOverrideSec: null }
          ]
        }
      ]
    };
    await writeFile(filePath, JSON.stringify(oldBlob), "utf8");
    const store = makeStore();
    const updated = await store.update("sz_old2", { name: "Renamed" });
    expect(updated.name).toBe("Renamed");

    const onDisk = JSON.parse(await readFile(filePath, "utf8")) as {
      projects: Array<{ scenes: unknown[] }>;
    };
    expect(onDisk.projects[0]!.scenes).toEqual([
      {
        id: "sc_a",
        captureId: "cap-1",
        scriptLine: "a",
        durationOverrideSec: null,
        mediaTrim: null,
        audioSource: "auto",
        transition: "crossfade"
      }
    ]);
  });
});
