import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EVENT_CHANNELS, type CodexCliCompatibilityAlert } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  relay: vi.fn(),
  remoteListener: null as ((payload: unknown) => void) | null
}));

vi.mock("../../events", () => ({
  broadcastRendererEventToLocalWindows: mocks.broadcast
}));

vi.mock("../../process-split/event-relay", () => ({
  relayRendererEventToPeer: mocks.relay,
  onRelayedRendererEvent: vi.fn(
    (_channel: string, listener: (payload: unknown) => void) => {
      mocks.remoteListener = listener;
      return () => {
        mocks.remoteListener = null;
      };
    }
  )
}));

const {
  getCodexCliCompatibilityAlert,
  reportCodexCliTooOld,
  resetCodexCompatibilityAlertForTests
} = await import("../codex-compatibility-alert");
const {
  installCodexCompatibilityEventBridge,
  uninstallCodexCompatibilityEventBridgeForTests
} = await import("../codex-compatibility-event-bridge");

describe("Codex compatibility event bridge", () => {
  beforeEach(() => {
    mocks.broadcast.mockReset();
    mocks.relay.mockReset();
    resetCodexCompatibilityAlertForTests();
    installCodexCompatibilityEventBridge();
  });

  afterEach(() => {
    uninstallCodexCompatibilityEventBridgeForTests();
    resetCodexCompatibilityAlertForTests();
  });

  test("broadcasts local guard state and remembers peer state without echoing", () => {
    const local = reportCodexCliTooOld("codex", "0.143.0", "0.144.0");

    expect(mocks.broadcast).toHaveBeenCalledWith(
      EVENT_CHANNELS.codexCompatibilityAlertChanged,
      local
    );
    expect(mocks.relay).toHaveBeenCalledWith(
      EVENT_CHANNELS.codexCompatibilityAlertChanged,
      local
    );

    const remote: CodexCliCompatibilityAlert = {
      kind: "too-old",
      key: "remote-key",
      command: "/Applications/Codex.app/Contents/Resources/codex",
      detectedVersion: "0.142.0",
      requiredVersion: "0.144.0",
      detectedAt: "2026-08-03T12:00:00.000Z"
    };
    mocks.remoteListener?.(remote);

    expect(getCodexCliCompatibilityAlert()).toEqual(remote);
    expect(mocks.broadcast).toHaveBeenCalledTimes(1);
    expect(mocks.relay).toHaveBeenCalledTimes(1);
  });
});
