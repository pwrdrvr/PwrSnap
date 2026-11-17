// `appleFm:*` — Settings' view of Apple's on-device model.
//
// Both verbs are read-only towards the system: `status` asks macOS what it
// reports, `test` sends one fixed text prompt. Neither takes a capture, a
// path, or any text from the caller, so there is nothing for a renderer or a
// bridged agent to steer.

import {
  APPLE_FM_MODEL_ID,
  appleFmStateCopy,
  err,
  ok,
  type AppleFmStatus,
  type AppleFmTestResult,
  type PwrSnapError,
  type Result
} from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { getMainLogger } from "../log";
import { appleFmErrorFromOutput, appleFmScratchDir } from "../ai/apple-fm/enrichment";
import { AppleFmTimeoutError, runAppleFm, type FmRunner } from "../ai/apple-fm/fm-cli";
import { getAppleFmStatusService } from "../ai/apple-fm/service";
import type { AppleFmStatusService } from "../ai/apple-fm/status";
import { mkdir } from "node:fs/promises";

const log = getMainLogger("pwrsnap:apple-fm-handlers");

/** A text-only turn answers in about two seconds; this bounds a wedged one. */
export const APPLE_FM_TEST_TIMEOUT_MS = 60_000;

/** The whole of what the test sends. Fixed; nothing of the user's. */
export const APPLE_FM_TEST_PROMPT = "Reply with the single word: OK";

export function registerAppleFmHandlers(
  deps: { status?: AppleFmStatusService; run?: FmRunner; scratchDir?: string } = {}
): void {
  const status = deps.status ?? getAppleFmStatusService();
  const run = deps.run ?? runAppleFm;

  bus.register("appleFm:status", async (req): Promise<Result<AppleFmStatus, PwrSnapError>> => {
    if (req.force !== undefined && typeof req.force !== "boolean") {
      return err({
        kind: "validation",
        code: "invalid_force",
        message: "appleFm:status: force must be a boolean"
      });
    }
    return ok(await status.get(req.force === true));
  });

  bus.register(
    "appleFm:test",
    async (_req, ctx): Promise<Result<AppleFmTestResult, PwrSnapError>> => {
      // Always ask macOS afresh: a test that passes on a stale "ready" would
      // be reporting the cache.
      const current = await status.get(true);
      if (current.state !== "ready") {
        return err({
          kind: "settings",
          code: "apple_fm_not_ready",
          message: appleFmStateCopy(current).title
        });
      }
      const cwd = deps.scratchDir ?? appleFmScratchDir();
      const startedAt = performance.now();
      try {
        await mkdir(cwd, { recursive: true });
        const result = await run(["respond", "--no-stream", "--greedy", "--model", APPLE_FM_MODEL_ID], {
          stdin: APPLE_FM_TEST_PROMPT,
          timeoutMs: APPLE_FM_TEST_TIMEOUT_MS,
          cwd,
          signal: ctx.signal
        });
        if (result.code !== 0 || result.stdout.trim().length === 0) {
          const failure = appleFmErrorFromOutput(`${result.stderr}\n${result.stdout}`);
          if (failure.setupRelated) status.invalidate();
          return err({
            kind: "settings",
            code: "apple_fm_test_failed",
            message: failure.message.charAt(0).toUpperCase() + failure.message.slice(1)
          });
        }
        return ok({ ms: Math.round(performance.now() - startedAt), modelLabel: current.modelLabel });
      } catch (error) {
        log.warn("appleFm:test failed", {
          message: error instanceof Error ? error.message : String(error)
        });
        return err({
          kind: "settings",
          code: "apple_fm_test_failed",
          message:
            error instanceof AppleFmTimeoutError
              ? "The on-device model didn't answer in time."
              : "The on-device model couldn't be run."
        });
      }
    }
  );
}
