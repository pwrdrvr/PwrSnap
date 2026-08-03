import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const promisifiedExecFile = vi.fn();
  const execFile = vi.fn();
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), {
    value: promisifiedExecFile
  });
  return { execFile, promisifiedExecFile };
});

vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));

const { assertCodexCliVersion, MINIMUM_CODEX_CLI_VERSION } = await import(
  "../codex-discovery"
);
const {
  CodexCliTooOldError,
  getCodexCliCompatibilityAlert,
  onCodexCliCompatibilityAlertChanged,
  resetCodexCompatibilityAlertForTests
} = await import("../codex-compatibility-alert");

describe("Codex CLI compatibility alert", () => {
  beforeEach(() => {
    resetCodexCompatibilityAlertForTests();
    mocks.promisifiedExecFile.mockReset();
  });

  afterEach(() => {
    resetCodexCompatibilityAlertForTests();
  });

  test("the real too-old guard emits once, clears on compatibility, and re-arms", async () => {
    const changes: Array<ReturnType<typeof getCodexCliCompatibilityAlert>> = [];
    const unsubscribe = onCodexCliCompatibilityAlertChanged((alert) => {
      changes.push(alert);
    });
    mocks.promisifiedExecFile.mockResolvedValue({
      stdout: "codex-cli 0.143.0\n",
      stderr: ""
    });

    await expect(assertCodexCliVersion("codex", {})).rejects.toBeInstanceOf(
      CodexCliTooOldError
    );

    const first = getCodexCliCompatibilityAlert();
    expect(first).toMatchObject({
      kind: "too-old",
      command: "codex",
      detectedVersion: "0.143.0",
      requiredVersion: MINIMUM_CODEX_CLI_VERSION
    });
    expect(changes).toEqual([first]);

    // A repeated failure with the same compatibility tuple stays deduplicated.
    await expect(assertCodexCliVersion("codex", {})).rejects.toBeInstanceOf(
      CodexCliTooOldError
    );
    expect(changes).toEqual([first]);

    mocks.promisifiedExecFile.mockResolvedValue({
      stdout: `codex-cli ${MINIMUM_CODEX_CLI_VERSION}\n`,
      stderr: ""
    });
    await expect(assertCodexCliVersion("codex", {})).resolves.toBe(
      MINIMUM_CODEX_CLI_VERSION
    );
    expect(changes).toEqual([first, null]);

    // Once compatibility succeeds, the same old tuple is a new regression.
    mocks.promisifiedExecFile.mockResolvedValue({
      stdout: "codex-cli 0.143.0\n",
      stderr: ""
    });
    await expect(assertCodexCliVersion("codex", {})).rejects.toBeInstanceOf(
      CodexCliTooOldError
    );
    expect(changes).toHaveLength(3);
    expect(changes[2]?.key).toBe(first?.key);

    unsubscribe();
  });
});
