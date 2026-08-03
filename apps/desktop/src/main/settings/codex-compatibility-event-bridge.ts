import { EVENT_CHANNELS, type CodexCliCompatibilityAlert } from "@pwrsnap/shared";
import { broadcastRendererEventToLocalWindows } from "../events";
import {
  onRelayedRendererEvent,
  relayRendererEventToPeer
} from "../process-split/event-relay";
import {
  onCodexCliCompatibilityAlertChanged,
  rememberRelayedCodexCompatibilityAlert
} from "./codex-compatibility-alert";

let uninstallBridge: (() => void) | null = null;

function isCompatibilityAlert(
  payload: unknown
): payload is CodexCliCompatibilityAlert | null {
  if (payload === null) return true;
  if (typeof payload !== "object" || payload === null) return false;
  const value = payload as Partial<CodexCliCompatibilityAlert>;
  return (
    value.kind === "too-old" &&
    typeof value.key === "string" &&
    typeof value.command === "string" &&
    typeof value.detectedVersion === "string" &&
    typeof value.requiredVersion === "string" &&
    typeof value.detectedAt === "string"
  );
}

/**
 * Connect the Electron-free compatibility guard state to renderer events and
 * the split-process relay. Installed in every process after its relay
 * forwarder is ready, so enrichment, Library Chat, and Sizzle Chat all reach
 * the Library window through the same signal.
 */
export function installCodexCompatibilityEventBridge(): void {
  if (uninstallBridge !== null) return;
  const unsubscribeLocal = onCodexCliCompatibilityAlertChanged((alert) => {
    broadcastRendererEventToLocalWindows(
      EVENT_CHANNELS.codexCompatibilityAlertChanged,
      alert
    );
    relayRendererEventToPeer(EVENT_CHANNELS.codexCompatibilityAlertChanged, alert);
  });
  const unsubscribeRemote = onRelayedRendererEvent(
    EVENT_CHANNELS.codexCompatibilityAlertChanged,
    (payload) => {
      if (!isCompatibilityAlert(payload)) return;
      rememberRelayedCodexCompatibilityAlert(payload);
    }
  );
  uninstallBridge = () => {
    unsubscribeLocal();
    unsubscribeRemote();
    uninstallBridge = null;
  };
}

export function uninstallCodexCompatibilityEventBridgeForTests(): void {
  uninstallBridge?.();
}
