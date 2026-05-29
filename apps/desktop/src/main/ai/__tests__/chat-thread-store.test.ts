// Unit tests for ChatThreadStore. The thread INDEX lives in SQLite (an
// in-memory DB per test, with all migrations applied); the journal +
// attachments live on disk under a fresh mkdtemp() Chats dir. So both
// halves of the store are exercised against real backends: the indexed
// metadata queries against SQLite, and the on-disk journal / attachments
// / sentinel against a real fs — without touching the user's ~/Documents
// or the app's real database.

import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatThreadSidecar } from "@pwrsnap/shared";
import { ChatThreadStore, slugifyThreadName } from "../chat-thread-store";

let pwrsnapRoot = "";
let chatsDir = "";
let db: Database.Database;

function applyAllMigrations(target: Database.Database): void {
  const dir = new URL("../../persistence/migrations/", import.meta.url);
  const files = readdirSync(dir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  target.pragma("foreign_keys = OFF");
  for (const file of files) {
    target.exec(readFileSync(new URL(file, dir), "utf8"));
  }
  target.pragma("foreign_keys = ON");
}

beforeEach(async () => {
  // Mirror the real layout: <root>/Chats is chatsDir; the sentinel lands
  // at <root>/.metadata_never_index.
  pwrsnapRoot = await mkdtemp(join(tmpdir(), "pwrsnap-chat-store-"));
  chatsDir = join(pwrsnapRoot, "Chats");
  db = new Database(":memory:");
  applyAllMigrations(db);
});

afterEach(async () => {
  db.close();
  await rm(pwrsnapRoot, { force: true, recursive: true });
});

function makeStore(): ChatThreadStore {
  return new ChatThreadStore({ chatsDir, db });
}

/** Read a thread's on-disk dir basename straight from the index. */
function dirNameOf(threadId: string): string | undefined {
  const row = db
    .prepare("SELECT dir_name FROM chat_threads WHERE thread_id = ?")
    .get(threadId) as { dir_name: string } | undefined;
  return row?.dir_name;
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
  it("round-trips a created thread via the index and mints its dir", async () => {
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

    // The on-disk dir is a YYYY-MM-DD-NNN-<slug> dir, recorded in the index.
    const dirName = dirNameOf("thread-abc");
    expect(dirName).toMatch(/^\d{4}-\d{2}-\d{2}-\d{3}-first-thread$/);

    // attachments dir exists on disk.
    const attachmentsStat = await stat(join(chatsDir, dirName as string, "attachments"));
    expect(attachmentsStat.isDirectory()).toBe(true);
  });

  it("writes the anchor in the SAME insert (one write, no follow-up update)", async () => {
    const store = makeStore();
    const created = await store.create({
      threadId: "anchored",
      name: "Anchored",
      anchorCaptureId: "cap-123"
    });
    expect(created.anchorCaptureId).toBe("cap-123");
    const got = await store.get("anchored");
    expect(got?.anchorCaptureId).toBe("cap-123");
  });

  it("drops the .metadata_never_index sentinel one level above chatsDir", async () => {
    const store = makeStore();
    await store.create({ threadId: "t1", name: "Sentinel Thread" });

    const sentinel = join(pwrsnapRoot, ".metadata_never_index");
    const sentinelStat = await stat(sentinel);
    expect(sentinelStat.isFile()).toBe(true);
    expect(await readFile(sentinel, "utf8")).toBe("");

    // Idempotent: a second create() doesn't error and doesn't grow it.
    await store.create({ threadId: "t2", name: "Second" });
    expect(await readFile(sentinel, "utf8")).toBe("");
  });

  it("mints distinct per-day sequence dirs for same-named threads", async () => {
    const store = makeStore();
    await store.create({ threadId: "t1", name: "Dup Name" });
    await store.create({ threadId: "t2", name: "Dup Name" });

    const d1 = dirNameOf("t1");
    const d2 = dirNameOf("t2");
    expect(d1).not.toBe(d2);
    const seq1 = d1?.match(/^\d{4}-\d{2}-\d{2}-(\d{3})-/)?.[1];
    const seq2 = d2?.match(/^\d{4}-\d{2}-\d{2}-(\d{3})-/)?.[1];
    expect(seq1).not.toBe(seq2);
  });

  it("returns null for an unknown thread", async () => {
    const store = makeStore();
    expect(await store.get("nope")).toBeNull();
  });
});

describe("ChatThreadStore.list", () => {
  it("returns threads newest-modified first and scopes by anchor", async () => {
    const store = makeStore();
    await store.create({ threadId: "lib", name: "Library-wide" }); // null anchor
    await store.create({ threadId: "a1", name: "Cap A one", anchorCaptureId: "cap-A" });
    await store.create({ threadId: "a2", name: "Cap A two", anchorCaptureId: "cap-A" });
    // Touch a1 so it sorts ahead of a2.
    await new Promise((r) => setTimeout(r, 5));
    await store.update("a1", { name: "Cap A one (renamed)" });

    // No anchor filter → every thread.
    const all = await store.list();
    expect(all.map((s) => s.threadId).sort()).toEqual(["a1", "a2", "lib"]);

    // Scoped to cap-A → only its two, newest-modified first (a1 was just touched).
    const scoped = await store.list({ anchorCaptureId: "cap-A" });
    expect(scoped.map((s) => s.threadId)).toEqual(["a1", "a2"]);

    // Explicit null → only the unanchored (library-wide) thread.
    const unanchored = await store.list({ anchorCaptureId: null });
    expect(unanchored.map((s) => s.threadId)).toEqual(["lib"]);
  });

  it("excludes archived threads unless includeArchived is set", async () => {
    const store = makeStore();
    await store.create({ threadId: "live", name: "Live" });
    await store.create({ threadId: "gone", name: "Gone" });
    await store.update("gone", { archived: true });

    expect((await store.list()).map((s) => s.threadId)).toEqual(["live"]);
    expect((await store.list({ includeArchived: true })).map((s) => s.threadId).sort()).toEqual([
      "gone",
      "live"
    ]);
  });
});

describe("ChatThreadStore.update", () => {
  it("patches mutable fields and bumps modifiedAt", async () => {
    const store = makeStore();
    const created = await store.create({ threadId: "t1", name: "Original" });
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

    // Fire both without awaiting between them. better-sqlite3 is
    // synchronous and each update() does its SELECT + UPDATE with no
    // await in between, so the second observes the first's write.
    const [a, b] = await Promise.all([
      store.update("t1", { name: "Updated Name" }),
      store.update("t1", { archived: true })
    ]);

    expect(a.threadId).toBe("t1");
    expect(b.threadId).toBe("t1");

    const final = await store.get("t1");
    expect(final).not.toBeNull();
    // No lost write: the final state carries BOTH mutations.
    expect(final?.name).toBe("Updated Name");
    expect(final?.archived).toBe(true);
  });

  it("throws on update of an unknown thread", async () => {
    const store = makeStore();
    await expect(store.update("missing", { pinned: true })).rejects.toThrow();
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
    for (const entry of got?.focusHistory ?? []) {
      expect(() => new Date(entry.at).toISOString()).not.toThrow();
    }
  });
});

describe("ChatThreadStore.journalAppend", () => {
  it("writes valid JSONL on disk — one parseable object per line", async () => {
    const store = makeStore();
    await store.create({ threadId: "t1", name: "Journal" });

    await store.journalAppend("t1", { turn: 1, role: "user" });
    await store.journalAppend("t1", { turn: 2, role: "assistant", nested: { ok: true } });
    await store.journalAppend("t1", { turn: 3 });

    const journalPath = join(chatsDir, dirNameOf("t1") as string, "pwrsnap-thread.journal.jsonl");
    const raw = await readFile(journalPath, "utf8");

    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(3);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed[0]).toEqual({ turn: 1, role: "user" });
    expect(parsed[1]).toEqual({ turn: 2, role: "assistant", nested: { ok: true } });
    expect(parsed[2]).toEqual({ turn: 3 });
  });

  it("readJournal skips a torn final line and returns [] for a missing journal", async () => {
    const store = makeStore();
    await store.create({ threadId: "t1", name: "Journal" });
    expect(await store.readJournal("t1")).toEqual([]); // no journal yet

    const journalPath = join(chatsDir, dirNameOf("t1") as string, "pwrsnap-thread.journal.jsonl");
    await writeFile(journalPath, '{"ok":1}\n{"ok":2}\n{"torn":', "utf8");
    expect(await store.readJournal("t1")).toEqual([{ ok: 1 }, { ok: 2 }]);
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

describe("ChatThreadStore legacy-sidecar import", () => {
  it("pulls a pre-existing pwrsnap-thread.json into the index on first use", async () => {
    // Seed a legacy thread dir + sidecar on disk, with NO index row.
    const legacyDir = join(chatsDir, "2026-05-01-001-legacy-thread");
    await mkdir(legacyDir, { recursive: true });
    const sidecar: ChatThreadSidecar = {
      schemaVersion: 1,
      threadId: "legacy-1",
      name: "Legacy Thread",
      createdAt: "2026-05-01T00:00:00.000Z",
      modifiedAt: "2026-05-01T00:00:00.000Z",
      anchorCaptureId: "cap-legacy",
      focusHistory: [{ captureId: "cap-legacy", at: "2026-05-01T00:00:00.000Z" }],
      archived: false,
      pinned: true
    };
    await writeFile(join(legacyDir, "pwrsnap-thread.json"), JSON.stringify(sidecar), "utf8");

    const store = makeStore();
    const listed = await store.list();
    expect(listed.map((s) => s.threadId)).toContain("legacy-1");

    const got = await store.get("legacy-1");
    expect(got?.name).toBe("Legacy Thread");
    expect(got?.anchorCaptureId).toBe("cap-legacy");
    expect(got?.pinned).toBe(true);
    expect(got?.focusHistory.length).toBe(1);
    // The dir basename was preserved so the journal still resolves.
    expect(dirNameOf("legacy-1")).toBe("2026-05-01-001-legacy-thread");
  });

  it("skips a corrupt legacy sidecar without throwing", async () => {
    const goodDir = join(chatsDir, "2026-05-02-001-good");
    const badDir = join(chatsDir, "2026-05-02-002-bad");
    await mkdir(goodDir, { recursive: true });
    await mkdir(badDir, { recursive: true });
    const good: ChatThreadSidecar = {
      schemaVersion: 1,
      threadId: "good-1",
      name: "Good",
      createdAt: "2026-05-02T00:00:00.000Z",
      modifiedAt: "2026-05-02T00:00:00.000Z",
      anchorCaptureId: null,
      focusHistory: [],
      archived: false,
      pinned: false
    };
    await writeFile(join(goodDir, "pwrsnap-thread.json"), JSON.stringify(good), "utf8");
    await writeFile(join(badDir, "pwrsnap-thread.json"), "this is not json {[", "utf8");

    const store = makeStore();
    const listed = await store.list();
    expect(listed.map((s) => s.threadId)).toEqual(["good-1"]);
  });
});
