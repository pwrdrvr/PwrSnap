import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { app } from "electron";
import {
  defaultSizzleProjectCoverCaptureId,
  normalizeSizzleSequenceBeatContinuity,
  normalizeSizzleTransition,
  type SizzleAudioSource,
  type SizzleBeatTiming,
  type SizzleMediaTrim,
  type SizzleProject,
  type SizzleScene,
  type SizzleSequenceBeat,
  type SizzleVideoFitPolicy
} from "@pwrsnap/shared";
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
const PROJECT_NAME_MAX = 200;

export class SizzleStore {
  private readonly filePath: string;
  private readonly log: Logger;
  private writeQueue: Promise<unknown> = Promise.resolve();
  /**
   * In-memory cache of the parsed-and-sanitized projects blob.
   * Populated on first `readBlob()` and refreshed by `writeBlob()`.
   * Subsequent reads (including the post-mutation broadcast snapshot
   * fetch) skip disk I/O and return a deep clone of the cache.
   *
   * Cache invariant: every `writeBlob` updates the cache BEFORE
   * returning, in the same serialized region. So a `list()` call
   * sequenced after a mutation always sees the just-written state —
   * matching the pre-cache behavior where reads went through disk.
   */
  private cachedBlob: StoredBlob | null = null;
  private cachedBlobNeedsPersist = false;

  constructor(config: SizzleStoreConfig = {}) {
    this.filePath =
      config.filePath ?? join(app.getPath("userData"), "sizzle-projects.json");
    this.log = config.logger ?? getMainLogger("pwrsnap:sizzle-store");
  }

  async list(): Promise<SizzleProject[]> {
    // Reads go through the same serialize queue as writes so a read
    // that races an in-flight rename (e.g., user clicks Render while
    // the debounced script-edit dispatch is mid-write) sees the
    // post-write state, not the pre-write file. Without this the
    // render handler can read stale text and synthesize from it.
    return this.serialize(async () => {
      const blob = await this.readBlob();
      return [...blob.projects].sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
    });
  }

  async get(id: string): Promise<SizzleProject | null> {
    return this.serialize(async () => {
      const blob = await this.readBlob();
      return blob.projects.find((p) => p.id === id) ?? null;
    });
  }

  async persistDerivedFieldsForProject(
    id: string
  ): Promise<{ project: SizzleProject; repaired: boolean } | null> {
    return this.serialize(async () => {
      const blob = await this.readBlob();
      const project = blob.projects.find((p) => p.id === id) ?? null;
      if (project === null) return null;
      const repaired = this.cachedBlobNeedsPersist;
      if (this.cachedBlobNeedsPersist) {
        await this.writeBlob(blob);
      }
      return { project, repaired };
    });
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
        coverCaptureId: null,
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

  async duplicate(id: string, name?: string): Promise<SizzleProject> {
    return this.serialize(async () => {
      const blob = await this.readBlob();
      const source = blob.projects.find((p) => p.id === id);
      if (source === undefined) throw new SizzleProjectNotFoundError(id);
      const now = new Date().toISOString();
      const project: SizzleProject = {
        ...source,
        id: `sz_${randomUUID().slice(0, 12)}`,
        name: duplicateProjectName(source.name, name),
        createdAt: now,
        modifiedAt: now,
        scenes: duplicateScenes(source.scenes),
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
      const coverCaptureId =
        patch.coverCaptureId !== undefined
          ? patch.coverCaptureId
          : prev.coverCaptureId ??
            (patch.scenes !== undefined
              ? defaultSizzleProjectCoverCaptureId(scenes)
              : null);
      const next: SizzleProject = {
        ...prev,
        ...patch,
        coverCaptureId,
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
    // Cache short-circuit. Populated by the first disk read and by
    // every subsequent writeBlob — see `cachedBlob` field comment for
    // the consistency invariant.
    if (this.cachedBlob !== null) return clone(this.cachedBlob);
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") {
        this.cachedBlob = clone(DEFAULT_BLOB);
        this.cachedBlobNeedsPersist = false;
        return clone(this.cachedBlob);
      }
      this.log.warn("sizzle-store: read failed, returning empty", {
        path: this.filePath,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      this.cachedBlob = clone(DEFAULT_BLOB);
      this.cachedBlobNeedsPersist = false;
      return clone(this.cachedBlob);
    }
    if (raw.length === 0) {
      this.cachedBlob = clone(DEFAULT_BLOB);
      this.cachedBlobNeedsPersist = false;
      return clone(this.cachedBlob);
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isStoredBlob(parsed)) {
        this.cachedBlob = clone(DEFAULT_BLOB);
        this.cachedBlobNeedsPersist = false;
        return clone(this.cachedBlob);
      }
      // Normalize scenes on the read path so every consumer sees the
      // new SizzleScene fields (mediaTrim, audioSource, transition)
      // with sensible defaults, regardless of when the project was
      // first written. Without this, projects created before these
      // fields existed have undefined values and crash any consumer
      // doing `scene.mediaTrim.endSec` etc.
      let normalizedNeedsPersist = false;
      for (const project of parsed.projects) {
        if (Array.isArray(project.scenes)) {
          project.scenes = sanitizeScenes(project.scenes);
        }
        if ((project as unknown as Record<string, unknown>).ttsProvider !== "openai") {
          project.ttsProvider = "openai";
          normalizedNeedsPersist = true;
        }
        const existingCoverCaptureId =
          typeof project.coverCaptureId === "string" && project.coverCaptureId.length > 0
            ? project.coverCaptureId
            : null;
        const nextCoverCaptureId =
          existingCoverCaptureId ?? defaultSizzleProjectCoverCaptureId(project.scenes);
        if (project.coverCaptureId !== nextCoverCaptureId) {
          normalizedNeedsPersist = true;
        }
        project.coverCaptureId =
          nextCoverCaptureId;
      }
      this.cachedBlob = parsed;
      this.cachedBlobNeedsPersist = normalizedNeedsPersist;
      return clone(this.cachedBlob);
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
      this.cachedBlob = clone(DEFAULT_BLOB);
      this.cachedBlobNeedsPersist = false;
      return clone(this.cachedBlob);
    }
  }

  private async writeBlob(blob: StoredBlob): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(blob, null, 2), "utf8");
      await rename(tmp, this.filePath);
      // Refresh the in-memory cache AFTER the rename succeeds so a
      // failed write doesn't leave the cache reading-ahead of disk.
      // Stored as a clone — the caller's `blob` reference is shared
      // mutable state; the cache must not alias it.
      this.cachedBlob = clone(blob);
      this.cachedBlobNeedsPersist = false;
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
  return scenes.map(sanitizeScene);
}

function duplicateProjectName(sourceName: string, requestedName?: string): string {
  if (requestedName !== undefined) return clampProjectName(requestedName);
  const suffix = " Copy";
  const base = (sourceName.trim() || "Untitled Sizzle")
    .slice(0, PROJECT_NAME_MAX - suffix.length)
    .trimEnd();
  return `${base}${suffix}`;
}

function clampProjectName(name: string): string {
  const trimmed = name.trim() || "Untitled Sizzle";
  return trimmed.length > PROJECT_NAME_MAX
    ? trimmed.slice(0, PROJECT_NAME_MAX).trimEnd()
    : trimmed;
}

function duplicateScenes(scenes: SizzleScene[]): SizzleScene[] {
  return sanitizeScenes(scenes).map((scene) => {
    const next: SizzleScene = {
      ...scene,
      id: `sc_${randomUUID().slice(0, 10)}`
    };
    if (scene.kind === "sequence") {
      next.kind = "sequence";
      next.beats = (scene.beats ?? []).map((beat) => ({
        ...beat,
        id: `bt_${randomUUID().slice(0, 10)}`
      }));
    }
    return next;
  });
}

function sanitizeScene(s: SizzleScene): SizzleScene {
  const kind = s.kind === "sequence" ? "sequence" : "simple";
  const beats =
    kind === "sequence" ? sanitizeSequenceBeats(s.beats, s.captureId) : [];
  const captureId =
    kind === "sequence" ? beats[0]?.captureId ?? s.captureId : s.captureId;
  const narration = s.narration ?? s.scriptLine ?? "";
  const base: SizzleScene = {
    id: s.id || `sc_${randomUUID().slice(0, 10)}`,
    captureId,
    scriptLine: kind === "sequence" ? narration : s.scriptLine ?? "",
    durationOverrideSec:
      typeof s.durationOverrideSec === "number" && s.durationOverrideSec > 0
        ? s.durationOverrideSec
        : null,
    // New fields with backward-compatible defaults. Older projects on
    // disk predate these — readBlob hands them through here.
    mediaTrim: sanitizeMediaTrim(s.mediaTrim),
    audioSource: kind === "sequence" ? "voiceover" : sanitizeAudioSource(s.audioSource),
    transition: normalizeSizzleTransition(s.transition, { type: "crossfade" })
  };
  if (kind === "sequence") {
    base.kind = "sequence";
    base.narration = narration;
    base.beats = beats;
  }
  return base;
}

function sanitizeSequenceBeats(
  beats: SizzleSequenceBeat[] | undefined,
  fallbackCaptureId: string
): SizzleSequenceBeat[] {
  const source =
    Array.isArray(beats) && beats.length > 0
      ? beats
      : fallbackCaptureId.length > 0
        ? [
            {
              id: `bt_${randomUUID().slice(0, 10)}`,
              captureId: fallbackCaptureId,
              timing: { kind: "offset", startSec: 0, endSec: null },
              mediaTrim: null,
              transition: "cut",
              videoFit: "smart-fit"
            } satisfies SizzleSequenceBeat
          ]
        : [];
  return normalizeSizzleSequenceBeatContinuity(
    source.map((beat) => ({
      id: beat.id || `bt_${randomUUID().slice(0, 10)}`,
      captureId: beat.captureId || fallbackCaptureId,
      timing: sanitizeBeatTiming(beat.timing),
      mediaTrim: sanitizeMediaTrim(beat.mediaTrim),
      transition: normalizeSizzleTransition(beat.transition, {
        type: "cut",
        durationSec: 0
      }),
      videoFit: sanitizeVideoFit(beat.videoFit)
    }))
  );
}

function sanitizeBeatTiming(timing: SizzleBeatTiming | undefined): SizzleBeatTiming {
  // `auto` carries no fields — recognize it explicitly so a saved auto beat
  // survives the round-trip instead of silently degrading to `offset:0`.
  // Any genuinely-unknown kind still falls through to the safe `offset`
  // default below (never throws on read).
  if (timing?.kind === "auto") {
    return { kind: "auto" };
  }
  if (timing?.kind === "phrase") {
    return {
      kind: "phrase",
      phrase: timing.phrase ?? "",
      occurrence:
        typeof timing.occurrence === "number" && Number.isInteger(timing.occurrence) && timing.occurrence > 0
          ? timing.occurrence
          : null,
      offsetSec:
        typeof timing.offsetSec === "number" && Number.isFinite(timing.offsetSec)
          ? timing.offsetSec
          : 0,
      durationSec:
        typeof timing.durationSec === "number" && Number.isFinite(timing.durationSec) && timing.durationSec > 0
          ? timing.durationSec
          : null
    };
  }
  return {
    kind: "offset",
    startSec:
      timing?.kind === "offset" && typeof timing.startSec === "number" && Number.isFinite(timing.startSec)
        ? Math.max(0, timing.startSec)
        : 0,
    endSec:
      timing?.kind === "offset" && typeof timing.endSec === "number" && Number.isFinite(timing.endSec)
        ? timing.endSec
        : null
  };
}

function sanitizeMediaTrim(trim: SizzleMediaTrim | null | undefined): SizzleMediaTrim | null {
  return trim !== undefined && trim !== null
    ? { startSec: trim.startSec, endSec: trim.endSec }
    : null;
}

function sanitizeAudioSource(audioSource: SizzleAudioSource | undefined): SizzleAudioSource {
  return audioSource ?? "auto";
}

function sanitizeVideoFit(videoFit: SizzleVideoFitPolicy | undefined): SizzleVideoFitPolicy {
  return videoFit ?? "smart-fit";
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
