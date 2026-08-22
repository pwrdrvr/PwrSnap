// Store for the Library Chat thread INDEX. Thread metadata (name /
// anchor / focus history / archive + pin flags) lives in the SQLite
// `chat_threads` table (the "overlay"); the per-turn message journal
// (`pwrsnap-thread.journal.jsonl`) + attachments stay on disk under
// ~/Documents/PwrSnap/Chats/<dir_name>/ (founder storage decision
// 2026-05-28 — chats are portable + visible in the user's Documents).
//
// Why SQLite for the index: the previous JSON-sidecar design had no way
// to resolve a threadId → dir except a full `readdir` + `JSON.parse` of
// every sidecar (`locate()`), so a single `sendMessage` triggered
// several O(threads) directory scans. The index turns every lookup into
// one indexed query. Mirrors PwrAgent's SQLite thread overlay: index in
// the DB, message content on disk (theirs is Codex's rollout; ours is
// the journal).
//
// Crash safety:
//   • metadata writes are single SQLite statements — atomic + durable
//     under WAL. A read-modify-write (update / appendFocus) does the
//     SELECT and the UPDATE with NO await in between, so two concurrent
//     calls can't interleave a torn read (better-sqlite3 is synchronous;
//     the first call's UPDATE lands before the second's SELECT runs).
//   • the journal is an append-only log — a single `appendFile` per
//     line; a torn final line (crash mid-append) is skipped on read.
//
// Migration from the old sidecars: `importLegacySidecars()` walks the
// Chats dir ONCE per root per PROCESS and pulls any pre-existing
// `pwrsnap-thread.json` into the index (INSERT OR IGNORE — never
// overwrites a live row, never deletes the sidecar). New threads write
// only the index row; no sidecar is created going forward.
//
// The walk is ASYNC and time-bounded, never synchronous — see
// `LEGACY_IMPORT_WAIT_MS` and `legacyImportFor()`. Nothing in this module
// may use the sync `node:fs` API, because the Chats dir is TCC-gated and a
// sync read of it on the main thread froze the whole app. Full story:
// docs/solutions/2026-06-12-macos-tcc-captures-folder-denials.md.

import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type DatabaseT from "better-sqlite3";
import type { ChatFocusEntry, ChatThreadSidecar } from "@pwrsnap/shared";
import { chatThreadSidecarSchema } from "@pwrsnap/shared";
import { getDb } from "../persistence/db";
import {
  reportCapturesAccessFailure,
  reportCapturesAccessSuccess
} from "../storage/captures-access-health";
import { getMainLogger } from "../log";

type Logger = ReturnType<typeof getMainLogger>;
type Database = DatabaseT.Database;

/** Legacy sidecar file name (read once by the importer; never written
 *  for new threads). */
const SIDECAR_FILE = "pwrsnap-thread.json";
/** Append-only per-turn journal (one JSON object per line). */
const JOURNAL_FILE = "pwrsnap-thread.journal.jsonl";
/** Attachments dropped into the thread dir live here. */
const ATTACHMENTS_DIR = "attachments";
/** Spotlight opt-out sentinel — sits one level above chatsDir (i.e. at
 *  ~/Documents/PwrSnap/.metadata_never_index). */
const METADATA_NEVER_INDEX = ".metadata_never_index";
/** Hard cap on focusHistory length — keeps the row small. */
const FOCUS_HISTORY_MAX = 20;
/** Slug length cap for the thread-dir name. */
const SLUG_MAX = 40;
/**
 * Upper bound on how long store methods wait for the one-time legacy
 * sidecar import before proceeding on the SQLite index alone.
 *
 * The import reads the Chats dir, which lives under the macOS TCC-gated
 * Documents folder. While the "Allow Documents access" prompt is pending,
 * that read parks until the user answers (an unbounded wait); when the
 * grant is denied it fails with EPERM. Neither may hold up listing or
 * creating threads: the SQLite index is the source of truth for every
 * thread created since the index landed, and the sidecar walk only
 * back-fills threads from before it. A healthy import takes milliseconds,
 * so this bound never engages on an ordinary boot.
 *
 * The bound is charged ONCE per root, not per call — see
 * {@link legacyImportFor}.
 */
const LEGACY_IMPORT_WAIT_MS = 1500;

/** How many sidecar reads the import has in flight at once. libuv's default
 *  threadpool is FOUR threads, shared with every other `fs/promises` call plus
 *  `dns.lookup` / `zlib` / `crypto`, so this stays below it — one free slot is
 *  the difference between a slow background back-fill and a stalled app. It
 *  matters most on an iCloud-synced Documents folder, where each evicted
 *  sidecar blocks its thread on materialization. */
const LEGACY_IMPORT_READ_CONCURRENCY = 3;

/**
 * The process-wide legacy-sidecar import for ONE Chats root.
 *
 * Keyed by root rather than held per store instance because the import
 * back-fills a process-wide SQLite table — per-instance state was never
 * meaningful, and there are five `ChatThreadStore` construction sites
 * (the two root-keyed handler stores, one per `buildChatSurface`, one per
 * Sizzle surface build, and a throwaway per `cleanupProjectChats`). Under
 * a pending Documents prompt, a per-instance import parked one libuv
 * threadpool thread EACH against a default pool of four, which starves
 * every other async fs/dns/crypto call in the main process. One shared
 * import parks at most one.
 */
type LegacyImport = {
  /** Resolves when the import settles OR {@link LEGACY_IMPORT_WAIT_MS}
   *  elapses — whichever is first, computed ONCE. Every caller awaits this
   *  same promise, so the bound is paid once for the root rather than
   *  re-armed per call (which made waits additive: a "New chat" chained
   *  four gated calls for 4 × the bound). */
  gate: Promise<void>;
  /** Resolves when the import itself finishes, however long that takes.
   *  Test seam only — production code must await {@link gate}. */
  settled: Promise<void>;
  /** Threads deleted while the import was still in flight. The import
   *  snapshots sidecars from disk before applying them, so without this a
   *  `delete()` that ran after the bound elapsed would be undone by the
   *  pending `INSERT OR IGNORE`. Cleared once the import settles. */
  deleted: Set<string>;
  /** True once the transaction has run. After that nothing can be
   *  resurrected, so `delete()` stops recording ids (the set would
   *  otherwise grow for the life of the process). */
  done: boolean;
};

/** Whether a finished import may usefully be retried later. */
type LegacyImportOutcome = "done" | "denied";

const legacyImports = new Map<string, LegacyImport>();
/** Roots whose "Chats dir unreadable" warn has already been emitted, so a
 *  retry after a denial doesn't re-log it once per call. */
const legacyImportWarnedRoots = new Set<string>();

/** Test seam — drop the per-root import memo between specs. */
export function resetLegacyImportsForTests(): void {
  legacyImports.clear();
  legacyImportWarnedRoots.clear();
}

/** Test seam — await the REAL import (no bound) for a root, so specs that
 *  assert imported rows don't race {@link LEGACY_IMPORT_WAIT_MS}. Resolves
 *  immediately when no import has been started for that root. */
export async function whenLegacyImportSettled(chatsDir: string): Promise<void> {
  await legacyImports.get(chatsDir)?.settled;
}

export type ChatThreadStoreConfig = {
  /** The ~/Documents/PwrSnap/Chats root. Injectable for tests. */
  chatsDir: string;
  /** SQLite handle. Defaults to the app singleton (`getDb()`); tests
   *  inject an in-memory DB with the migrations applied. */
  db?: Database;
  logger?: Logger;
  /** Test seam for {@link LEGACY_IMPORT_WAIT_MS}. */
  legacyImportWaitMs?: number;
};

export type PreparedChatThreadDir = {
  dirName: string;
  path: string;
};

/** Shape of one `chat_threads` row as read back from SQLite. */
type ChatThreadRow = {
  thread_id: string;
  dir_name: string;
  name: string;
  anchor_capture_id: string | null;
  archived: number;
  pinned: number;
  focus_history: string;
  created_at: string;
  modified_at: string;
  schema_version: number;
  // Per-thread backend config (migration 0024); NULL = use surface default.
  provider: string | null;
  model: string | null;
  reasoning: string | null;
  owner_client_id: string | null;
};

/**
 * Kebab-case an ascii slug from a thread name. Lowercases, drops anything
 * that isn't `[a-z0-9]`, collapses runs to a single hyphen, trims leading /
 * trailing hyphens, and caps the length. Falls back to "thread" when the
 * name has no usable ascii (e.g. an all-emoji or all-CJK name) so the dir
 * name is always non-empty.
 */
export function slugifyThreadName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "thread";
}

/**
 * A `ChatThreadStore` accessor that FOLLOWS a moving chats root.
 *
 * `getChatsRoot()` composes from the captures location, which changes at
 * runtime: `capture-storage-gate` flips it to "home" when macOS denies the
 * Documents grant, and the Settings listener flips it when the user switches
 * locations. A store captured once at handler-registration time would keep
 * writing threads to the root that just proved inaccessible — which is exactly
 * the failure the captures fallback exists to prevent.
 *
 * Constructing a store touches nothing (lazy DB access), so rebuilding on a
 * root change is cheap; the memo only avoids churning an object per call.
 */
export function rootKeyedChatThreadStore(
  resolveChatsDir: () => string
): () => ChatThreadStore {
  let instance: ChatThreadStore | null = null;
  let builtFor: string | null = null;
  return () => {
    const chatsDir = resolveChatsDir();
    if (instance === null || builtFor !== chatsDir) {
      instance = new ChatThreadStore({ chatsDir });
      builtFor = chatsDir;
    }
    return instance;
  };
}

export class ChatThreadStore {
  private readonly chatsDir: string;
  private readonly log: Logger;
  private readonly injectedDb: Database | null;

  /** True once the `.metadata_never_index` sentinel drop has been
   *  attempted, so we don't re-stat it on every `create()`. */
  private sentinelEnsured = false;
  private readonly legacyImportWaitMs: number;

  constructor(config: ChatThreadStoreConfig) {
    this.chatsDir = config.chatsDir;
    this.log = config.logger ?? getMainLogger("pwrsnap:chat-thread-store");
    this.injectedDb = config.db ?? null;
    this.legacyImportWaitMs = config.legacyImportWaitMs ?? LEGACY_IMPORT_WAIT_MS;
  }

  private db(): Database {
    return this.injectedDb ?? getDb();
  }

  /**
   * Mint a fresh thread dir + index row. `anchorCaptureId` is written in
   * the SAME insert (no follow-up update), so a freshly-anchored thread
   * is one write.
   */
  async create(opts: {
    threadId: string;
    name: string;
    anchorCaptureId?: string | null;
    preparedDir?: PreparedChatThreadDir;
    /** The thread's chosen backend config (Provider / Model / Reasoning),
     *  persisted so the surface routes the thread to the right backend and the
     *  locked chips render its real config. Omit/null = use surface default. */
    provider?: string | null;
    model?: string | null;
    reasoning?: string | null;
  }): Promise<ChatThreadSidecar> {
    // No `ensureImported()` here: this INSERTs a caller-supplied fresh
    // threadId and reads back that same row, so a legacy-imported row cannot
    // change either outcome. `prepareThreadDir` gates on its own when it
    // mints the dir; gating here too just charged the bound twice.
    const preparedDir = opts.preparedDir ?? (await this.prepareThreadDir(opts.name));
    const now = new Date().toISOString();
    const anchorCaptureId = opts.anchorCaptureId ?? null;
    this.db()
      .prepare(
        `INSERT INTO chat_threads
           (thread_id, dir_name, name, anchor_capture_id, archived, pinned, focus_history, created_at, modified_at, schema_version, provider, model, reasoning)
         VALUES (?, ?, ?, ?, 0, 0, '[]', ?, ?, 1, ?, ?, ?)`
      )
      .run(
        opts.threadId,
        preparedDir.dirName,
        opts.name,
        anchorCaptureId,
        now,
        now,
        opts.provider ?? null,
        opts.model ?? null,
        opts.reasoning ?? null
      );
    return rowToSidecar(this.selectRowOrThrow(opts.threadId));
  }

  /** Persist a thread's locked backend config (Provider / Model / Reasoning).
   *  Written once when the thread is created with a chosen config; thereafter
   *  the config is immutable (locked on first message). No-op for an unknown id. */
  /**
   * Stamp a freshly created thread's locked backend config and, for a thread
   * created by a local MCP client, its owner — as ONE atomic write.
   *
   * This is deliberately a single entry point rather than two setters.
   * `codex:*Chat:list` treats `owner_client_id IS NULL` as "library-wide,
   * show it in the UI", so anything that lets a reader observe the row after
   * the config write but before the owner write renders another local
   * client's private thread in the user's Library — the tenancy boundary
   * `codex:*Chat:send` enforces with "This chat belongs to another user or
   * local client." Two separately awaited setters left exactly that window
   * open, and even back to back they are two autocommit transactions: if the
   * second threw, the first would already be durable and the thread would
   * stay unowned forever. The explicit transaction makes it all-or-nothing.
   */
  async lockThreadProvenance(
    threadId: string,
    config: { provider: string | null; model: string | null; reasoning: string | null },
    ownerClientId: string | null = null
  ): Promise<void> {
    await this.ensureImported();
    const db = this.db();
    const writeConfig = db.prepare(
      `UPDATE chat_threads SET provider = ?, model = ?, reasoning = ? WHERE thread_id = ?`
    );
    const writeOwner = db.prepare(
      `UPDATE chat_threads SET owner_client_id = ? WHERE thread_id = ?`
    );
    db.transaction(() => {
      writeConfig.run(
        config.provider ?? null,
        config.model ?? null,
        config.reasoning ?? null,
        threadId
      );
      if (ownerClientId !== null && ownerClientId !== "") {
        writeOwner.run(ownerClientId, threadId);
      }
    })();
  }

  /**
   * Create the on-disk chat dir before Codex `thread/start`, so callers can
   * pass the final thread workspace as Codex's cwd instead of inheriting the
   * Electron/dev process cwd.
   */
  async prepareThreadDir(name: string): Promise<PreparedChatThreadDir> {
    // No `ensureImported()`: minting a dir reads the filesystem for the next
    // per-day sequence number, never the index, so a pending back-fill
    // cannot change the result. Gating here was pure added latency on the
    // "New chat" path.
    await this.ensureMetadataNeverIndex();
    const dirName = await this.mintThreadDir(name, new Date().toISOString());
    const path = join(this.chatsDir, dirName);
    await mkdir(join(path, ATTACHMENTS_DIR), { recursive: true });
    return { dirName, path };
  }

  /**
   * Best-effort cleanup for a prepared dir whose Codex thread failed to
   * start. Once a row exists, use delete(threadId) instead.
   */
  async discardPreparedThreadDir(preparedDir: PreparedChatThreadDir): Promise<void> {
    await rm(preparedDir.path, { recursive: true, force: true });
  }

  /**
   * List threads, newest-activity-first. Filtering is pushed into SQL so
   * the result set is exactly what the caller asked for — never a full
   * table scan in TS.
   *   • includeArchived omitted/false → archived rows excluded.
   *   • anchorCaptureId omitted → all anchors. `null` → only library-wide
   *     (unanchored) threads. A string → only that capture's threads.
   */
  async list(
    opts: { includeArchived?: boolean; anchorCaptureId?: string | null } = {}
  ): Promise<ChatThreadSidecar[]> {
    await this.ensureImported();
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.includeArchived !== true) clauses.push("archived = 0");
    if (opts.anchorCaptureId !== undefined) {
      if (opts.anchorCaptureId === null) {
        clauses.push("anchor_capture_id IS NULL");
      } else {
        clauses.push("anchor_capture_id = ?");
        params.push(opts.anchorCaptureId);
      }
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db()
      .prepare(`SELECT * FROM chat_threads ${where} ORDER BY modified_at DESC`)
      .all(...params) as ChatThreadRow[];
    return rows.map(rowToSidecar);
  }

  /** Returns the sidecar for `threadId`, or null when absent. */
  async get(threadId: string): Promise<ChatThreadSidecar | null> {
    await this.ensureImported();
    const row = this.selectRow(threadId);
    return row === undefined ? null : rowToSidecar(row);
  }

  /**
   * Patch the mutable metadata fields. Bumps `modified_at`. `undefined`
   * (or key absent) = leave alone; an explicit value (including `false` /
   * `null` / `""`) is a write — mirrors the settings-substrate
   * `undefined ≠ null ≠ ""` rule. The SELECT + UPDATE run with no await
   * between them, so two concurrent `update()`s merge rather than clobber.
   */
  async update(
    threadId: string,
    patch: Partial<Pick<ChatThreadSidecar, "name" | "anchorCaptureId" | "archived" | "pinned">>
  ): Promise<ChatThreadSidecar> {
    await this.ensureImported();
    const row = this.selectRow(threadId);
    if (row === undefined) {
      throw new Error(`chat-thread-store: update on unknown thread ${threadId}`);
    }
    const name = patch.name !== undefined ? patch.name : row.name;
    const anchorCaptureId =
      patch.anchorCaptureId !== undefined ? patch.anchorCaptureId : row.anchor_capture_id;
    const archived = patch.archived !== undefined ? (patch.archived ? 1 : 0) : row.archived;
    const pinned = patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : row.pinned;
    const now = new Date().toISOString();
    this.db()
      .prepare(
        `UPDATE chat_threads
            SET name = ?, anchor_capture_id = ?, archived = ?, pinned = ?, modified_at = ?
          WHERE thread_id = ?`
      )
      .run(name, anchorCaptureId, archived, pinned, now, threadId);
    return rowToSidecar(this.selectRowOrThrow(threadId));
  }

  /**
   * Hard-delete a thread: remove its index row AND its on-disk directory
   * (journal + attachments). Used by the Sizzle project-delete cascade so
   * deleting a reel leaves no orphan chat dir (decision #6). No-op for an
   * unknown thread. The dir path is resolved BEFORE the row is removed
   * (it's derived from the row's `dir_name`).
   */
  async delete(threadId: string): Promise<void> {
    const legacyImport = this.legacyImportFor();
    await legacyImport.gate;
    // Tell a still-running import this thread is gone BEFORE removing the
    // row. Both run to completion synchronously (better-sqlite3 is sync, and
    // the import's transaction takes no awaits), so they cannot interleave —
    // without this, an import that had already read the sidecar would
    // re-insert the row and the deleted chat would come back.
    if (!legacyImport.done) legacyImport.deleted.add(threadId);
    const dir = this.threadDir(threadId);
    this.db().prepare(`DELETE FROM chat_threads WHERE thread_id = ?`).run(threadId);
    if (dir !== null) {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Push a focus entry onto `focusHistory`, capped at the last
   * FOCUS_HISTORY_MAX (newest kept). Bumps `modified_at`.
   */
  async appendFocus(threadId: string, captureId: string): Promise<void> {
    await this.ensureImported();
    const row = this.selectRow(threadId);
    if (row === undefined) {
      throw new Error(`chat-thread-store: appendFocus on unknown thread ${threadId}`);
    }
    const entry: ChatFocusEntry = { captureId, at: new Date().toISOString() };
    const focusHistory = [...parseFocusHistory(row.focus_history), entry].slice(-FOCUS_HISTORY_MAX);
    const now = new Date().toISOString();
    this.db()
      .prepare(`UPDATE chat_threads SET focus_history = ?, modified_at = ? WHERE thread_id = ?`)
      .run(JSON.stringify(focusHistory), now, threadId);
  }

  /**
   * Append one JSON line to the per-turn journal on disk. The journal is
   * append-only — a single `appendFile` is the right primitive (each line
   * is independently parseable; a torn final line is recoverable by
   * skipping it on read). The thread dir is resolved from the index row
   * (one indexed lookup, no directory scan).
   */
  async journalAppend(threadId: string, entry: unknown): Promise<void> {
    await this.ensureImported();
    const dir = this.threadDir(threadId);
    if (dir === null) {
      throw new Error(`chat-thread-store: journalAppend on unknown thread ${threadId}`);
    }
    await appendFile(join(dir, JOURNAL_FILE), `${JSON.stringify(entry)}\n`, "utf8");
  }

  /**
   * Read every parseable JSON line from the per-turn journal, in order.
   * A torn / unparseable final line (crash mid-append) is skipped rather
   * than throwing. Returns `[]` for an unknown thread or a missing journal.
   */
  async readJournal(threadId: string): Promise<unknown[]> {
    await this.ensureImported();
    const dir = this.threadDir(threadId);
    if (dir === null) return [];
    let raw: string;
    try {
      raw = await readFile(join(dir, JOURNAL_FILE), "utf8");
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") return [];
      throw cause;
    }
    const out: unknown[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch {
        // Torn final line — skip. Append-only log tolerates this.
      }
    }
    return out;
  }

  /**
   * Returns the attachments dir path for a thread, creating it on demand.
   * Throws if the thread is unknown.
   */
  async attachmentsDir(threadId: string): Promise<string> {
    await this.ensureImported();
    const dir = this.threadDir(threadId);
    if (dir === null) {
      throw new Error(`chat-thread-store: attachmentsDir on unknown thread ${threadId}`);
    }
    const attachments = join(dir, ATTACHMENTS_DIR);
    await mkdir(attachments, { recursive: true });
    return attachments;
  }

  // ---- internals --------------------------------------------------------

  private selectRow(threadId: string): ChatThreadRow | undefined {
    return this.db()
      .prepare("SELECT * FROM chat_threads WHERE thread_id = ?")
      .get(threadId) as ChatThreadRow | undefined;
  }

  private selectRowOrThrow(threadId: string): ChatThreadRow {
    const row = this.selectRow(threadId);
    if (row === undefined) {
      throw new Error(`chat-thread-store: row vanished for thread ${threadId}`);
    }
    return row;
  }

  /** Absolute path to a thread's on-disk dir (journal + attachments), or
   *  null when the thread isn't in the index. */
  private threadDir(threadId: string): string | null {
    const row = this.selectRow(threadId);
    return row === undefined ? null : join(this.chatsDir, row.dir_name);
  }

  /**
   * The shared {@link LegacyImport} for this store's root, starting it on
   * first use. One import per root per process; see {@link LegacyImport}.
   */
  private legacyImportFor(): LegacyImport {
    const root = this.chatsDir;
    const memo = legacyImports.get(root);
    if (memo !== undefined) return memo;
    const deleted = new Set<string>();
    let entry: LegacyImport;
    const settled = this.importLegacySidecars(deleted)
      .catch((cause: unknown): LegacyImportOutcome => {
        // `importLegacySidecars` handles its own failures; this only guards
        // a programming error so a caller can never hang on it.
        this.log.warn("chat-thread-store: legacy sidecar import threw", {
          message: errMessage(cause)
        });
        return "done";
      })
      .then((outcome) => {
        entry.done = true;
        deleted.clear();
        // A DENIED grant fails fast, unlike a pending prompt (which parks in
        // the memo until it settles). Drop the memo so a later call retries:
        // if the user grants access mid-session the retry succeeds and calls
        // reportCapturesAccessSuccess, letting the captures banner
        // self-dismiss. Without this, one Chats-dir EPERM pins the banner up
        // for the life of the process even after every capture path recovers.
        if (outcome === "denied" && legacyImports.get(root) === entry) {
          legacyImports.delete(root);
        }
      });
    entry = {
      settled,
      gate: settleWithin(settled, this.legacyImportWaitMs),
      deleted,
      done: false
    };
    legacyImports.set(root, entry);
    return entry;
  }

  /**
   * Await the legacy-sidecar import, bounded by
   * {@link LEGACY_IMPORT_WAIT_MS}. Methods that read or resolve an index
   * row await this FIRST, before touching SQLite, so the read-modify-write
   * methods (`update`, `appendFocus`) still run their SELECT and UPDATE
   * with no yield point in between — the await sits ahead of the critical
   * section, not inside it.
   *
   * Never rejects, and never re-arms: the bound is a property of the root,
   * so once it has elapsed every later call returns immediately and the
   * import finishes in the background.
   */
  private ensureImported(): Promise<void> {
    return this.legacyImportFor().gate;
  }

  /**
   * One-time pull of legacy `pwrsnap-thread.json` sidecars into the
   * index. Idempotent (INSERT OR IGNORE on the threadId PK) and
   * non-destructive (the sidecar file is left on disk). Best-effort — a
   * missing Chats dir or a corrupt sidecar is silently skipped; a dir
   * that can't be listed (macOS Documents TCC denial → EPERM) is logged
   * once and skipped, since the index still serves every thread it holds.
   *
   * All filesystem access here is ASYNC (`node:fs/promises`). The Chats
   * dir is under the TCC-gated Documents folder, and a synchronous read
   * of it on the main thread is what used to freeze the app at startup
   * while the consent prompt was pending. The sidecars are read up front
   * so the SQLite transaction stays a tight synchronous section.
   */
  private async importLegacySidecars(
    deleted: ReadonlySet<string>
  ): Promise<LegacyImportOutcome> {
    let entries: string[];
    try {
      // `withFileTypes` costs nothing extra (the type rides along on the
      // same scandir) and lets us skip `.DS_Store` / the
      // `.metadata_never_index` sentinel, each of which would otherwise pay
      // a doomed open.
      //
      // Filter on `isFile()`, NOT `isDirectory()`: libuv reports
      // `UV_DIRENT_UNKNOWN` for filesystems that don't fill in `d_type`
      // (SMB, NFS, exFAT, several FUSE + cloud-sync mounts) and never
      // lstat()s to resolve it, so `isDirectory()` is false for EVERY entry
      // there — which would silently import nothing at all. Excluding only
      // what is definitely a plain file keeps unknowns and symlinked thread
      // dirs in, exactly like the old name-only readdir.
      entries = (await readdir(this.chatsDir, { withFileTypes: true }))
        .filter((entry) => !entry.isFile())
        .map((entry) => entry.name);
      reportCapturesAccessSuccess(this.chatsDir);
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") {
        return "done"; // No Chats dir yet → nothing to import.
      }
      // `getChatsRoot()` is `<capturesRoot>/Chats`, so an EPERM/EACCES here
      // is the SAME macOS Documents denial the captures banner reports, with
      // the same remedy. Route it through the single accounting point rather
      // than inventing a second, silent one (2026-06-12 solution doc).
      const denied = reportCapturesAccessFailure(this.chatsDir, cause);
      if (!legacyImportWarnedRoots.has(this.chatsDir)) {
        legacyImportWarnedRoots.add(this.chatsDir);
        this.log.warn("chat-thread-store: legacy sidecar import skipped — Chats dir unreadable", {
          chatsDir: this.chatsDir,
          code: isNodeError(cause) ? cause.code : undefined,
          message: errMessage(cause)
        });
      }
      return denied ? "denied" : "done";
    }

    // Bounded-parallel so a big Chats dir doesn't serialize one threadpool
    // round-trip per entry. Most entries have no sidecar at all (threads
    // created since the index landed write none), so these are mostly
    // ENOENT misses.
    const sidecars: Array<{ dirName: string; sidecar: ChatThreadSidecar }> = [];
    for (let i = 0; i < entries.length; i += LEGACY_IMPORT_READ_CONCURRENCY) {
      const batch = entries.slice(i, i + LEGACY_IMPORT_READ_CONCURRENCY);
      const read = await Promise.all(
        batch.map(async (entry) => {
          try {
            const raw = await readFile(join(this.chatsDir, entry, SIDECAR_FILE), "utf8");
            return { dirName: entry, parsed: chatThreadSidecarSchema.safeParse(JSON.parse(raw)) };
          } catch {
            return null; // No sidecar / unreadable / bad JSON → skip.
          }
        })
      );
      for (const item of read) {
        if (item === null || !item.parsed.success) continue;
        sidecars.push({ dirName: item.dirName, sidecar: item.parsed.data });
      }
    }
    if (sidecars.length === 0) return "done";

    let importedCount = 0;
    try {
      const insert = this.db().prepare(
        `INSERT OR IGNORE INTO chat_threads
           (thread_id, dir_name, name, anchor_capture_id, archived, pinned, focus_history, created_at, modified_at, schema_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
      );
      const tx = this.db().transaction(() => {
        for (const { dirName, sidecar: s } of sidecars) {
          // A caller that gave up on the bound may have deleted this thread
          // while we were reading. `INSERT OR IGNORE` would not protect it
          // (the row is gone), so re-inserting would resurrect a chat the
          // user just deleted — pointing at a directory `delete()` removed.
          if (deleted.has(s.threadId)) continue;
          const info = insert.run(
            s.threadId,
            dirName,
            s.name,
            s.anchorCaptureId,
            s.archived ? 1 : 0,
            s.pinned ? 1 : 0,
            JSON.stringify(s.focusHistory),
            s.createdAt,
            s.modifiedAt
          );
          if (info.changes > 0) importedCount += 1;
        }
      });
      tx();
    } catch (cause) {
      this.log.warn("chat-thread-store: legacy sidecar import failed", {
        message: errMessage(cause)
      });
      return "done";
    }
    if (importedCount > 0) {
      this.log.info("chat-thread-store: imported legacy sidecars", { count: importedCount });
    }
    return "done";
  }

  /**
   * Build a `YYYY-MM-DD-NNN-<slug>` dir basename and create the (bare)
   * dir. NNN is a per-day sequence: scan existing dirs sharing today's
   * date prefix and take max+1 (3-digit, zero-padded). Loops on a
   * collision so a racing create for the same name+day lands on the next
   * free seq. Returns the basename (the index row stores this).
   */
  private async mintThreadDir(name: string, nowIso: string): Promise<string> {
    const datePrefix = nowIso.slice(0, 10); // YYYY-MM-DD
    const slug = slugifyThreadName(name);

    let existing: string[] = [];
    try {
      existing = await readdir(this.chatsDir);
    } catch {
      existing = [];
    }
    let maxSeq = 0;
    const seqRe = new RegExp(`^${datePrefix}-(\\d{3})-`);
    for (const entry of existing) {
      const m = entry.match(seqRe);
      if (m && m[1] !== undefined) {
        const n = Number.parseInt(m[1], 10);
        if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
      }
    }

    for (let seq = maxSeq + 1; ; seq += 1) {
      const dirName = `${datePrefix}-${String(seq).padStart(3, "0")}-${slug}`;
      const threadDir = join(this.chatsDir, dirName);
      try {
        // `recursive: false` so EEXIST surfaces and we bump the seq.
        await mkdir(threadDir, { recursive: false });
        return dirName;
      } catch (cause) {
        if (isNodeError(cause) && cause.code === "EEXIST") continue;
        // Parent missing — create the chatsDir chain then retry this seq.
        if (isNodeError(cause) && cause.code === "ENOENT") {
          await mkdir(this.chatsDir, { recursive: true });
          continue;
        }
        throw cause;
      }
    }
  }

  /**
   * Idempotently drop the empty `.metadata_never_index` sentinel one level
   * above chatsDir (chatsDir is ~/Documents/PwrSnap/Chats, so the sentinel
   * sits at ~/Documents/PwrSnap/). Defeats Spotlight indexing of captures /
   * chats. Never throws — best-effort.
   */
  private async ensureMetadataNeverIndex(): Promise<void> {
    if (this.sentinelEnsured) return;
    const sentinelPath = join(dirname(this.chatsDir), METADATA_NEVER_INDEX);
    try {
      await stat(sentinelPath);
      this.sentinelEnsured = true;
      return;
    } catch (cause) {
      if (!(isNodeError(cause) && cause.code === "ENOENT")) {
        this.log.warn("chat-thread-store: sentinel stat failed", {
          path: sentinelPath,
          message: errMessage(cause)
        });
        return;
      }
    }
    try {
      await mkdir(dirname(sentinelPath), { recursive: true });
      // `flag: "wx"` = fail if it exists (handles a race with another
      // create) so we never clobber an existing sentinel.
      await writeFile(sentinelPath, "", { encoding: "utf8", flag: "wx" });
      this.sentinelEnsured = true;
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "EEXIST") {
        this.sentinelEnsured = true;
        return;
      }
      this.log.warn("chat-thread-store: sentinel write failed", {
        path: sentinelPath,
        message: errMessage(cause)
      });
    }
  }
}

function rowToSidecar(row: ChatThreadRow): ChatThreadSidecar {
  return {
    schemaVersion: 1,
    threadId: row.thread_id,
    name: row.name,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
    anchorCaptureId: row.anchor_capture_id,
    focusHistory: parseFocusHistory(row.focus_history),
    archived: row.archived === 1,
    pinned: row.pinned === 1,
    provider: row.provider ?? null,
    model: row.model ?? null,
    reasoning: row.reasoning ?? null,
    ownerClientId: row.owner_client_id ?? null
  };
}

/** Parse the `focus_history` JSON column, defaulting to `[]` on any
 *  corruption (never throws — the column is PwrSnap-owned and small). */
function parseFocusHistory(raw: string): ChatFocusEntry[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ChatFocusEntry[]) : [];
  } catch {
    return [];
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === "string";
}

function errMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Resolve when `promise` settles (fulfilled OR rejected) or after `ms`,
 * whichever comes first. Never rejects. The timer is cleared as soon as the
 * promise settles, and `unref`'d so the deadline itself never holds the
 * event loop open. (Only the timer: a parked `readdir` behind a TCC prompt
 * is a ref'd libuv request that keeps the loop alive on its own — this
 * bounds the WAIT, not the underlying read.)
 */
function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    promise.then(done, done);
  });
}
