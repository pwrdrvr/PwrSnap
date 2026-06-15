// Cross-process renderer-event relay (plan 2026-06-12-001 §D4).
//
// Emit sites (events.ts capture broadcasts, settings-handlers settings
// broadcasts, the clipboard-changed fan-out) call
// `relayRendererEventToPeer` right after their local-window loop. The
// receiving side broadcasts to ITS windows only and never re-forwards
// (the bridge endpoint's onRemoteEvent has no relay hook), so echo
// loops are impossible by construction.
//
// No-op until split-mode boot installs a forwarder — combined mode
// pays nothing. Electron-free so emit-site modules stay unit-testable.

type RendererEventForwarder = (channel: string, payload: unknown) => void;

let forwarder: RendererEventForwarder | null = null;

export function installRendererEventForwarder(next: RendererEventForwarder): void {
  if (forwarder !== null) {
    throw new Error("event-relay: renderer event forwarder already installed");
  }
  forwarder = next;
}

export function uninstallRendererEventForwarderForTests(): void {
  forwarder = null;
}

/** Forward one just-broadcast renderer event to the peer process.
 *  Fire-and-forget: a missing/closed peer drops the event (renderers
 *  re-read fresh state on mount, so missed events self-heal). */
export function relayRendererEventToPeer(channel: string, payload: unknown): void {
  forwarder?.(channel, payload);
}

// ── Cancellation relay ────────────────────────────────────────────
// `bus.cancel(key)` is process-local; this hook lets a delete in one
// process abort in-flight work (enrichment, exports) in the other.

type CancellationForwarder = (key: string) => void;

let cancellationForwarder: CancellationForwarder | null = null;

export function installCancellationForwarder(next: CancellationForwarder): void {
  if (cancellationForwarder !== null) {
    throw new Error("event-relay: cancellation forwarder already installed");
  }
  cancellationForwarder = next;
}

export function uninstallCancellationForwarderForTests(): void {
  cancellationForwarder = null;
}

/** Mirror a local `bus.cancel(key)` to the peer process. */
export function relayCancellationToPeer(key: string): void {
  cancellationForwarder?.(key);
}

// ── Main-side listeners for peer-originated events ────────────────
// The bridge delivers relayed renderer events to local WINDOWS; some
// main-process consumers need them too (the library's application
// menu reacts to developer-mode flips that the agent-side settings
// service broadcast). Both bridge receive sites call the deliver
// function after their window broadcast.

type RelayedEventListener = (payload: unknown) => void;

const relayedEventListeners = new Map<string, Set<RelayedEventListener>>();

export function onRelayedRendererEvent(
  channel: string,
  listener: RelayedEventListener
): () => void {
  const listeners = relayedEventListeners.get(channel) ?? new Set();
  listeners.add(listener);
  relayedEventListeners.set(channel, listeners);
  return () => {
    listeners.delete(listener);
  };
}

export function deliverRelayedRendererEventToMain(channel: string, payload: unknown): void {
  const listeners = relayedEventListeners.get(channel);
  if (listeners === undefined) return;
  for (const listener of [...listeners]) listener(payload);
}
