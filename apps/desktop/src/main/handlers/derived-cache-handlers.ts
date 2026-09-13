// Ownership wiring for the derived-cache admission gate.
//
// The gate itself (`persistence/derived-cache-gate.ts`) is process-local: it
// sequences deletes against in-flight writes inside ONE process. That is the
// whole story in combined mode, which is the default. Under
// `experimental.processSplit` it is not, because the two halves are split
// across the process boundary:
//
//   writers   `video:*`    → agent   (co-located with the recorder)
//   deleters  `storage:*`  → library (Settings → Storage)
//             `library:purge` / `library:purgeAll` → library
//             boot GC → agent already (`role !== "library"` in index.ts)
//
// So the library is given a forwarder instead of a gate, and the agent
// registers the verb that runs the operation for it.
//
// `persistence/` deliberately does not import the command bus — nothing else
// under it does — which is why the forwarder is installed from here rather
// than reached for from inside the gate.

import { err, ok } from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { getMainLogger } from "../log";
import type { ProcessRole } from "../process-role";
import {
  installDerivedCacheCleanupForwarder,
  type DerivedCacheCleanupRequest
} from "../persistence/derived-cache-gate";
import { clearRenderCache, trimRenderCache } from "../persistence/render-cache-maintenance";
import { purgeCacheForCapture } from "../persistence/source-store";

const log = getMainLogger("pwrsnap:derived-cache-handlers");

/** Capture ids are nanoid-shaped. Anything else is not a capture and must
 *  not reach a path join that ends in `rm -rf`. */
const VALID_CAPTURE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Install the cleanup owner for `role`.
 *
 * Library: a forwarder, so every cleanup becomes one awaited bus dispatch to
 * the agent. Agent / combined: the verb that performs it. Combined registers
 * the verb too — nothing dispatches it there, but a registered handler is
 * what stops the bus treating the name as unknown if something ever does.
 */
export function registerDerivedCacheCleanupOwner(role: ProcessRole): void {
  if (role === "library") {
    installDerivedCacheCleanupForwarder(async (request) => {
      // `principal: "bridge"` is what the handler admits. The bus forwards
      // this to the agent because the library never registers the verb.
      const result = await bus.dispatch("storage:runCacheCleanup", request, {
        principal: "bridge"
      });
      if (!result.ok) throw new Error(result.error.message);
    });
    return;
  }

  bus.register("storage:runCacheCleanup", async (req, ctx) => {
    // Internal only. A renderer reaching this could delete any capture's
    // derivatives by id, and there is no user-facing verb that needs it —
    // `storage:maintainRenderCache` and `library:purge` are the front doors.
    if (ctx.principal !== "bridge") {
      return err({
        kind: "permission",
        code: "internal_command",
        message: "storage:runCacheCleanup is main-process-only"
      });
    }
    const request = req as DerivedCacheCleanupRequest;
    switch (request?.operation) {
      case "purge": {
        if (typeof request.captureId !== "string" || !VALID_CAPTURE_ID.test(request.captureId)) {
          return err({
            kind: "validation",
            code: "invalid_capture_id",
            message: "storage:runCacheCleanup: captureId must be a capture id"
          });
        }
        await purgeCacheForCapture(request.captureId);
        break;
      }
      case "clear":
        await clearRenderCache();
        break;
      case "trim":
        await trimRenderCache();
        break;
      default:
        return err({
          kind: "validation",
          code: "invalid_request",
          message: "storage:runCacheCleanup: unknown operation"
        });
    }
    log.debug("derived cache cleanup completed", { operation: request.operation });
    return ok({});
  });
}
