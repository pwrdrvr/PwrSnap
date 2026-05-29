import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app } from "electron";
import type { ChatSession } from "@pwrsnap/shared";
import { getMainLogger } from "../log";

type Logger = ReturnType<typeof getMainLogger>;

export type ChatStoreConfig = {
  filePath?: string;
  logger?: Logger;
};

type StoredBlob = {
  schemaVersion: 1;
  sessions: ChatSession[];
};

const DEFAULT_BLOB: StoredBlob = { schemaVersion: 1, sessions: [] };

/**
 * One Codex chat session per Sizzle project. Same atomic-write +
 * in-memory cache + parse-fail-quarantine pattern as `SizzleStore` —
 * the file at `<userData>/sizzle-chat-sessions.json` records the live
 * thread id + scratch dir so a project's chat survives navigation
 * within the running app and the scratch dir can be reaped on delete.
 */
export class ChatStore {
  private readonly filePath: string;
  private readonly log: Logger;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private cachedBlob: StoredBlob | null = null;

  constructor(config: ChatStoreConfig = {}) {
    this.filePath =
      config.filePath ?? join(app.getPath("userData"), "sizzle-chat-sessions.json");
    this.log = config.logger ?? getMainLogger("pwrsnap:chat-store");
  }

  async list(): Promise<ChatSession[]> {
    return this.serialize(async () => {
      const blob = await this.readBlob();
      return [...blob.sessions];
    });
  }

  async getByProjectId(projectId: string): Promise<ChatSession | null> {
    return this.serialize(async () => {
      const blob = await this.readBlob();
      return blob.sessions.find((s) => s.projectId === projectId) ?? null;
    });
  }

  async getBySessionId(sessionId: string): Promise<ChatSession | null> {
    return this.serialize(async () => {
      const blob = await this.readBlob();
      return blob.sessions.find((s) => s.sessionId === sessionId) ?? null;
    });
  }

  /** Insert or replace the session for a project (one row per project). */
  async upsert(session: ChatSession): Promise<ChatSession> {
    return this.serialize(async () => {
      const blob = await this.readBlob();
      const idx = blob.sessions.findIndex((s) => s.projectId === session.projectId);
      if (idx >= 0) blob.sessions[idx] = session;
      else blob.sessions.push(session);
      await this.writeBlob(blob);
      return session;
    });
  }

  /** Remove a project's session row. Returns the removed row (so callers
   *  can reap its scratch dir) or null when there was none. */
  async deleteByProjectId(projectId: string): Promise<ChatSession | null> {
    return this.serialize(async () => {
      const blob = await this.readBlob();
      const idx = blob.sessions.findIndex((s) => s.projectId === projectId);
      if (idx < 0) return null;
      const [removed] = blob.sessions.splice(idx, 1);
      await this.writeBlob(blob);
      return removed ?? null;
    });
  }

  private async readBlob(): Promise<StoredBlob> {
    if (this.cachedBlob !== null) return clone(this.cachedBlob);
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") {
        this.cachedBlob = clone(DEFAULT_BLOB);
        return clone(this.cachedBlob);
      }
      this.log.warn("chat-store: read failed, returning empty", {
        path: this.filePath,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      this.cachedBlob = clone(DEFAULT_BLOB);
      return clone(this.cachedBlob);
    }
    if (raw.length === 0) {
      this.cachedBlob = clone(DEFAULT_BLOB);
      return clone(this.cachedBlob);
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isStoredBlob(parsed)) {
        this.cachedBlob = clone(DEFAULT_BLOB);
        return clone(this.cachedBlob);
      }
      this.cachedBlob = parsed;
      return clone(this.cachedBlob);
    } catch (cause) {
      this.log.warn("chat-store: parse failed, quarantining", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
      const quarantine = `${this.filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      try {
        await rename(this.filePath, quarantine);
      } catch {
        /* ignore */
      }
      this.cachedBlob = clone(DEFAULT_BLOB);
      return clone(this.cachedBlob);
    }
  }

  private async writeBlob(blob: StoredBlob): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(blob, null, 2), "utf8");
      await rename(tmp, this.filePath);
      this.cachedBlob = clone(blob);
    } catch (cause) {
      try {
        await unlink(tmp);
      } catch {
        /* ignore */
      }
      throw cause;
    }
  }

  private async serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.catch(() => undefined).then(task);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function isStoredBlob(v: unknown): v is StoredBlob {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return r.schemaVersion === 1 && Array.isArray(r.sessions);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === "string";
}

let singleton: ChatStore | null = null;
export function getChatStore(): ChatStore {
  if (singleton === null) singleton = new ChatStore();
  return singleton;
}
