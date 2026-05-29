// Unit tests for ChatThreadStore. Each test scopes itself to a fresh
// mkdtemp() directory and cleans it up in afterEach, so the file-system
// invariants (atomic rename, serialized writes, quarantine on corruption,
// the .metadata_never_index sentinel) are asserted against a real fs
// without touching the user's ~/Documents.

import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatThreadStore, slugifyThreadName } from "../chat-thread-store";

let pwrsnapRoot = "";
let chatsDir = "";

beforeEach(async () => {
  // Mirror the real layout: <root>/Chats is chatsDir; the sentinel lands
  // at <root>/.metadata_never_index.
  pwrsnapRoot = await mkdtemp(join(tmpdir(), "pwrsnap-chat-store-"));
  chatsDir = join(pwrsnapRoot, "Chats");
});

afterEach(async () => {
  await rm(pwrsnapRoot, { force: true, recursive: true });
});

function makeStore(): ChatThreadStore {
  return new ChatThreadStore({ chatsDir });
}

/** Locate the on-disk sidecar path for a threadId by scanning the dirs. */
async function findSidecarPath(threadId: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(chatsDir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const sidecarPath = join(chatsDir, entry, "pwrsnap-thread.json");
    try {
      const parsed = JSON.parse(await readFile(sidecarPath, "utf8")) as { threadId?: string };
      if (parsed.threadId === threadId) return sidecarPath;
    } catch {
      /* skip */
    }
  }
  return null;
}

describe("slugifyThreadName", () => {
  it("kebab-cases ascii and caps length", () => {
    expect(slugifyThreadName("My Cool Thread!")).toBe("my-cool-thread");
    expect(slugifyThreadName("  spaced  out  ")).toBe("spaced-out");
    const long = slugifyThreadName("a".repeat(80));
    expect(long.length).toBeLessThanOrEqual(40);
  });

  it("falls back to 'thread' when no usable ascii remains", () => {
    expect(slugifyThreadName("🎉🎉🎉")).toBe("thread");
    expect(slugifyThreadName("")).toBe("thread");
  });
});

describe("ChatThreadStore.create / get", () => {
  it("round-trips a created thread and writes the sidecar file", async () => {
    const store = makeStore();
    const created = await store.create({ threadId: "thread-abc", name: "First Thread" });

    expect(created.threadId).toBe("thread-abc");
    expect(created.name).toBe("First Thread");
    expect(created.schemaVersion).toBe(1);
    expect(created.anchorCaptureId).toBeNull();
    expect(created.focusHistory).toEqual([]);
    expect(created.archived).toBe(false);
    expect(created.pinned).toBe(false);

    const got = await store.get("thread-abc");
    expect(got).not.toBeNull();
    expect(got?.threadId).toBe("thread-abc");
    expect(got?.name).toBe("First Thread");

    // The sidecar file exists and lives in a YYYY-MM-DD-NNN-<slug> dir.
    const sidecarPath = await findSidecarPath("thread-abc");
    expect(sidecarPath).not.toBeNull();
    const dirName = sidecarPath === null ? "" : dirname(sidecarPath).split("/").pop();
    expect(dirName).toMatch(/^\d{4}-\d{2}-\d{2}-\d{3}-first-thread$/);

    // attachments dir exists.
    const attachments = join(dirname(sidecarPath as string), "attachments");
    const attachmentsStat = await stat(attachments);
    expect(attachmentsStat.isDirectory()).toBe(true);
  });

  it("drops the .metadata_never_index sentinel one level above chatsDir", async () => {
    const store = makeStore();
    await store.create({ threadId: "t1", name: "Sentinel Thread" });

    const sentinel = join(pwrsnapRoot, ".metadata_never_index");
    const sentinelStat = await stat(sentinel);
    expect(sentinelStat.isFile()).toBe(true);
    // Sentinel is empty.
    expect(await readFile(sentinel, "utf8")).toBe("");

    // Idempotent: a second create() doesn't error and doesn't grow it.
    await store.create({ threadId: "t2", name: "Second" });
    expect(await readFile(sentinel, "utf8")).toBe("");
  });

  it("mints distinct per-day sequence dirs for same-named threads", async () => {
    const store = makeStore();
    await store.create({ threadId: "t1", name: "Dup Name" });
    await store.create({ threadId: "t2", name: "Dup Name" });

    const entries = (await readdir(chatsDir)).filter((e) => e.includes("dup-name"));
    expect(entries.length).toBe(2);
    // Sequence numbers differ.
    const seqs = entries.map((e) => e.match(/^\d{4}-\d{2}-\d{2}-(\d{3})-/)?.[1]).sort();
    expect(seqs[0]).not.toBe(seqs[1]);
  });

  it("returns null for an unknown thread", async () => {
    const store = makeStore();
    expect(await store.get("nope")).toBeNull();
  });
});

describe("ChatThreadStore.update", () => {
  it("patches mutable fields and bumps modifiedAt", async () => {
    const store = makeStore();
    const created = await store.create({ threadId: "t1", name: "Original" });
    // Force a measurable time delta so modifiedAt strictly increases.
    await new Promise((r) => setTimeout(r, 5));

    const updated = await store.update("t1", { name: "Renamed", pinned: true });
    expect(updated.name).toBe("Renamed");
    expect(updated.pinned).toBe(true);
    expect(updated.archived).toBe(false);
    expect(updated.modifiedAt >= created.modifiedAt).toBe(true);

    const got = await store.get("t1");
    expect(got?.name).toBe("Renamed");
    expect(got?.pinned).toBe(true);
  });

  it("serializes two concurrent update() calls without a lost write", async () => {
    const store = makeStore();
    await store.create({ threadId: "t1", name: "Concurrent" });

    // Fire both without awaiting between them. The serialized write queue
    // must apply both — the second update reads the first's result, so the
    // final sidecar reflects BOTH the rename and the archive flag.
    const [a, b] = await Promise.all([
      store.update("t1", { name: "Updated Name" }),
      store.update("t1", { archived: true })
    ]);

    // Both calls resolve with valid sidecars (whichever ran second sees the
    // other's write merged in).
    expect(a.threadId).toBe("t1");
    expect(b.threadId).toBe("t1");

    const final = await store.get("t1");
    expect(final).not.toBeNull();
    // No lost write: the final on-disk state carries BOTH mutations.
    expect(final?.name).toBe("Updated Name");
    expect(final?.archived).toBe(true);
  });

  it("throws on update of an unknown thread", async () => {
    const store = makeStore();
    await expect(store.update("missing", { pinned: true })).rejects.toThrow();
  });
});

describe("ChatThreadStore corrupt handling", () => {
  it("list() skips a corrupt sidecar and quarantines it; get() returns null", async () => {
    const store = makeStore();
    await store.create({ threadId: "good", name: "Good Thread" });
    await store.create({ threadId: "bad", name: "Bad Thread" });

    // Corrupt the "bad" sidecar by overwriting it with garbage.
    const badPath = await findSidecarPath("bad");
    expect(badPath).not.toBeNull();
    await writeFile(badPath as string, "this is not json {[", "utf8");

    const listed = await store.list();
    expect(listed.map((s) => s.threadId)).toEqual(["good"]);

    // get() on the corrupt thread now returns null (it's been quarantined).
    expect(await store.get("bad")).toBeNull();

    // A quarantine file appeared in the bad thread's dir.
    const badDir = dirname(badPath as string);
    const badDirEntries = await readdir(badDir);
    const quarantine = badDirEntries.find((n) => n.includes(".corrupt-"));
    expect(quarantine).toBeDefined();
  });

  it("quarantines a schema-invalid (parseable JSON, wrong shape) sidecar", async () => {
    const store = makeStore();
    await store.create({ threadId: "shapey", name: "Shapey" });
    const path = await findSidecarPath("shapey");
    // Valid JSON, invalid schema (missing required threadId / wrong version).
    await writeFile(path as string, JSON.stringify({ schemaVersion: 99 }), "utf8");

    const listed = await store.list();
    expect(listed.map((s) => s.threadId)).not.toContain("shapey");
    const entries = await readdir(dirname(path as string));
    expect(entries.some((n) => n.includes(".corrupt-"))).toBe(true);
  });
});

describe("ChatThreadStore.appendFocus", () => {
  it("caps focusHistory at the 20 newest entries", async () => {
    const store = makeStore();
    await store.create({ threadId: "t1", name: "Focus" });

    for (let i = 0; i < 25; i += 1) {
      await store.appendFocus("t1", `capture-${i}`);
    }

    const got = await store.get("t1");
    expect(got?.focusHistory.length).toBe(20);
    // Newest kept: the last entry should be capture-24, the first capture-5.
    expect(got?.focusHistory[0]?.captureId).toBe("capture-5");
    expect(got?.focusHistory[19]?.captureId).toBe("capture-24");
    // Each entry carries an ISO timestamp.
    for (const entry of got?.focusHistory ?? []) {
      expect(() => new Date(entry.at).toISOString()).not.toThrow();
    }
  });
});

describe("ChatThreadStore.journalAppend", () => {
  it("writes valid JSONL — one parseable object per line", async () => {
    const store = makeStore();
    await store.create({ threadId: "t1", name: "Journal" });

    await store.journalAppend("t1", { turn: 1, role: "user" });
    await store.journalAppend("t1", { turn: 2, role: "assistant", nested: { ok: true } });
    await store.journalAppend("t1", { turn: 3 });

    const sidecarPath = await findSidecarPath("t1");
    const journalPath = join(dirname(sidecarPath as string), "pwrsnap-thread.journal.jsonl");
    const raw = await readFile(journalPath, "utf8");

    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(3);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed[0]).toEqual({ turn: 1, role: "user" });
    expect(parsed[1]).toEqual({ turn: 2, role: "assistant", nested: { ok: true } });
    expect(parsed[2]).toEqual({ turn: 3 });
  });
});

describe("ChatThreadStore.attachmentsDir", () => {
  it("returns the attachments path and creates it on demand", async () => {
    const store = makeStore();
    await store.create({ threadId: "t1", name: "Attach" });

    const dir = await store.attachmentsDir("t1");
    expect(dir.endsWith("attachments")).toBe(true);
    const dirStat = await stat(dir);
    expect(dirStat.isDirectory()).toBe(true);
  });
});
