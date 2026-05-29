// ChatStore round-trip + persistence. Mirrors cart-store.test.ts /
// sizzle-store.test.ts — real temp files, no mocks.

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatSession } from "@pwrsnap/shared";
import { ChatStore } from "../chat-store";

let tmpDir = "";
let filePath = "";

function makeStore(): ChatStore {
  return new ChatStore({ filePath });
}

function session(patch: Partial<ChatSession> = {}): ChatSession {
  return {
    projectId: "sz_1",
    sessionId: "chat_1",
    threadId: "thread_1",
    scratchDir: "/tmp/chats/2026-05-28-demo",
    createdAt: "2026-05-28T00:00:00.000Z",
    ...patch
  };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "pwrsnap-chat-store-"));
  filePath = join(tmpDir, "sizzle-chat-sessions.json");
});

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("ChatStore", () => {
  it("returns null for an unknown project / session", async () => {
    const store = makeStore();
    expect(await store.getByProjectId("nope")).toBeNull();
    expect(await store.getBySessionId("nope")).toBeNull();
  });

  it("upserts one row per project and reads it back by either key", async () => {
    const store = makeStore();
    await store.upsert(session());
    expect(await store.getByProjectId("sz_1")).toMatchObject({ sessionId: "chat_1" });
    expect(await store.getBySessionId("chat_1")).toMatchObject({ projectId: "sz_1" });
  });

  it("upsert replaces the existing row for a project (no duplicates)", async () => {
    const store = makeStore();
    await store.upsert(session());
    await store.upsert(session({ threadId: "thread_2" }));
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.threadId).toBe("thread_2");
  });

  it("deleteByProjectId removes the row and returns it", async () => {
    const store = makeStore();
    await store.upsert(session());
    const removed = await store.deleteByProjectId("sz_1");
    expect(removed?.scratchDir).toBe("/tmp/chats/2026-05-28-demo");
    expect(await store.getByProjectId("sz_1")).toBeNull();
    expect(await store.deleteByProjectId("sz_1")).toBeNull();
  });

  it("persists across instances (survives 'restart')", async () => {
    const store1 = makeStore();
    await store1.upsert(session());
    const store2 = makeStore();
    expect(await store2.getByProjectId("sz_1")).toMatchObject({ sessionId: "chat_1" });
  });

  it("parse-fail quarantines the corrupt file and returns empty", async () => {
    await writeFile(filePath, "not json", "utf8");
    const store = makeStore();
    expect(await store.list()).toEqual([]);
    const entries = await readdir(tmpDir);
    expect(entries.filter((e) => e.includes(".corrupt-"))).toHaveLength(1);
  });

  it("write leaves no .tmp sibling (atomic rename)", async () => {
    const store = makeStore();
    await store.upsert(session());
    const entries = await readdir(tmpDir);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
    expect(entries).toContain("sizzle-chat-sessions.json");
  });

  it("serializes concurrent upserts (no lost writes)", async () => {
    const store = makeStore();
    await Promise.all([
      store.upsert(session({ projectId: "a", sessionId: "ca" })),
      store.upsert(session({ projectId: "b", sessionId: "cb" })),
      store.upsert(session({ projectId: "c", sessionId: "cc" }))
    ]);
    const all = await store.list();
    expect(all.map((s) => s.projectId).sort()).toEqual(["a", "b", "c"]);
  });
});
