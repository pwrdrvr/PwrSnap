// The user's interactive login-shell PATH, resolved off the main thread
// and never on the startup/window critical path.
//
// Why this exists: a Finder/Dock-launched .app inherits launchd's minimal
// PATH, which omits nvm / Homebrew bin dirs. The only things PwrSnap
// spawns by *bare command name* are user-installed CLIs:
//   • `codex` (Codex App Server discovery — Settings → AI binary list)
//   • ACP agent CLIs (`kimi`/`gemini`/`qwen`/…) for chat/enrichment
//   • `ffmpeg`, only as a last-resort fallback when the bundled
//     PwrSnapFFmpeg is missing (a power user expects "the ffmpeg on my
//     PATH" to work)
// Everything on the capture path (`/usr/sbin/screencapture`, the bundled
// Swift recorder, the bundled ffmpeg) uses absolute paths and does NOT
// need this.
//
// Design (per the 2026-06 review — replaces the earlier blocking,
// whole-env, disk-cached hydration):
//   • We carry ONLY `PATH`. Not the whole shell env — no replaying HOME,
//     NVM_DIR, or instance-specific vars (PWRSNAP_*/ELECTRON_*) that
//     poisoned the previous cached implementation.
//   • Resolution runs in a worker thread (execFileSync of the login
//     shell would freeze compositing for every window on the main
//     thread). It NEVER blocks startup: `prewarm()` is fire-and-forget.
//   • Consumers that actually spawn (`codex`/ACP discovery) `await
//     value()` — which returns instantly once resolved, or awaits the
//     in-flight resolve otherwise. They're all deferred several seconds
//     past launch, so the ~1s resolve is invisible.
//   • On resolve we also update `process.env.PATH` (union with the
//     launch PATH) so child processes that simply inherit the env —
//     e.g. the ffmpeg-PATH fallback — pick up the user's PATH without
//     every spawn site having to await this service.
//   • No on-disk cache. The only value worth persisting was avoiding a
//     blocking spawn on the critical path; nothing blocks now, so the
//     encryption / corruption-quarantine / SHELL-invalidation machinery
//     is gone. We re-resolve once per launch, in the background.
//   • No-op on win32 (launchd-PATH starvation is a macOS/Linux problem).

import { delimiter } from "node:path";
import { getMainLogger } from "./log";
import { runShellEnvRefreshWorker } from "./workers/shell-env-refresh-worker-client";

const log = getMainLogger("pwrsnap:login-shell-path");

/** Union two PATH strings, `primary` entries first, de-duplicated. */
function unionPath(primary: string | undefined, secondary: string | undefined): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const source of [primary, secondary]) {
    if (source === undefined || source.length === 0) continue;
    for (const dir of source.split(delimiter)) {
      if (dir.length === 0 || seen.has(dir)) continue;
      seen.add(dir);
      out.push(dir);
    }
  }
  return out.join(delimiter);
}

class LoginShellPath {
  private resolved: string | null = null;
  private inFlight: Promise<string> | null = null;

  /**
   * Kick off resolution in the background. Fire-and-forget — the caller
   * never awaits, so this is safe to call on the startup path. No-op on
   * win32. Idempotent (a second call rides the first's in-flight work).
   */
  prewarm(): void {
    if (process.platform === "win32") return;
    void this.value();
  }

  /**
   * The PATH to spawn child processes with: the user's interactive
   * login-shell PATH unioned with the launch-time PATH. Returns the
   * cached value immediately once resolved; otherwise awaits the
   * off-thread resolve (never blocks the main thread). Never throws —
   * falls back to the launch-time PATH on any failure. On win32 returns
   * the existing PATH without spawning anything.
   */
  async value(): Promise<string> {
    if (this.resolved !== null) return this.resolved;
    if (process.platform === "win32") {
      this.resolved = process.env.PATH ?? "";
      return this.resolved;
    }
    this.inFlight ??= this.resolve();
    return this.inFlight;
  }

  private async resolve(): Promise<string> {
    const launchPath = process.env.PATH;
    try {
      const shellEnv = await runShellEnvRefreshWorker();
      // Carry ONLY PATH out of the resolved shell env — nothing else.
      const merged = unionPath(shellEnv?.PATH, launchPath);
      this.resolved = merged;
      // Keep process.env.PATH in sync so plain inherited-env spawns (the
      // ffmpeg-on-PATH fallback) resolve against the user's PATH without
      // awaiting this service. Only PATH is touched.
      process.env.PATH = merged;
      log.info("login-shell PATH resolved", {
        entries: merged.split(delimiter).length,
        shellResolved: shellEnv?.PATH !== undefined && shellEnv.PATH.length > 0
      });
      return merged;
    } catch (cause) {
      this.resolved = launchPath ?? "";
      log.warn("login-shell PATH resolve failed; using launch PATH", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return this.resolved;
    } finally {
      this.inFlight = null;
    }
  }

  /** Test-only: clear cached resolution + in-flight work. */
  __resetForTests(): void {
    this.resolved = null;
    this.inFlight = null;
  }
}

/** Process-wide singleton. */
export const loginShellPath = new LoginShellPath();
