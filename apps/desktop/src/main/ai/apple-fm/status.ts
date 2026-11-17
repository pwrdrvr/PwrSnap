// Reads what macOS reports about the on-device model, and nothing more.
//
// The tool being on disk is not readiness: `/usr/bin/fm` ships on Macs that
// cannot run the model. So the probe asks the tool three read-only questions
// and classifies its own sentences. It never agrees to Apple's terms, never
// writes fm's configuration, and never runs a model turn.
//
// The sentences matched below are the tool's own (macOS 27.2). A sentence
// this build does not recognise is reported as `unavailable` with the text
// verbatim rather than guessed into a known state.

import { access, constants } from "node:fs/promises";
import type { AppleFmState, AppleFmStatus } from "@pwrsnap/shared";
import { APPLE_FM_BINARY, runAppleFm, type FmRunner, type FmRunResult } from "./fm-cli";

/** Each probe command answers in tens of milliseconds; this is a hang bound. */
export const APPLE_FM_PROBE_TIMEOUT_MS = 10_000;

const DETAIL_MAX = 240;

export type AppleFmProbeDeps = {
  platform: NodeJS.Platform;
  macosVersion: () => string | null;
  fileExists: (path: string) => Promise<boolean>;
  run: FmRunner;
  now: () => number;
  signal?: AbortSignal;
};

export function defaultAppleFmProbeDeps(
  macosVersion: () => string | null
): Omit<AppleFmProbeDeps, "signal"> {
  return {
    platform: process.platform,
    macosVersion,
    fileExists: async (path) => {
      try {
        await access(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    run: runAppleFm,
    now: () => Date.now()
  };
}

function bounded(text: string): string | null {
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (line === undefined) return null;
  const clean = line.replace(/^Error:\s*/i, "");
  return clean.length > DETAIL_MAX ? `${clean.slice(0, DETAIL_MAX - 1)}…` : clean;
}

/** True when any of the tool's output says its terms are not agreed to.
 *  Covers `license --status` ("Not agreed. Run 'sudo fm license' …") and the
 *  banner every other command prints instead of running. */
export function saysLicenseRequired(text: string): boolean {
  return /\bnot agreed\b/i.test(text);
}

export type FmUnavailableState = Extract<
  AppleFmState,
  "device-not-eligible" | "apple-intelligence-off" | "model-not-ready" | "unavailable"
>;

/** Classify the reason macOS gives for an unavailable system model. */
export function classifyUnavailableReason(reason: string): FmUnavailableState {
  if (/does not support Apple Intelligence/i.test(reason)) return "device-not-eligible";
  if (/Apple Intelligence is not enabled/i.test(reason)) return "apple-intelligence-off";
  if (/not available\. Try again later|not ready/i.test(reason)) return "model-not-ready";
  return "unavailable";
}

export type FmModelsAnswer =
  | { available: true; modelLabel: string | null }
  | { available: false; reason: string | null }
  | null;

/** The `system` row of `fm models`:
 *    ✓ system (AFM 3 Core)
 *    ✗ system (This device does not support Apple Intelligence.)
 *  Null when there is no such row. The `pcc` row is never read. */
export function parseFmModelsSystemRow(stdout: string): FmModelsAnswer {
  for (const raw of stdout.split("\n")) {
    const match = /^\s*([✓✗])\s+system\b\s*(?:\((.*)\))?\s*$/u.exec(raw);
    if (match === null) continue;
    const note = match[2]?.trim() ?? "";
    return match[1] === "✓"
      ? { available: true, modelLabel: note.length > 0 ? note : null }
      : { available: false, reason: note.length > 0 ? note : null };
  }
  return null;
}

/** `fm config get default-model-provider` prints `(none)` when unset. */
export function isFmDefaultProviderUnset(result: FmRunResult): boolean {
  return result.code === 0 && result.stdout.trim() === "(none)";
}

export async function probeAppleFmStatus(deps: AppleFmProbeDeps): Promise<AppleFmStatus> {
  const base = { modelLabel: null, detail: null, checkedAt: deps.now() };
  if (deps.platform !== "darwin") {
    return { ...base, state: "unsupported-platform", macosVersion: null };
  }
  const macosVersion = deps.macosVersion();
  const answer = (state: AppleFmState, extra: Partial<AppleFmStatus> = {}): AppleFmStatus => ({
    ...base,
    state,
    macosVersion,
    ...extra
  });
  if (!(await deps.fileExists(APPLE_FM_BINARY))) return answer("needs-macos");

  const run = (args: readonly string[]): Promise<FmRunResult> =>
    deps.run(args, {
      timeoutMs: APPLE_FM_PROBE_TIMEOUT_MS,
      ...(deps.signal !== undefined ? { signal: deps.signal } : {})
    });

  try {
    const license = await run(["license", "--status"]);
    const licenseText = `${license.stdout}\n${license.stderr}`;
    if (saysLicenseRequired(licenseText)) {
      return answer("license-required", { detail: bounded(licenseText) });
    }
    if (license.code !== 0) {
      return answer("probe-failed", { detail: bounded(licenseText) });
    }

    const provider = await run(["config", "get", "default-model-provider"]);
    if (saysLicenseRequired(`${provider.stdout}\n${provider.stderr}`)) {
      return answer("license-required", { detail: bounded(`${provider.stdout}\n${provider.stderr}`) });
    }
    if (provider.code !== 0) {
      // The guard could not be read, so it cannot be relied on. Fail closed.
      return answer("probe-failed", { detail: bounded(`${provider.stderr}\n${provider.stdout}`) });
    }
    // The configured value is the user's own and can hold a URL; not echoed.
    if (!isFmDefaultProviderUnset(provider)) return answer("provider-override");

    // Exit status is ignored on purpose: `fm models` exits 1 when ANY model
    // is unavailable, and the cloud model always is outside Terminal.
    const models = await run(["models"]);
    const modelsText = `${models.stdout}\n${models.stderr}`;
    if (saysLicenseRequired(modelsText)) {
      return answer("license-required", { detail: bounded(modelsText) });
    }
    const system = parseFmModelsSystemRow(models.stdout);
    if (system === null) return answer("probe-failed", { detail: bounded(modelsText) });
    if (system.available) return answer("ready", { modelLabel: system.modelLabel });
    return answer(system.reason !== null ? classifyUnavailableReason(system.reason) : "unavailable", {
      detail: system.reason
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return answer("probe-failed", {
      detail: bounded(error instanceof Error ? error.message : String(error))
    });
  }
}

/**
 * One cached answer per process, single-flight, refreshed only when asked.
 *
 * There is no TTL and nothing polls: the Settings screen's "Check again"
 * passes `force`, and a caption run that fails for a setup reason calls
 * `invalidate()` so the next read asks macOS again. Same posture as the
 * store-owned Codex/ACP discovery, kept separate because it probes no
 * install and depends on no setting.
 */
export class AppleFmStatusService {
  private cached: AppleFmStatus | null = null;
  private inflight: Promise<AppleFmStatus> | null = null;

  constructor(private readonly probe: () => Promise<AppleFmStatus>) {}

  /** The last answer without probing, or null if nothing has asked yet. */
  peek(): AppleFmStatus | null {
    return this.cached;
  }

  invalidate(): void {
    this.cached = null;
  }

  async get(force = false): Promise<AppleFmStatus> {
    if (!force && this.cached !== null) return this.cached;
    if (this.inflight !== null) return this.inflight;
    const run = this.probe().then(
      (status) => {
        this.cached = status;
        return status;
      }
    );
    const tracked = run.finally(() => {
      if (this.inflight === tracked) this.inflight = null;
    });
    this.inflight = tracked;
    return tracked;
  }
}
