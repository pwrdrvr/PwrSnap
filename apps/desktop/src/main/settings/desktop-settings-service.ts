// Atomic write via tmp+rename. Reads route through an ordered legacy-
// shape catalog (see SHAPE_CATALOG below) so schema growth doesn't
// force eager migrations on read — we rewrite on the next `write`.
// Concurrent writes serialize through a single promise chain.

import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type {
  CodexTestResult,
  DesktopCodexCandidateSource as SharedCodexCandidateSource,
  DesktopCodexDiscoveryCandidate as SharedCodexCandidate,
  DesktopCodexDiscoverySnapshot as SharedCodexSnapshot,
  Settings,
  SettingsPatch
} from "@pwrsnap/shared";
import {
  compareCodexCliVersions,
  discoverCodexCommands,
  MINIMUM_CODEX_CLI_VERSION,
  resolveCodexCommand
} from "./codex-discovery";
import { getMainLogger } from "../log";

const execFile = promisify(execFileCallback);

/** Per-probe timeout for Codex `--version` in `testCodex`. Mirrors
 *  PwrAgnt's `DEFAULT_PROBE_TIMEOUT_MS`. */
const CODEX_TEST_TIMEOUT_MS = 7500;
const ERROR_MESSAGE_LIMIT = 240;

type Logger = ReturnType<typeof getMainLogger>;

export type DesktopSettingsServiceConfig = {
  filePath: string;
  logger?: Logger;
};

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
      // Quick Capture default moved off ⌘⇧P (collides with Print in
      // browsers + iWork) to ⌘⇧C. Region + Window default to UNBOUND
      // since Quick Capture's auto mode covers both — power users can
      // bind them explicitly from Settings → Hotkeys if they want a
      // dedicated chord. Video Capture is the new entry; the recording
      // surface isn't built yet, but the binding fires today so the
      // global-shortcut registration path is exercised end-to-end.
      quickCapture: "CommandOrControl+Shift+C",
      region: "",
      window: "",
      videoCapture: "CommandOrControl+Shift+V"
    },
    experimental: {
      v2FileFormat: false
    },
    updates: {
      // Default to stable. Power users + beta testers flip to
      // "prerelease" in Settings; auto-updater picks it up on the next
      // check (hourly, or immediately via Help → Check for Updates).
      channel: "latest"
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
  const updates = isRecord(raw.updates) ? raw.updates : {};
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
      quickCapture: pickString(hotkeys.quickCapture, defaults.hotkeys.quickCapture),
      region: pickString(hotkeys.region, defaults.hotkeys.region),
      window: pickString(hotkeys.window, defaults.hotkeys.window),
      // `videoCapture` landed after v1 shipped; older files won't have
      // it. pickString fills in the current default for that case so
      // the field is always present in-memory.
      videoCapture: pickString(hotkeys.videoCapture, defaults.hotkeys.videoCapture)
    },
    experimental: {
      v2FileFormat: pickBoolean(experimental.v2FileFormat, defaults.experimental.v2FileFormat)
    },
    updates: {
      // `updates.channel` landed after v1 shipped; older files won't
      // have it. Fall back to the current default ("latest") so the
      // field is always present in-memory.
      channel: updates.channel === "prerelease" ? "prerelease" : defaults.updates.channel
    }
  };
}

const SHAPE_CATALOG: readonly ShapeEntry[] = [
  { shape: "v1", parse: parseV1 }
];

// Translate the desktop-side discovery candidate shape into the shared
// shape exposed to the renderer.
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

  /**
   * Spawn the currently-resolved Codex binary with `--version`, parse
   * the banner, and version-check against `MINIMUM_CODEX_CLI_VERSION`.
   * Mirrors PwrAgnt's `CredentialTester.testCodex` shape so a future
   * lift of the tester arrives at the same protocol.
   */
  async testCodex(): Promise<CodexTestResult> {
    const startedAt = Date.now();
    const settings = await this.read();
    let resolvedCommand: string | null = null;
    try {
      const resolved = await resolveCodexCommand({
        command:
          settings.codex.mode === "pinned" && settings.codex.pinnedPath !== ""
            ? settings.codex.pinnedPath
            : "codex",
        env: process.env
      });
      resolvedCommand = resolved.command;
    } catch {
      resolvedCommand = null;
    }

    if (resolvedCommand === null) {
      return {
        status: "unset",
        testedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        account: null
      };
    }

    const probeStart = Date.now();
    try {
      const { stdout, stderr } = await execFile(resolvedCommand, ["--version"], {
        timeout: CODEX_TEST_TIMEOUT_MS
      });
      const durationMs = Date.now() - probeStart;
      const testedAt = new Date().toISOString();
      const output = `${stdout?.toString() ?? ""}\n${stderr?.toString() ?? ""}`;
      const match = output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/);
      if (match) {
        const version = match[1] as string;
        if (compareCodexCliVersions(version, MINIMUM_CODEX_CLI_VERSION) < 0) {
          return {
            status: "failed",
            testedAt,
            durationMs,
            account: resolvedCommand,
            errorMessage: `Codex CLI ${version} is older than the minimum supported version ${MINIMUM_CODEX_CLI_VERSION}`
          };
        }
        return {
          status: "ok",
          testedAt,
          durationMs,
          account: resolvedCommand,
          detail: version
        };
      }
      return {
        status: "failed",
        testedAt,
        durationMs,
        account: resolvedCommand,
        errorMessage: "version banner not recognized in stdout/stderr"
      };
    } catch (cause) {
      return {
        status: "failed",
        testedAt: new Date().toISOString(),
        durationMs: Date.now() - probeStart,
        account: resolvedCommand,
        errorMessage: clipError(cause)
      };
    }
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

export function mergeSettings(current: Settings, patch: SettingsPatch): Settings {
  return {
    schemaVersion: 1,
    codex: mergeSection(current.codex, patch.codex),
    ai: mergeSection(current.ai, patch.ai),
    hotkeys: mergeSection(current.hotkeys, patch.hotkeys),
    experimental: mergeSection(current.experimental, patch.experimental),
    updates: mergeSection(current.updates, patch.updates)
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

function clipError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.name === "AbortError"
        ? "request timed out"
        : error.message
      : String(error);
  return message.length <= ERROR_MESSAGE_LIMIT
    ? message
    : `${message.slice(0, ERROR_MESSAGE_LIMIT - 1)}…`;
}
