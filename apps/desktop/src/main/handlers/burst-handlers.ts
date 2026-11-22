// Burst Review verbs. Owned by the process that holds the recorder and the
// burst's stills (the agent in split mode — see command-routing.ts).

import { err, ok } from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { persistStillCapture } from "../capture/persist-still-capture";
import { ensureCapturesDirReady } from "../capture/capture-storage-gate";
import { discardBurst, getBurstSessionView, keepBurstFrames } from "../burst/burst-session";

function isBurstId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{6,32}$/.test(value);
}

export function registerBurstHandlers(): void {
  bus.register("burst:get", async (req) => {
    if (!isBurstId(req.burstId)) {
      return err({ kind: "validation", code: "invalid_request", message: "burstId is required" });
    }
    const view = getBurstSessionView(req.burstId);
    if (view === null) {
      return err({ kind: "validation", code: "burst_not_found", message: "This burst has already been closed." });
    }
    return ok(view);
  });

  bus.register("burst:keep", async (req) => {
    if (
      !isBurstId(req.burstId) ||
      !Array.isArray(req.frameIndexes) ||
      req.frameIndexes.length > 5000 ||
      !req.frameIndexes.every((i) => Number.isInteger(i) && i >= 0) ||
      typeof req.stampTime !== "boolean" ||
      (req.pointer !== undefined && typeof req.pointer !== "boolean")
    ) {
      return err({ kind: "validation", code: "invalid_request", message: "burstId, frameIndexes and stampTime are required" });
    }
    const storageBlocked = await ensureCapturesDirReady();
    if (storageBlocked !== null) return storageBlocked;
    return keepBurstFrames(
      req.burstId,
      req.frameIndexes,
      req.stampTime,
      (tempPath, sourceApp, options) => persistStillCapture(tempPath, sourceApp, options),
      req.pointer ?? true
    );
  });

  bus.register("burst:discard", async (req) => {
    if (!isBurstId(req.burstId)) {
      return err({ kind: "validation", code: "invalid_request", message: "burstId is required" });
    }
    await discardBurst(req.burstId);
    return ok(undefined);
  });
}
