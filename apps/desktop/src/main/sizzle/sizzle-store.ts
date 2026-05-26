import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { app } from "electron";
import type { SizzleProject, SizzleScene } from "@pwrsnap/shared";
import { getMainLogger } from "../log";

type Logger = ReturnType<typeof getMainLogger>;

export type SizzleStoreConfig = {
  filePath?: string;
  logger?: Logger;
};

type StoredBlob = {
  schemaVersion: 1;
  projects: SizzleProject[];
};

const DEFAULT_BLOB: StoredBlob = { schemaVersion: 1, projects: [] };

export class SizzleStore {
  private readonly filePath: string;
  private readonly log: Logger;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(config: SizzleStoreConfig = {}) {
    this.filePath =
      config.filePath ?? join(app.getPath("userData"), "sizzle-projects.json");
    this.log = config.logger ?? getMainLogger("pwrsnap:sizzle-store");
  }

  async list(): Promise<SizzleProject[]> {
    const blob = await this.readBlob();
    return [...blob.projects].sort(
      (a, b) =>
        new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime()
    );
  }

  async get(id: string): Promise<SizzleProject | null> {
    const blob = await this.readBlob();
    return blob.projects.find((p) => p.id === id) ?? null;
  }

  async create(name: string): Promise<SizzleProject> {
    return this.serialize(async () => {
      const blob = await this.readBlob();
      const now = new Date().toISOString();
      const project: SizzleProject = {
        id: `sz_${randomUUID().slice(0, 12)}`,
        name: name.trim() || "Untitled Sizzle",
        createdAt: now,
        modifiedAt: now,
        scenes: [],
        voice: "onyx",
        ttsModel: "tts-1-hd",
        ttsProvider: "openai",
        resolution: "1080p",
        outputPath: null,
        lastRenderedAt: null
      };
      blob.projects.unshift(project);
      await this.writeBlob(blob);
      return project;
    });
  }

  async update(
    id: string,
    patch: Partial<Omit<SizzleProject, "id" | "createdAt">>
  ): Promise<SizzleProject> {
    return this.serialize(async () => {
      const blob = await this.readBlob();
      const idx = blob.projects.findIndex((p) => p.id === id);
      if (idx < 0) throw new SizzleProjectNotFoundError(id);
      const prev = blob.projects[idx]!;
      const scenes = patch.scenes ? sanitizeScenes(patch.scenes) : prev.scenes;
      const next: SizzleProject = {
        ...prev,
        ...patch,
        scenes,
        id: prev.id,
        createdAt: prev.createdAt,
        modifiedAt: new Date().toISOString()
      };
      blob.projects[idx] = next;
      await this.writeBlob(blob);
      return next;
    });
  }

  async delete(id: string): Promise<void> {
    await this.serialize(async () => {
      const blob = await this.readBlob();
      blob.projects = blob.projects.filter((p) => p.id !== id);
      await this.writeBlob(blob);
    });
  }

  private async readBlob(): Promise<StoredBlob> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") return clone(DEFAULT_BLOB);
      this.log.warn("sizzle-store: read failed, returning empty", {
        path: this.filePath,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return clone(DEFAULT_BLOB);
    }
    if (raw.length === 0) return clone(DEFAULT_BLOB);
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isStoredBlob(parsed)) return clone(DEFAULT_BLOB);
      return parsed;
    } catch (cause) {
      this.log.warn("sizzle-store: parse failed, quarantining", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
      const quarantine = `${this.filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      try {
        await rename(this.filePath, quarantine);
      } catch {
        /* ignore */
      }
      return clone(DEFAULT_BLOB);
    }
  }

  private async writeBlob(blob: StoredBlob): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(blob, null, 2), "utf8");
      await rename(tmp, this.filePath);
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

export class SizzleProjectNotFoundError extends Error {
  constructor(public readonly projectId: string) {
    super(`sizzle: project not found: ${projectId}`);
    this.name = "SizzleProjectNotFoundError";
  }
}

function sanitizeScenes(scenes: SizzleScene[]): SizzleScene[] {
  return scenes.map((s) => ({
    id: s.id || `sc_${randomUUID().slice(0, 10)}`,
    captureId: s.captureId,
    scriptLine: s.scriptLine ?? "",
    durationOverrideSec:
      typeof s.durationOverrideSec === "number" && s.durationOverrideSec > 0
        ? s.durationOverrideSec
        : null
  }));
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function isStoredBlob(v: unknown): v is StoredBlob {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return r.schemaVersion === 1 && Array.isArray(r.projects);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return (
    value instanceof Error && typeof (value as NodeJS.ErrnoException).code === "string"
  );
}

let singleton: SizzleStore | null = null;
export function getSizzleStore(): SizzleStore {
  if (singleton === null) singleton = new SizzleStore();
  return singleton;
}
