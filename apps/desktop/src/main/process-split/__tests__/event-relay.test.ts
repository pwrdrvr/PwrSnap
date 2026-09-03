import { afterEach, describe, expect, test, vi } from "vitest";

import {
  deliverRelayedProcessEvent,
  installRendererEventForwarder,
  onRelayedRendererEvent,
  relaySettingsDiscoveryPublicationToPeer,
  SETTINGS_DISCOVERY_PUBLICATION_CHANNEL,
  uninstallRendererEventForwarderForTests
} from "../event-relay";

afterEach(() => {
  uninstallRendererEventForwarderForTests();
});

describe("split-process discovery publication relay", () => {
  test("forwards discovery publications on the private bridge channel", () => {
    const forward = vi.fn();
    const publication = { kind: "codex" };
    installRendererEventForwarder(forward);

    relaySettingsDiscoveryPublicationToPeer(publication);

    expect(forward).toHaveBeenCalledWith(
      SETTINGS_DISCOVERY_PUBLICATION_CHANNEL,
      publication
    );
  });

  test("delivers discovery publications to main without exposing them to renderers", () => {
    const broadcast = vi.fn();
    const listener = vi.fn();
    const publication = { kind: "acp" };
    const unsubscribe = onRelayedRendererEvent(
      SETTINGS_DISCOVERY_PUBLICATION_CHANNEL,
      listener
    );

    deliverRelayedProcessEvent(
      SETTINGS_DISCOVERY_PUBLICATION_CHANNEL,
      publication,
      broadcast
    );

    expect(broadcast).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledWith(publication);
    unsubscribe();
  });

  test("preserves renderer fan-out for ordinary peer events", () => {
    const broadcast = vi.fn();
    const listener = vi.fn();
    const payload = { changedIds: ["capture-1"] };
    const unsubscribe = onRelayedRendererEvent("events:captures:changed", listener);

    deliverRelayedProcessEvent("events:captures:changed", payload, broadcast);

    expect(broadcast).toHaveBeenCalledWith("events:captures:changed", payload);
    expect(listener).toHaveBeenCalledWith(payload);
    unsubscribe();
  });
});
