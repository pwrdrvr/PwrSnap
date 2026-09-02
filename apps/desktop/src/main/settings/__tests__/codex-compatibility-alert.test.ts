import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { defaultSettings } from "../desktop-settings-service";
import { DesktopSettingsStore } from "../desktop-settings-store";
import { MINIMUM_CODEX_CLI_VERSION } from "../codex-discovery";
import {
  CodexCliTooOldError,
  getCodexCliCompatibilityAlert,
  onCodexCliCompatibilityAlertChanged,
  resetCodexCompatibilityAlertForTests
} from "../codex-compatibility-alert";

describe("Codex CLI compatibility alert", () => {
  beforeEach(() => {
    resetCodexCompatibilityAlertForTests();
  });

  afterEach(() => {
    resetCodexCompatibilityAlertForTests();
  });

  test("the store-owned guard emits once, clears after explicit refresh, and re-arms", async () => {
    const changes: Array<ReturnType<typeof getCodexCliCompatibilityAlert>> = [];
    const unsubscribe = onCodexCliCompatibilityAlertChanged((alert) => {
      changes.push(alert);
    });
    let version = "0.143.0";
    const discoverCodex = vi.fn(async () => ({
      candidates: [
        {
          command: "codex",
          source: "path" as const,
          executable: version === MINIMUM_CODEX_CLI_VERSION,
          selected: version === MINIMUM_CODEX_CLI_VERSION,
          version,
          ...(version === MINIMUM_CODEX_CLI_VERSION
            ? {}
            : { failureReason: "codex_too_old" })
        }
      ]
    }));
    const store = new DesktopSettingsStore({
      filePath: join(mkdtempSync(join(tmpdir(), "pwrsnap-codex-alert-")), "settings.json"),
      readTextFile: async () => JSON.stringify(defaultSettings()),
      discoverCodex,
      probeCodexAuthentication: async () => ({
        status: "authenticated",
        testedAt: "2026-09-02T00:00:00.000Z",
        durationMs: 1
      })
    });

    await expect(
      store.resolveCompatibleCodexCommand({ command: "codex" })
    ).rejects.toBeInstanceOf(CodexCliTooOldError);

    const first = getCodexCliCompatibilityAlert();
    expect(first).toMatchObject({
      kind: "too-old",
      command: "codex",
      detectedVersion: "0.143.0",
      requiredVersion: MINIMUM_CODEX_CLI_VERSION
    });
    expect(changes).toEqual([first]);

    // Repeated runtime consumers share the failed publication and alert.
    await expect(
      store.resolveCompatibleCodexCommand({ command: "codex" })
    ).rejects.toBeInstanceOf(CodexCliTooOldError);
    expect(discoverCodex).toHaveBeenCalledTimes(1);
    expect(changes).toEqual([first]);

    version = MINIMUM_CODEX_CLI_VERSION;
    await store.refreshCodexDiscoveryForUserRequest();
    await expect(
      store.resolveCompatibleCodexCommand({ command: "codex" })
    ).resolves.toMatchObject({ version: MINIMUM_CODEX_CLI_VERSION });
    expect(changes).toEqual([first, null]);

    version = "0.143.0";
    await store.refreshCodexDiscoveryForUserRequest();
    await expect(
      store.resolveCompatibleCodexCommand({ command: "codex" })
    ).rejects.toBeInstanceOf(CodexCliTooOldError);
    expect(changes).toHaveLength(3);
    expect(changes[2]?.key).toBe(first?.key);

    unsubscribe();
  });
});
