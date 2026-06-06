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
// Migration from the old sidecars: `ensureImported()` walks the Chats
// dir ONCE per process and pulls any pre-existing `pwrsnap-thread.json`
// into the index (INSERT OR IGNORE — never overwrites a live row, never
// deletes the sidecar). New threads write only the index row; no sidecar
// is created going forward.

import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type DatabaseT from "better-sqlite3";
import type { ChatFocusEntry, ChatThreadSidecar } from "@pwrsnap/shared";
import { chatThreadSidecarSchema } from "@pwrsnap/shared";
import { getDb } from "../persistence/db";
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

export type ChatThreadStoreConfig = {
  /** The ~/Documents/PwrSnap/Chats root. Injectable for tests. */
  chatsDir: string;
  /** SQLite handle. Defaults to the app singleton (`getDb()`); tests
   *  inject an in-memory DB with the migrations applied. */
  db?: Database;
  logger?: Logger;
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

export class ChatThreadStore {
  private readonly chatsDir: string;
  private readonly log: Logger;
  private readonly injectedDb: Database | null;

  /** True once the `.metadata_never_index` sentinel drop has been
   *  attempted, so we don't re-stat it on every `create()`. */
  private sentinelEnsured = false;
  /** True once the one-time legacy-sidecar import has run for this store
   *  instance (≈ once per process). */
  private imported = false;

  constructor(config: ChatThreadStoreConfig) {
    this.chatsDir = config.chatsDir;
    this.log = config.logger ?? getMainLogger("pwrsnap:chat-thread-store");
    this.injectedDb = config.db ?? null;
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
    this.ensureImported();
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

  /**
   * Create the on-disk chat dir before Codex `thread/start`, so callers can
   * pass the final thread workspace as Codex's cwd instead of inheriting the
   * Electron/dev process cwd.
   */
  async prepareThreadDir(name: string): Promise<PreparedChatThreadDir> {
    this.ensureImported();
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
    this.ensureImported();
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
    this.ensureImported();
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
    this.ensureImported();
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
    this.ensureImported();
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
    this.ensureImported();
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
    this.ensureImported();
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
    this.ensureImported();
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
    this.ensureImported();
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
   * One-time pull of legacy `pwrsnap-thread.json` sidecars into the
   * index. Idempotent (INSERT OR IGNORE on the threadId PK) and
   * non-destructive (the sidecar file is left on disk). Synchronous so
   * the read-modify-write methods stay free of a yield point between
   * their SELECT and UPDATE. Best-effort — a missing Chats dir or a
   * corrupt sidecar is silently skipped.
   */
  private ensureImported(): void {
    if (this.imported) return;
    this.imported = true;

    let entries: string[];
    try {
      entries = readdirSync(this.chatsDir);
    } catch {
      return; // No Chats dir yet → nothing to import.
    }

    const insert = this.db().prepare(
      `INSERT OR IGNORE INTO chat_threads
         (thread_id, dir_name, name, anchor_capture_id, archived, pinned, focus_history, created_at, modified_at, schema_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    );
    let importedCount = 0;
    const tx = this.db().transaction(() => {
      for (const entry of entries) {
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(readFileSync(join(this.chatsDir, entry, SIDECAR_FILE), "utf8"));
        } catch {
          continue; // No sidecar / unreadable / bad JSON → skip.
        }
        const parsed = chatThreadSidecarSchema.safeParse(parsedJson);
        if (!parsed.success) continue;
        const s = parsed.data;
        const info = insert.run(
          s.threadId,
          entry,
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
    try {
      tx();
    } catch (cause) {
      this.log.warn("chat-thread-store: legacy sidecar import failed", {
        message: errMessage(cause)
      });
      return;
    }
    if (importedCount > 0) {
      this.log.info("chat-thread-store: imported legacy sidecars", { count: importedCount });
    }
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
    reasoning: row.reasoning ?? null
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
