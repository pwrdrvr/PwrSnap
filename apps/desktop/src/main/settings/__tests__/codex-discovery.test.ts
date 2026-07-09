import { beforeEach, describe, expect, test, vi } from "vitest";

type DiscoverCommandsOptions = {
  autoCandidates: Array<{ command: string; source: string }>;
};

const mocks = vi.hoisted(() => ({
  discoverCommands: vi.fn(async (options: DiscoverCommandsOptions) => ({
    candidates: options.autoCandidates.map((candidate) => ({
      ...candidate,
      executable: false,
      selected: false
    }))
  }))
}));

vi.mock("@pwrdrvr/codex-discovery", () => ({
  compareCodexCliVersions: vi.fn(),
  discoverCommands: mocks.discoverCommands,
  pathIsExecutable: vi.fn()
}));

const { discoverCodexCommands } = await import("../codex-discovery");

describe("discoverCodexCommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("passes ChatGPT app and Homebrew macOS candidates to discovery", async () => {
    await discoverCodexCommands({ env: {} });

    const options = mocks.discoverCommands.mock.calls[0]?.[0] as
      | DiscoverCommandsOptions
      | undefined;
    const commands = options?.autoCandidates.map((candidate) => candidate.command) ?? [];

    expect(commands).toContain("/Applications/ChatGPT.app/Contents/Resources/codex");
    expect(commands).toContain("/Applications/Codex.app/Contents/Resources/codex");
    expect(commands).toContain("/opt/homebrew/bin/codex");
    expect(commands).toContain("/usr/local/bin/codex");
    expect(commands).toContain("codex");
  });
});
