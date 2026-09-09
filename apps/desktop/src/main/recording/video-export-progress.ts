import { EVENT_CHANNELS } from "@pwrsnap/shared";
import type {
  VideoExportProgressEvent,
  VideoExportRequest
} from "@pwrsnap/shared";
import { broadcastRendererEventToLocalWindows } from "../events";
import { relayRendererEventToPeer } from "../process-split/event-relay";
import type {
  VideoExportProgressObserver,
  VideoExportProgressUpdate
} from "./recording-exporter";

/**
 * Create the exporter listener for one renderer-owned attempt. The event is
 * broadcast locally and across the split-process bridge because `video:*`
 * executes in the agent while Library export UI may live in the peer.
 */
export function createVideoExportProgressObserver(
  request: VideoExportRequest
): VideoExportProgressObserver | undefined {
  if (request.runId === undefined) return undefined;
  const identity = {
    runId: request.runId,
    captureId: request.captureId,
    format: request.format,
    preset: request.preset
  } as const;

  return {
    runId: request.runId,
    emit: (update: VideoExportProgressUpdate) => {
      const event = { ...identity, ...update } as VideoExportProgressEvent;
      try {
        broadcastRendererEventToLocalWindows(EVENT_CHANNELS.renderProgress, event);
      } finally {
        // A renderer can disappear between isDestroyed() and send(). Keep
        // the peer delivery independent so split-mode Library state clears.
        relayRendererEventToPeer(EVENT_CHANNELS.renderProgress, event);
      }
    }
  };
}
