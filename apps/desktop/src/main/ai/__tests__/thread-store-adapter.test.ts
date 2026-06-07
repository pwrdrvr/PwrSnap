// Behaviour-level coverage for the kit `ThreadStore` adapter over PwrSnap's
// `ChatThreadStore`. The store is the REAL ChatThreadStore over an in-memory
// SQLite DB + a tmp Chats dir, so the type renames (anchorId ↔ anchorCaptureId,
// anchorHistory ↔ focusHistory) and the prepared-dir round-trip are exercised
// against actual indexed queries + on-disk journal IO. `recordUsage` (which
// writes through the app DB singleton via saveAiThreadUsage) is covered by the
// one-shot enrichment usage test, not here.

import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatThreadStore } from "../chat-thread-store";
import { ThreadStoreAdapter } from "../thread-store-adapter";

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
  pwrsnapRoot = await mkdtemp(join(tmpdir(), "pwrsnap-thread-store-adapter-"));
  chatsDir = join(pwrsnapRoot, "Chats");
  db = new Database(":memory:");
  applyAllMigrations(db);
});

afterEach(async () => {
  db.close();
  await rm(pwrsnapRoot, { force: true, recursive: true });
});

function makeAdapter(): ThreadStoreAdapter {
  // No usageSurface → recordUsage is a no-op, keeping the test off the app DB.
  return new ThreadStoreAdapter({ store: new ChatThreadStore({ chatsDir, db }) });
}

describe("ThreadStoreAdapter", () => {
  it("prepareThreadDir → create round-trips the prepared dir (one on-disk dir)", async () => {
    const adapter = makeAdapter();
    const prepared = await adapter.prepareThreadDir("My Reel");
    expect(prepared.path).toContain(chatsDir);

    const record = await adapter.create({
      threadId: "th_1",
      name: "My Reel",
      anchorId: "cap_1",
      preparedDir: prepared
    });
    expect(record.threadId).toBe("th_1");
    expect(record.anchorId).toBe("cap_1");
    expect(record.archived).toBe(false);
    expect(record.pinned).toBe(false);

    // Exactly one thread dir on disk — the prepared dir was reused, not
    // re-minted.
    const dirs = readdirSync(chatsDir).filter((e) => !e.startsWith("."));
    expect(dirs).toHaveLength(1);
  });

  it("maps anchorId ⇄ anchorCaptureId and exposes a neutral record shape", async () => {
    const adapter = makeAdapter();
    await adapter.create({ threadId: "th_1", name: "Chat", anchorId: null });
    const record = await adapter.get("th_1");
    expect(record).not.toBeNull();
    expect(record?.anchorId).toBeNull();
    expect(record?.anchorHistory).toEqual([]);
  });

  it("appendAnchor sets the current anchor AND pushes a focus-history entry", async () => {
    const adapter = makeAdapter();
    await adapter.create({ threadId: "th_1", name: "Chat", anchorId: null });
    await adapter.appendAnchor("th_1", "cap_42");
    const record = await adapter.get("th_1");
    expect(record?.anchorId).toBe("cap_42");
    expect(record?.anchorHistory).toEqual([
      expect.objectContaining({ anchorId: "cap_42" })
    ]);
    // The kit's NormalizedAnchorEntry carries an ISO `at` timestamp.
    expect(typeof record?.anchorHistory[0]?.at).toBe("string");
  });

  it("update patches name/archived/pinned and bumps the record", async () => {
    const adapter = makeAdapter();
    await adapter.create({ threadId: "th_1", name: "Chat", anchorId: "cap_1" });
    const renamed = await adapter.update("th_1", { name: "Renamed", pinned: true });
    expect(renamed.name).toBe("Renamed");
    expect(renamed.pinned).toBe(true);
    expect(renamed.anchorId).toBe("cap_1"); // untouched
  });

  it("list scopes by anchor and excludes archived by default", async () => {
    const adapter = makeAdapter();
    await adapter.create({ threadId: "th_a", name: "A", anchorId: "cap_1" });
    await adapter.create({ threadId: "th_b", name: "B", anchorId: "cap_2" });
    await adapter.create({ threadId: "th_c", name: "C", anchorId: "cap_1" });
    await adapter.update("th_c", { archived: true });

    const scoped = await adapter.list({ anchorId: "cap_1" });
    expect(scoped.map((r) => r.threadId).sort()).toEqual(["th_a"]);

    const withArchived = await adapter.list({ anchorId: "cap_1", includeArchived: true });
    expect(withArchived.map((r) => r.threadId).sort()).toEqual(["th_a", "th_c"]);
  });

  it("journalAppend / readJournal round-trips opaque entries in order", async () => {
    const adapter = makeAdapter();
    await adapter.create({ threadId: "th_1", name: "Chat", anchorId: null });
    await adapter.journalAppend("th_1", { kind: "message", message: { id: "m1", text: "hi" } });
    await adapter.journalAppend("th_1", { kind: "message", message: { id: "m2", text: "yo" } });
    const entries = await adapter.readJournal("th_1");
    expect(entries).toEqual([
      { kind: "message", message: { id: "m1", text: "hi" } },
      { kind: "message", message: { id: "m2", text: "yo" } }
    ]);
  });

  it("attachmentsDir creates + returns the thread's attachments path", async () => {
    const adapter = makeAdapter();
    await adapter.create({ threadId: "th_1", name: "Chat", anchorId: null });
    const dir = await adapter.attachmentsDir("th_1");
    expect(dir).toContain("attachments");
    await expect(stat(dir)).resolves.toBeTruthy();
  });

  it("delete removes the index row + on-disk dir", async () => {
    const adapter = makeAdapter();
    const prepared = await adapter.prepareThreadDir("Chat");
    await adapter.create({ threadId: "th_1", name: "Chat", anchorId: null, preparedDir: prepared });
    await adapter.delete("th_1");
    expect(await adapter.get("th_1")).toBeNull();
    await expect(stat(prepared.path)).rejects.toThrow();
  });
});
