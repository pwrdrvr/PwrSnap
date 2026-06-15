// Main → renderer broadcast helpers. Pulled out of individual
// handlers so multiple call sites (capture-handlers, library-handlers,
// the dev seeder runner) share one implementation. The dev seeder
// also installs a debounced sink around `broadcastCapturesChanged` for
// the duration of a profile run so 100k bulk inserts don't thrash
// every live BrowserWindow.

import { BrowserWindow } from "electron";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { relayRendererEventToPeer } from "./process-split/event-relay";

export type BroadcastCapturesChanged = (changedIds: string[]) => void;

/**
 * Send an event to every live BrowserWindow in THIS process. Also the
 * delivery half of the cross-process relay: the bridge's onRemoteEvent
 * calls this (and only this — never the relaying variant below), so
 * peer-originated events reach local windows without echoing back.
 */
export function broadcastRendererEventToLocalWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(channel, payload);
  }
}

/**
 * Default broadcast implementation: send `events:captures:changed` to
 * every live BrowserWindow, then once to the peer process (split mode;
 * no-op in combined).
 */
export const broadcastCapturesChangedDefault: BroadcastCapturesChanged = (changedIds) => {
  broadcastRendererEventToLocalWindows(EVENT_CHANNELS.capturesChanged, { changedIds });
  relayRendererEventToPeer(EVENT_CHANNELS.capturesChanged, { changedIds });
};

/**
 * Active broadcaster. The dev seeder swaps this out via
 * `installSeederBroadcastSink()` for the duration of a profile run,
 * then restores the default.
 */
let activeBroadcaster: BroadcastCapturesChanged = broadcastCapturesChangedDefault;

export function broadcastCapturesChanged(changedIds: string[]): void {
  activeBroadcaster(changedIds);
}

/**
 * Replace the active broadcaster. Returns a `restore` function that
 * reinstates the previous broadcaster. Used by the dev seeder to
 * silence per-row broadcasts during bulk inserts; the seeder calls
 * the returned `flushOnce` to emit a single broadcast at JSONL bucket
 * boundaries.
 */
export function installBroadcaster(next: BroadcastCapturesChanged): {
  restore: () => void;
  flushOnce: BroadcastCapturesChanged;
} {
  const prev = activeBroadcaster;
  activeBroadcaster = next;
  return {
    restore: () => {
      activeBroadcaster = prev;
    },
    flushOnce: prev
  };
}
