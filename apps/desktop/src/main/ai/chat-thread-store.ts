// Store for PwrSnap's per-thread sidecar (`pwrsnap-thread.json`) + the
// per-turn journal (`pwrsnap-thread.journal.jsonl`), which live next to
// Codex's own rollout file under ~/Documents/PwrSnap/Chats/<thread-dir>/.
// Codex owns the message log; PwrSnap owns name / anchor / focus history /
// archive+pin flags.
//
// Substrate hygiene mirrors DesktopSettingsService deliberately so fixes
// flow between the two:
//   • atomic writes — writeFile(tmp) → rename, ALWAYS (a crash mid-write
//     never corrupts the live sidecar).
//   • serialized write queue — a single promise chain using
//     `.catch(() => undefined).then(task)` so a rejected write doesn't run
//     the next task on the rejection branch and concurrent `update()`s to
//     the same thread can't interleave reads/writes.
//   • corrupt-file quarantine — a sidecar that fails the zod schema is
//     renamed to `*.corrupt-<iso>.json` and treated as absent; we never
//     throw on corrupt data and never delete the user's file.
//
// See docs/solutions/2026-05-12-settings-substrate.md for the rationale
// and apps/desktop/src/main/settings/desktop-settings-service.ts for the
// reference implementation.

import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ChatFocusEntry, ChatThreadSidecar } from "@pwrsnap/shared";
import { chatThreadSidecarSchema } from "@pwrsnap/shared";
import { getMainLogger } from "../log";

type Logger = ReturnType<typeof getMainLogger>;

/** Sidecar file name PwrSnap writes next to Codex's rollout. */
const SIDECAR_FILE = "pwrsnap-thread.json";
/** Append-only per-turn journal (one JSON object per line). */
const JOURNAL_FILE = "pwrsnap-thread.journal.jsonl";
/** Attachments dropped into the thread dir live here. */
const ATTACHMENTS_DIR = "attachments";
/** Spotlight opt-out sentinel — sits one level above chatsDir (i.e. at
 *  ~/Documents/PwrSnap/.metadata_never_index). */
const METADATA_NEVER_INDEX = ".metadata_never_index";
/** Hard cap on focusHistory length — keeps the sidecar small. */
const FOCUS_HISTORY_MAX = 20;
/** Slug length cap for the thread-dir name. */
const SLUG_MAX = 40;

export type ChatThreadStoreConfig = {
  /** The ~/Documents/PwrSnap/Chats root. Injectable for tests. */
  chatsDir: string;
  logger?: Logger;
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

  /**
   * Serializes all writes. Reads aren't gated through this chain — the
   * file system provides crash consistency via the tmp+rename dance, so a
   * reader sees either the prior committed sidecar or the next one, never a
   * torn write.
   */
  private writeQueue: Promise<unknown> = Promise.resolve();

  /** True once the `.metadata_never_index` sentinel drop has been
   *  attempted, so we don't re-stat it on every `create()`. */
  private sentinelEnsured = false;

  constructor(config: ChatThreadStoreConfig) {
    this.chatsDir = config.chatsDir;
    this.log = config.logger ?? getMainLogger("pwrsnap:chat-thread-store");
  }

  /**
   * Mint a fresh thread dir + sidecar. Returns the parsed sidecar.
   *
   * Routed through the write queue so the per-day sequence scan + dir
   * creation can't race a concurrent `create()`.
   */
  async create(opts: { threadId: string; name: string }): Promise<ChatThreadSidecar> {
    return this.enqueue(async () => {
      await this.ensureMetadataNeverIndex();
      const now = new Date().toISOString();
      const threadDir = await this.mintThreadDir(opts.name, now);
      const sidecar = chatThreadSidecarSchema.parse({
        schemaVersion: 1,
        threadId: opts.threadId,
        name: opts.name,
        createdAt: now,
        modifiedAt: now,
        anchorCaptureId: null,
        focusHistory: [],
        archived: false,
        pinned: false
      });
      await mkdir(join(threadDir, ATTACHMENTS_DIR), { recursive: true });
      await this.atomicWriteSidecar(join(threadDir, SIDECAR_FILE), sidecar);
      return sidecar;
    });
  }

  /**
   * Scan `<chatsDir>/*\/pwrsnap-thread.json`, parse each via the zod
   * schema, SKIP (with a logged warn + quarantine) any that fail rather
   * than throwing. Newest-modified-first.
   */
  async list(): Promise<ChatThreadSidecar[]> {
    let entries: string[];
    try {
      entries = await readdir(this.chatsDir);
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") return [];
      this.log.warn("chat-thread-store: list readdir failed", {
        chatsDir: this.chatsDir,
        message: errMessage(cause)
      });
      return [];
    }

    const rows: Array<{ sidecar: ChatThreadSidecar; mtimeMs: number }> = [];
    for (const entry of entries) {
      const sidecarPath = join(this.chatsDir, entry, SIDECAR_FILE);
      let dirStat;
      try {
        dirStat = await stat(join(this.chatsDir, entry));
      } catch {
        continue;
      }
      if (!dirStat.isDirectory()) continue;

      const parsed = await this.readSidecar(sidecarPath);
      if (parsed === null) continue;
      let mtimeMs = 0;
      try {
        mtimeMs = (await stat(sidecarPath)).mtimeMs;
      } catch {
        /* fall through with mtimeMs = 0 */
      }
      rows.push({ sidecar: parsed, mtimeMs });
    }

    rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return rows.map((r) => r.sidecar);
  }

  /** Returns the sidecar for `threadId`, or null when absent / corrupt. */
  async get(threadId: string): Promise<ChatThreadSidecar | null> {
    const located = await this.locate(threadId);
    if (located === null) return null;
    return this.readSidecar(located.sidecarPath);
  }

  /**
   * Atomic-rename patch of the mutable sidecar fields. Bumps `modifiedAt`.
   * Serialized so two concurrent `update()`s to the same thread merge
   * onto each other rather than clobbering — the second read observes the
   * first write's result.
   */
  async update(
    threadId: string,
    patch: Partial<Pick<ChatThreadSidecar, "name" | "anchorCaptureId" | "archived" | "pinned">>
  ): Promise<ChatThreadSidecar> {
    return this.enqueue(async () => {
      const located = await this.locate(threadId);
      if (located === null) {
        throw new Error(`chat-thread-store: update on unknown thread ${threadId}`);
      }
      const current = await this.readSidecar(located.sidecarPath);
      if (current === null) {
        throw new Error(`chat-thread-store: update on corrupt thread ${threadId}`);
      }
      // `undefined` (or key absent) = leave alone; an explicit value
      // (including `false` / `null` / `""`) is a write. Mirrors the
      // settings-substrate `undefined ≠ null ≠ ""` rule.
      const merged: ChatThreadSidecar = {
        ...current,
        name: patch.name !== undefined ? patch.name : current.name,
        anchorCaptureId:
          patch.anchorCaptureId !== undefined ? patch.anchorCaptureId : current.anchorCaptureId,
        archived: patch.archived !== undefined ? patch.archived : current.archived,
        pinned: patch.pinned !== undefined ? patch.pinned : current.pinned,
        modifiedAt: new Date().toISOString()
      };
      await this.atomicWriteSidecar(located.sidecarPath, merged);
      return merged;
    });
  }

  /**
   * Push a focus entry onto `focusHistory`, capped at the last
   * FOCUS_HISTORY_MAX (newest kept). Bumps `modifiedAt`. Serialized.
   */
  async appendFocus(threadId: string, captureId: string): Promise<void> {
    await this.enqueue(async () => {
      const located = await this.locate(threadId);
      if (located === null) {
        throw new Error(`chat-thread-store: appendFocus on unknown thread ${threadId}`);
      }
      const current = await this.readSidecar(located.sidecarPath);
      if (current === null) {
        throw new Error(`chat-thread-store: appendFocus on corrupt thread ${threadId}`);
      }
      const entry: ChatFocusEntry = { captureId, at: new Date().toISOString() };
      const focusHistory = [...current.focusHistory, entry].slice(-FOCUS_HISTORY_MAX);
      const merged: ChatThreadSidecar = {
        ...current,
        focusHistory,
        modifiedAt: new Date().toISOString()
      };
      await this.atomicWriteSidecar(located.sidecarPath, merged);
    });
  }

  /**
   * Append one JSON line to the per-turn journal. The journal is an
   * append-only log — NOT atomically rewritten — so a single `appendFile`
   * is the right primitive (each line is independently parseable; a torn
   * final line is recoverable by skipping it on read). Serialized so two
   * concurrent appends can't interleave bytes within a line.
   */
  async journalAppend(threadId: string, entry: unknown): Promise<void> {
    await this.enqueue(async () => {
      const located = await this.locate(threadId);
      if (located === null) {
        throw new Error(`chat-thread-store: journalAppend on unknown thread ${threadId}`);
      }
      const journalPath = join(located.threadDir, JOURNAL_FILE);
      const line = `${JSON.stringify(entry)}\n`;
      await appendFile(journalPath, line, "utf8");
    });
  }

  /**
   * Read every parseable JSON line from the per-turn journal, in order.
   * A torn / unparseable final line (crash mid-append) is skipped rather
   * than throwing — the journal is append-only and recoverable. Returns
   * `[]` for an unknown thread or a missing journal file.
   */
  async readJournal(threadId: string): Promise<unknown[]> {
    const located = await this.locate(threadId);
    if (located === null) return [];
    const journalPath = join(located.threadDir, JOURNAL_FILE);
    let raw: string;
    try {
      raw = await readFile(journalPath, "utf8");
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
   * Throws if the thread dir can't be located.
   */
  async attachmentsDir(threadId: string): Promise<string> {
    const located = await this.locate(threadId);
    if (located === null) {
      throw new Error(`chat-thread-store: attachmentsDir on unknown thread ${threadId}`);
    }
    const dir = join(located.threadDir, ATTACHMENTS_DIR);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  // ---- internals --------------------------------------------------------

  /**
   * Read + parse a sidecar. Returns null when the file is missing OR fails
   * the zod schema (in which case it's quarantined). Never throws on
   * corrupt data.
   */
  private async readSidecar(sidecarPath: string): Promise<ChatThreadSidecar | null> {
    let raw: string;
    try {
      raw = await readFile(sidecarPath, "utf8");
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") return null;
      this.log.warn("chat-thread-store: sidecar read failed", {
        path: sidecarPath,
        message: errMessage(cause)
      });
      return null;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (cause) {
      await this.quarantine(sidecarPath, `json_parse: ${errMessage(cause)}`);
      return null;
    }

    const result = chatThreadSidecarSchema.safeParse(parsedJson);
    if (!result.success) {
      await this.quarantine(sidecarPath, `schema: ${result.error.message}`);
      return null;
    }
    return result.data;
  }

  /**
   * Find the thread dir + sidecar path for `threadId`. We can't derive the
   * dir name from the id (it's name+date+seq derived), so scan and match on
   * the parsed sidecar's `threadId`. Skips corrupt sidecars.
   */
  private async locate(
    threadId: string
  ): Promise<{ threadDir: string; sidecarPath: string } | null> {
    let entries: string[];
    try {
      entries = await readdir(this.chatsDir);
    } catch {
      return null;
    }
    for (const entry of entries) {
      const threadDir = join(this.chatsDir, entry);
      const sidecarPath = join(threadDir, SIDECAR_FILE);
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(await readFile(sidecarPath, "utf8"));
      } catch {
        continue;
      }
      const result = chatThreadSidecarSchema.safeParse(parsedJson);
      if (result.success && result.data.threadId === threadId) {
        return { threadDir, sidecarPath };
      }
    }
    return null;
  }

  /**
   * Build a `YYYY-MM-DD-NNN-<slug>` dir and create it. NNN is a per-day
   * sequence: scan existing dirs sharing today's date prefix and take
   * max+1 (3-digit, zero-padded). Loops on a collision so a racing create
   * for the same name+day lands on the next free seq.
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
        return threadDir;
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
        // Some other stat error — log and bail without writing.
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

  /** Rename a corrupt sidecar to `<name>.corrupt-<iso>.json`. Never
   *  throws — best-effort, logged at warn. We do NOT delete: it's the
   *  user's data and a future tool may recover from it. */
  private async quarantine(sidecarPath: string, reason: string): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const quarantinePath = `${sidecarPath}.corrupt-${stamp}.json`;
    try {
      await rename(sidecarPath, quarantinePath);
      this.log.warn("chat-thread-store: quarantined corrupt sidecar", {
        path: sidecarPath,
        quarantine: quarantinePath,
        reason
      });
    } catch (cause) {
      this.log.warn("chat-thread-store: failed to quarantine corrupt sidecar", {
        path: sidecarPath,
        reason,
        message: errMessage(cause)
      });
    }
  }

  /** Write the sidecar via tmp + rename so a crash mid-write never
   *  corrupts the live file. NEVER write the final path directly. */
  private async atomicWriteSidecar(sidecarPath: string, value: ChatThreadSidecar): Promise<void> {
    await mkdir(dirname(sidecarPath), { recursive: true });
    const tmpPath = `${sidecarPath}.tmp`;
    const json = `${JSON.stringify(value, null, 2)}\n`;
    try {
      await writeFile(tmpPath, json, "utf8");
      await rename(tmpPath, sidecarPath);
    } catch (cause) {
      try {
        await unlink(tmpPath);
      } catch {
        /* ignore — best-effort cleanup of an orphaned tmp */
      }
      throw cause;
    }
  }

  /**
   * Chain `task` onto the serialized write queue. Mirrors
   * DesktopSettingsService.write: `.catch(() => undefined).then(task)` so
   * the queue's baton is always a resolved promise — a rejected task
   * doesn't run the next one on the rejection branch. The caller of
   * `enqueue` still observes any rejection; only the queue swallows it so
   * subsequent writes proceed.
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.catch(() => undefined).then(task);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === "string";
}

function errMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
