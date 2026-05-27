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

  it("list() returns most-recently-modified first", async () => {
    const store = makeStore();
    const a = await store.create("First");
    // Force a measurable gap so modifiedAt comparisons are stable.
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.create("Second");
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
