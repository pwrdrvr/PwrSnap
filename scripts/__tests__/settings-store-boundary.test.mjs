import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";

import { checkSettingsStoreBoundary } from "../check-settings-store-boundary.mjs";

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "pwrsnap-settings-boundary-"));
  const sources = {
    "settings/desktop-settings-store.ts": "export class DesktopSettingsStore {}\n",
    ...files
  };
  for (const [name, source] of Object.entries(sources)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source, "utf8");
  }
  return root;
}

describe("settings store source boundary", () => {
  test("accepts cached reads and the named explicit boundaries", () => {
    const root = fixture({
      "settings/desktop-settings-service.ts":
        "export class DesktopSettingsService { adoptTrustedSnapshot() {} }\n",
      "settings/codex-discovery.ts":
        'import { discoverCommands } from "@pwrdrvr/codex-discovery";\n',
      "handlers/settings-handlers.ts":
        "store.refreshCodexDiscoveryForUserRequest(); store.testCodexForUserRequest(); store.getCurrentCodexDiscoveryPublication(); relaySettingsDiscoveryPublicationToPeer();\n",
      "handlers/acp-handlers.ts":
        "store.refreshAcpDiscoveryForUserRequest(); store.getCurrentAcpDiscoveryPublication(); relaySettingsDiscoveryPublicationToPeer();\n",
      "handlers/codex-profile-handlers.ts":
        'import { discoverCodexAuthProfiles } from "@pwrdrvr/codex-discovery";\n',
      "ai/agent-command.ts": "export function execAgentCommandSync() {}\n",
      "process-split/settings-peek.ts":
        'const name = "pwrsnap-settings.json"; function peekExperimentalProcessSplit() {}\n',
      "process-split/event-relay.ts":
        "export function relaySettingsDiscoveryPublicationToPeer() {}\n",
      "index.ts":
        "peekExperimentalProcessSplit(); store.adoptTrustedPeerSnapshot(settings); store.adoptTrustedPeerDiscoveryPublication(publication);\n",
      "feature.ts": "store.read(); store.getCodexDiscoverySnapshot();\n"
    });

    expect(checkSettingsStoreBoundary(root)).toEqual([]);
  });

  test("rejects callable reloads and production bypasses", () => {
    const root = fixture({
      "settings/desktop-settings-store.ts":
        "export class DesktopSettingsStore { async reload() {} }\n",
      "feature.ts": `
        import { DesktopSettingsService } from "./settings/desktop-settings-service";
        import { discoverCommands } from "@pwrdrvr/codex-discovery";
        new DesktopSettingsStore();
        peekExperimentalProcessSplit();
        store.adoptTrustedPeerSnapshot(settings);
        store.adoptTrustedPeerDiscoveryPublication(publication);
        store.getCurrentCodexDiscoveryPublication();
        store.getCurrentAcpDiscoveryPublication();
        relaySettingsDiscoveryPublicationToPeer(publication);
        store.refreshCodexDiscoveryForUserRequest();
        store.refreshAcpDiscoveryForUserRequest();
        store.testCodexForUserRequest();
        discoverCodexAuthProfiles();
        execAgentCommandSync(command, ["--version"]);
        const file = "pwrsnap-settings.json";
      `
    });

    expect(checkSettingsStoreBoundary(root)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("callable reload API is forbidden"),
        expect.stringContaining("raw settings persistence is private"),
        expect.stringContaining("direct Codex kit discovery/probes"),
        expect.stringContaining("do not create a second settings store"),
        expect.stringContaining("synchronous settings peek is restricted"),
        expect.stringContaining("trusted peer snapshots may only enter"),
        expect.stringContaining("trusted peer discovery publications may only enter"),
        expect.stringContaining("Codex publication export is restricted"),
        expect.stringContaining("ACP publication export is restricted"),
        expect.stringContaining("discovery publication relay is restricted"),
        expect.stringContaining("forced Codex discovery is restricted"),
        expect.stringContaining("forced ACP discovery is restricted"),
        expect.stringContaining("live Codex probe is restricted"),
        expect.stringContaining("Codex profile filesystem/status probes are restricted"),
        expect.stringContaining("synchronous agent probes are forbidden"),
        expect.stringContaining("direct binary version probes are forbidden"),
        expect.stringContaining("direct settings-file access is forbidden")
      ])
    );
  });
});
