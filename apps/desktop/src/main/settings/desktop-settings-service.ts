// Persists PwrSnap user settings to a single JSON file in the app's
// userData directory, plus surfaces Codex CLI discovery + resolution
// to the renderer via the same service.
//
// Mirrors (not lifts) ~/github/PwrAgnt/apps/desktop/src/main/settings/
// desktop-settings-service.ts. The PwrAgnt service is 1100+ LOC and
// couples worktrees/gh/git/messaging discovery — none of which PwrSnap
// needs today. This is a fresh, narrowed implementation that:
//   • atomically writes via tmpfile + fs.rename;
//   • runs every read through an ordered legacy-shape catalog so the
//     reader survives schema growth without forcing migrations on
//     read (we only rewrite on the next `write`);
//   • quarantines unreadable files to `pwrsnap-settings.corrupt-<ts>.json`
//     and falls back to defaults so a corrupted blob doesn't brick
//     the app;
//   • serializes concurrent writes through a single promise chain so
//     two simultaneous renderer dispatches can't interleave reads.
//
// Reuses the existing codex-discovery module — does NOT modify it.
// Translates the desktop-side discovery snapshot into the shared
// shape exposed to the renderer (the desktop module's snapshot
// pre-dates the shared protocol and uses different field names).

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  DesktopCodexCandidateSource as SharedCodexCandidateSource,
  DesktopCodexDiscoveryCandidate as SharedCodexCandidate,
  DesktopCodexDiscoverySnapshot as SharedCodexSnapshot,
  Settings,
  SettingsPatch
} from "@pwrsnap/shared";
import { discoverCodexCommands, resolveCodexCommand } from "./codex-discovery";
import { getMainLogger } from "../log";

type Logger = ReturnType<typeof getMainLogger>;

export type DesktopSettingsServiceConfig = {
  filePath: string;
  logger?: Logger;
};

/** Returns the canonical v1 defaults. Used as the read-path fallback
 *  (missing file / corruption) and as the starting point for any
 *  patch merge. */
export function defaultSettings(): Settings {
  return {
    schemaVersion: 1,
    codex: {
      mode: "auto",
      pinnedPath: "",
      profile: ""
    },
    ai: {
      enabled: false,
      consentAcceptedAt: null
    },
    hotkeys: {
      quickCapture: "CommandOrControl+Shift+P",
      region: "CommandOrControl+Shift+R",
      window: "CommandOrControl+Shift+W"
    },
    experimental: {
      v2FileFormat: false
    }
  };
}

/** One entry in the legacy-shape catalog. Newest first; the first
 *  entry that returns a non-null Settings wins.
 *
 *  Today's catalog has exactly one entry — the current v1 shape. The
 *  pattern is here from day one so adding a v0-recognizer or a future
 *  v2-recognizer is one new entry and zero structural change. See
 *  ~/github/PwrAgnt/docs/config-file-evolution.md. */
type ShapeEntry = {
  shape: string;
  parse(raw: unknown): Settings | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function pickStringOrNull(value: unknown, fallback: string | null): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  return fallback;
}

function pickMode(value: unknown): "auto" | "pinned" {
  return value === "pinned" ? "pinned" : "auto";
}

function parseV1(raw: unknown): Settings | null {
  if (!isRecord(raw)) return null;
  if (raw.schemaVersion !== 1) return null;
  const defaults = defaultSettings();
  const codex = isRecord(raw.codex) ? raw.codex : {};
  const ai = isRecord(raw.ai) ? raw.ai : {};
  const hotkeys = isRecord(raw.hotkeys) ? raw.hotkeys : {};
  const experimental = isRecord(raw.experimental) ? raw.experimental : {};
  return {
    schemaVersion: 1,
    codex: {
      mode: pickMode(codex.mode ?? defaults.codex.mode),
      pinnedPath: pickString(codex.pinnedPath, defaults.codex.pinnedPath),
      profile: pickString(codex.profile, defaults.codex.profile)
    },
    ai: {
      enabled: pickBoolean(ai.enabled, defaults.ai.enabled),
      consentAcceptedAt: pickStringOrNull(ai.consentAcceptedAt, defaults.ai.consentAcceptedAt)
    },
    hotkeys: {
      quickCapture: pickStringOrNull(hotkeys.quickCapture, defaults.hotkeys.quickCapture),
      region: pickStringOrNull(hotkeys.region, defaults.hotkeys.region),
      window: pickStringOrNull(hotkeys.window, defaults.hotkeys.window)
    },
    experimental: {
      v2FileFormat: pickBoolean(experimental.v2FileFormat, defaults.experimental.v2FileFormat)
    }
  };
}

const SHAPE_CATALOG: readonly ShapeEntry[] = [
  { shape: "v1", parse: parseV1 }
];

/** Translate the desktop-side discovery candidate shape (with
 *  `command` / `executable` / `selected` fields) into the shared
 *  shape (`path` / `available`). Renderer compares `candidate.path`
 *  to `snapshot.resolvedPath` for the "Using" badge. */
function toSharedCandidate(input: {
  command: string;
  source: SharedCodexCandidateSource;
  executable: boolean;
  version?: string | undefined;
}): SharedCodexCandidate {
  return {
    path: input.command,
    source: input.source,
    version: input.version ?? null,
    available: input.executable
  };
}

const CODEX_DISCOVERY_CACHE_TTL_MS = 30_000;

export class DesktopSettingsService {
  private readonly filePath: string;
  private readonly log: Logger;

  /**
   * Serializes all writes. Read isn't gated through this chain — the
   * file system itself provides crash consistency via the tmp+rename
   * dance, and reads always observe either the prior committed state
   * or the next one, never a torn write.
   */
  private writeQueue: Promise<unknown> = Promise.resolve();

  private codexSnapshotCache:
    | { snapshot: SharedCodexSnapshot; computedAt: number }
    | null = null;

  constructor(config: DesktopSettingsServiceConfig) {
    this.filePath = config.filePath;
    this.log = config.logger ?? getMainLogger("pwrsnap:settings-service");
  }

  /** Resolved data path. Useful for diagnostics (About page) + tests. */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Load + normalize settings.
   *
   * Returns defaults when the file is missing (first launch). On
   * corruption — JSON parse fail OR no shape in the catalog matches —
   * renames the bad file to `<name>.corrupt-<isoTimestamp>.json`,
   * logs at `warn`, returns defaults. We intentionally do NOT delete
   * the bad file: it's the user's prior config and a future tool may
   * be able to recover from it.
   */
  async read(): Promise<Settings> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") {
        return defaultSettings();
      }
      this.log.warn("settings-service: read failed, using defaults", {
        path: this.filePath,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return defaultSettings();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      await this.quarantine(`json_parse: ${cause instanceof Error ? cause.message : String(cause)}`);
      return defaultSettings();
    }

    for (const entry of SHAPE_CATALOG) {
      const normalized = entry.parse(parsed);
      if (normalized !== null) return normalized;
    }

    await this.quarantine("no_shape_matched");
    return defaultSettings();
  }

  /**
   * Deep-merge `patch` into the current settings and persist atomically.
   *
   * Semantics for the patch:
   *   • `undefined` (or missing key) at any depth means "leave untouched".
   *   • A present value — including `""` (empty string), `null`, `false`,
   *     `0` — IS a write. (`codex.pinnedPath: ""` is how the renderer
   *     clears a pin.)
   *
   * Writes are serialized through a single promise chain so concurrent
   * `write` calls observe each other's results — the second write
   * reads the file the first wrote, not the file both started from.
   *
   * Returns the merged Settings the caller can echo to renderers.
   */
  async write(patch: SettingsPatch): Promise<Settings> {
    const task = async (): Promise<Settings> => {
      const current = await this.read();
      const merged = mergeSettings(current, patch);
      await this.atomicWriteJson(merged);
      // Invalidate the Codex discovery cache whenever a write touches
      // `codex.*`. Otherwise the snapshot's `resolvedPath` (computed
      // from `settings.codex.{mode, pinnedPath}` at snapshot time)
      // can lag the just-written settings by up to 30s, so the AI
      // Providers "Using" badge sticks to the prior choice after a
      // pin. Only invalidate on success so a rejected write doesn't
      // force an extra (uncached) discovery on the next read.
      if (patch.codex !== undefined) this.codexSnapshotCache = null;
      return merged;
    };

    // Chain onto the existing queue so concurrent writes serialize.
    // Use `.catch(() => undefined).then(task)` so the queue's baton is
    // always a resolved Promise — `then(task, task)` runs `task` on
    // both fulfillment and rejection (correct intent) but is harder
    // to reason about, and the prior double-chain through
    // `this.writeQueue = next.then(_, _)` discarded inner results
    // without strictly serializing concurrent writes. The caller of
    // `next` still observes any rejection from `task`; only the
    // queue itself swallows it so subsequent writes can proceed.
    const next = this.writeQueue.catch(() => undefined).then(task);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  /**
   * Returns the current Codex CLI discovery snapshot in the shared
   * shape the renderer consumes. Cached for 30s by default — Codex
   * discovery shells out to `/usr/bin/which` + executes each candidate
   * with `--version`, and the renderer's page-mount call shouldn't
   * pay that on every navigation. The Refresh button passes
   * `force: true` to bypass the cache.
   */
  async getCodexDiscoverySnapshot(opts?: { force?: boolean }): Promise<SharedCodexSnapshot> {
    const force = opts?.force === true;
    if (!force && this.codexSnapshotCache !== null) {
      const age = Date.now() - this.codexSnapshotCache.computedAt;
      if (age < CODEX_DISCOVERY_CACHE_TTL_MS) {
        return this.codexSnapshotCache.snapshot;
      }
    }

    const settings = await this.read();
    const configuredCommand =
      settings.codex.mode === "pinned" && settings.codex.pinnedPath !== ""
        ? settings.codex.pinnedPath
        : undefined;
    const discovery = await discoverCodexCommands({
      configuredCommand,
      env: process.env
    });
    // The shared shape exposes only path/source/version/available — no
    // "selected" flag. The renderer compares each candidate's path to
    // `resolvedPath` to draw the "Using" badge.
    const candidates: SharedCodexCandidate[] = discovery.candidates.map((c) =>
      toSharedCandidate(c)
    );

    let resolvedPath: string | null = null;
    try {
      const resolved = await resolveCodexCommand({
        command:
          settings.codex.mode === "pinned" && settings.codex.pinnedPath !== ""
            ? settings.codex.pinnedPath
            : "codex",
        env: process.env
      });
      resolvedPath = resolved.command;
    } catch (cause) {
      this.log.warn("settings-service: resolveCodexCommand failed", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
      resolvedPath = null;
    }

    const snapshot: SharedCodexSnapshot = {
      candidates,
      resolvedPath,
      refreshedAt: new Date().toISOString()
    };
    this.codexSnapshotCache = { snapshot, computedAt: Date.now() };
    return snapshot;
  }

  // ---- internals ----

  private async quarantine(reason: string): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const quarantinePath = `${this.filePath}.corrupt-${stamp}.json`;
    try {
      await rename(this.filePath, quarantinePath);
      this.log.warn("settings-service: quarantined corrupt settings file", {
        path: this.filePath,
        quarantine: quarantinePath,
        reason
      });
    } catch (cause) {
      this.log.warn("settings-service: failed to quarantine corrupt file", {
        path: this.filePath,
        reason,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }

  private async atomicWriteJson(value: Settings): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    const json = `${JSON.stringify(value, null, 2)}\n`;
    try {
      await writeFile(tmpPath, json, "utf8");
      await rename(tmpPath, this.filePath);
    } catch (cause) {
      // Best-effort cleanup of an orphaned tmp file. If the rename
      // itself failed mid-flight (rare on POSIX), the next write
      // overwrites cleanly.
      try {
        await unlink(tmpPath);
      } catch {
        /* ignore */
      }
      throw cause;
    }
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === "string";
}

/** Deep-merge a `SettingsPatch` onto a `Settings`, with
 *  `undefined`-means-leave-untouched semantics at every level. */
export function mergeSettings(current: Settings, patch: SettingsPatch): Settings {
  return {
    schemaVersion: 1,
    codex: mergeSection(current.codex, patch.codex),
    ai: mergeSection(current.ai, patch.ai),
    hotkeys: mergeSection(current.hotkeys, patch.hotkeys),
    experimental: mergeSection(current.experimental, patch.experimental)
  };
}

function mergeSection<T extends Record<string, unknown>>(
  current: T,
  patch: Partial<T> | undefined
): T {
  if (patch === undefined) return current;
  const out: Record<string, unknown> = { ...current };
  for (const key of Object.keys(patch) as Array<keyof T & string>) {
    const value = patch[key];
    if (value === undefined) continue; // leave untouched
    out[key] = value;
  }
  return out as T;
}
