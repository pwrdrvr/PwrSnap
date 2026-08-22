// Pins the startup contract for the chat-thread store's one-time legacy
// sidecar import. The Chats dir lives under `~/Documents`, which macOS gates
// behind the "Allow Documents access" TCC prompt: while the prompt is pending
// every read of the folder parks until the user answers, and a denied grant
// fails with EPERM. The store used to `readdirSync` the dir on first use — on
// the main thread — so the first `codex:libraryChat:list` after launch froze
// the whole app (beachball, "Application Not Responding") until the prompt
// was answered. These tests drive the import through a hooked
// `node:fs/promises` `readdir`, so the parked and denied cases are
// deterministic, and assert the store keeps serving the SQLite index either
// way — without ever waiting on the gated read.
//
// See docs/solutions/2026-06-12-macos-tcc-captures-folder-denials.md.

import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThreadSidecar } from "@pwrsnap/shared";
import {
  getCapturesAccessHealth,
  resetCapturesAccessHealthForTests
} from "../../storage/captures-access-health";
import {
  ChatThreadStore,
  resetLegacyImportsForTests,
  whenLegacyImportSettled,
  type ChatThreadStoreConfig
} from "../chat-thread-store";

// The import reads with `withFileTypes`, so a hook that answers a real
// listing must hand back Dirents, not strings.
type ReaddirHook = (path: string) => Promise<unknown> | null;

const fsHook = vi.hoisted(() => ({
  /** When set, a `readdir(path)` whose hook returns a promise is answered by
   *  that promise instead of the real filesystem (`null` = pass through). */
  readdir: null as ReaddirHook | null,
  calls: [] as string[]
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const passThrough = actual.readdir as (path: string, options?: unknown) => Promise<unknown>;
  return {
    ...actual,
    readdir: ((path: string, options?: unknown) => {
      const key = String(path);
      fsHook.calls.push(key);
      const hooked = fsHook.readdir?.(key) ?? null;
      return hooked ?? passThrough(path, options);
    }) as typeof actual.readdir
  };
});

type StoreLogger = NonNullable<ChatThreadStoreConfig["logger"]>;

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

function fakeLogger(): StoreLogger & { warn: ReturnType<typeof vi.fn> } {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    verbose: vi.fn(),
    debug: vi.fn(),
    silly: vi.fn(),
    log: vi.fn()
  } as unknown as StoreLogger & { warn: ReturnType<typeof vi.fn> };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function permissionDenied(): NodeJS.ErrnoException {
  return Object.assign(new Error(`EPERM: operation not permitted, scandir '${chatsDir}'`), {
    code: "EPERM",
    errno: -1,
    syscall: "scandir",
    path: chatsDir
  });
}

/** Seed one indexed thread through a store built BEFORE any hook is
 *  installed, so its create() goes through the real filesystem. */
async function seedIndexedThread(threadId: string): Promise<void> {
  await new ChatThreadStore({ chatsDir, db }).create({ threadId, name: `Thread ${threadId}` });
}

/** Drop a pre-index `pwrsnap-thread.json` on disk with NO index row — the
 *  only thing the import exists to pick up. */
async function seedLegacySidecar(dirName: string, threadId: string): Promise<void> {
  const dir = join(chatsDir, dirName);
  await mkdir(dir, { recursive: true });
  const sidecar: ChatThreadSidecar = {
    schemaVersion: 1,
    threadId,
    name: `Legacy ${threadId}`,
    createdAt: "2026-05-01T00:00:00.000Z",
    modifiedAt: "2026-05-01T00:00:00.000Z",
    anchorCaptureId: null,
    focusHistory: [],
    archived: false,
    pinned: false,
    provider: null,
    model: null,
    reasoning: null,
    ownerClientId: null
  };
  await writeFile(join(dir, "pwrsnap-thread.json"), JSON.stringify(sidecar), "utf8");
}

beforeEach(async () => {
  resetLegacyImportsForTests();
  resetCapturesAccessHealthForTests();
  fsHook.readdir = null;
  fsHook.calls = [];
  pwrsnapRoot = await mkdtemp(join(tmpdir(), "pwrsnap-chat-store-documents-"));
  chatsDir = join(pwrsnapRoot, "Chats");
  db = new Database(":memory:");
  applyAllMigrations(db);
});

afterEach(async () => {
  resetLegacyImportsForTests();
  resetCapturesAccessHealthForTests();
  fsHook.readdir = null;
  db.close();
  await rm(pwrsnapRoot, { force: true, recursive: true });
});

describe("ChatThreadStore while the Documents grant is pending or denied", () => {
  it("list() / get() answer from the SQLite index while the Chats dir read is parked", async () => {
    await seedIndexedThread("indexed-1");
    await seedLegacySidecar("2026-05-01-001-legacy", "legacy-1");

    // Park the import's directory read exactly like a pending TCC prompt
    // does: the promise simply does not settle until "the user answers".
    const parked = deferred<unknown>();
    fsHook.readdir = (path) => (path === chatsDir ? parked.promise : null);
    fsHook.calls = [];

    const store = new ChatThreadStore({ chatsDir, db, legacyImportWaitMs: 50 });
    const listed = await store.list();
    expect(listed.map((s) => s.threadId)).toEqual(["indexed-1"]);
    expect(await store.get("indexed-1")).toMatchObject({ threadId: "indexed-1" });
    // One import read in flight — repeated calls wait on the SAME promise
    // rather than stacking up more parked reads.
    expect(fsHook.calls.filter((path) => path === chatsDir)).toHaveLength(1);

    // The prompt is answered: the parked read completes and the import
    // lands in the background, without another method having to drive it.
    parked.resolve(readdirSync(chatsDir, { withFileTypes: true }));
    await vi.waitFor(async () => {
      expect((await store.list()).map((s) => s.threadId)).toContain("legacy-1");
    });
    expect(await store.get("legacy-1")).toMatchObject({ name: "Legacy legacy-1" });
  });

  it("proceeds on the index when the Chats dir read is denied (EPERM), warning once", async () => {
    await seedIndexedThread("indexed-1");
    const logger = fakeLogger();
    fsHook.readdir = (path) => (path === chatsDir ? Promise.reject(permissionDenied()) : null);

    const store = new ChatThreadStore({ chatsDir, db, logger });
    expect((await store.list()).map((s) => s.threadId)).toEqual(["indexed-1"]);
    expect(await store.get("indexed-1")).toMatchObject({ threadId: "indexed-1" });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Chats dir unreadable"),
      expect.objectContaining({ chatsDir, code: "EPERM" })
    );
    // A denial fails fast (it does not park), so the memo is dropped and a
    // later call DOES retry — that is how the captures banner recovers if the
    // user grants access mid-session. The warn is emitted once per root, so
    // retrying never turns into log spam.
    await store.list();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when there is no Chats dir yet (ENOENT is not a denial)", async () => {
    const logger = fakeLogger();
    const store = new ChatThreadStore({ chatsDir, db, logger });
    expect(await store.list()).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("charges the wait bound ONCE per root, not once per call", async () => {
    await seedIndexedThread("indexed-1");
    const parked = deferred<unknown>();
    fsHook.readdir = (path) => (path === chatsDir ? parked.promise : null);

    // Two stores on the same root, as production has (the root-keyed handler
    // store plus the controller's own) — they must share one import.
    const a = new ChatThreadStore({ chatsDir, db, legacyImportWaitMs: 120 });
    const b = new ChatThreadStore({ chatsDir, db, legacyImportWaitMs: 120 });
    fsHook.calls = [];

    const started = Date.now();
    await a.list();
    await a.get("indexed-1");
    await b.list();
    await b.lockThreadProvenance("indexed-1", { provider: "codex", model: null, reasoning: null });
    const elapsed = Date.now() - started;

    // Four gated calls across two stores. Re-arming the bound per call would
    // cost ~4x the bound; one shared deadline costs it once.
    expect(elapsed).toBeLessThan(120 * 2);
    // And only ONE parked read exists, so a pending prompt cannot occupy
    // more than one of libuv's four threadpool slots.
    expect(fsHook.calls.filter((path) => path === chatsDir)).toHaveLength(1);

    parked.resolve(readdirSync(chatsDir, { withFileTypes: true }));
    await whenLegacyImportSettled(chatsDir);
  });

  it("does not resurrect a thread deleted while the import was still reading", async () => {
    // A legacy thread the import will pick up, plus a slow read so the delete
    // lands after the bound but before the import's transaction.
    await seedLegacySidecar("2026-05-01-001-legacy", "legacy-1");
    const parked = deferred<unknown>();
    fsHook.readdir = (path) => (path === chatsDir ? parked.promise : null);

    const store = new ChatThreadStore({ chatsDir, db, legacyImportWaitMs: 20 });
    // The bound elapses with the row still absent, and the user deletes it.
    await store.delete("legacy-1");

    // Now the prompt is answered and the import applies its pre-delete
    // snapshot — which must skip the thread the user just deleted.
    parked.resolve(readdirSync(chatsDir, { withFileTypes: true }));
    await whenLegacyImportSettled(chatsDir);

    expect(await store.get("legacy-1")).toBeNull();
    expect((await store.list()).map((s) => s.threadId)).not.toContain("legacy-1");
  });

  it("raises the captures-access signal on a denial and clears it on recovery", async () => {
    await seedIndexedThread("indexed-1");
    let denyReads = true;
    fsHook.readdir = (path) =>
      path === chatsDir && denyReads ? Promise.reject(permissionDenied()) : null;

    const store = new ChatThreadStore({ chatsDir, db, logger: fakeLogger() });
    await store.list();
    // A Chats-dir EPERM is the same Documents denial the captures banner
    // reports, so it must reach the shared accounting point — not just a log.
    expect(getCapturesAccessHealth()).toMatchObject({ denied: true, samplePath: chatsDir });

    // The user grants access mid-session. A denial fails fast rather than
    // parking, so the next call retries and the banner must self-dismiss —
    // the module's documented contract. A latched memo would pin it up for
    // the life of the process even after every capture path recovered.
    denyReads = false;
    await store.list();
    await whenLegacyImportSettled(chatsDir);
    expect(getCapturesAccessHealth().denied).toBe(false);
  });

  it("never imports the synchronous fs API", () => {
    // The whole incident was one `readdirSync` on a TCC-gated path. Pin the
    // module to `node:fs/promises` so a sync read can't creep back in — an
    // `import ... from "node:fs"` is the only way to get one.
    const source = readFileSync(new URL("../chat-thread-store.ts", import.meta.url), "utf8");
    // Cover every spelling that reaches the sync API, not just the one the
    // original bug happened to use: either quote style, with or without the
    // `node:` prefix, and the `require` / dynamic-import forms. The trailing
    // quote is load-bearing — "node:fs/promises" contains "node:fs".
    expect(source).not.toMatch(/from\s+['"](?:node:)?fs['"]/);
    expect(source).not.toMatch(/require\(\s*['"](?:node:)?fs['"]\s*\)/);
    expect(source).not.toMatch(/import\(\s*['"](?:node:)?fs['"]\s*\)/);
    expect(source).toMatch(/from "node:fs\/promises"/);
  });
});
