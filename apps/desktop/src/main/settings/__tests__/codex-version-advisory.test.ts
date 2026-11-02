import { describe, expect, test, vi } from "vitest";
import {
  buildCodexVersionAdvisory,
  classifyCodexInstaller,
  isCodexVersionBelowMinimum,
  onCodexVersionAdvisoryChanged,
  publishCodexVersionAdvisory
} from "../codex-version-advisory";

describe("Codex model version advisory", () => {
  test.each([
    ["0.144.0", true], ["0.158.0", true], ["codex-cli 0.159.0", true],
    ["0.159.1", true], ["0.159.2", false], ["0.159.2-alpha.1", false],
    ["0.160.0", false], ["1.0.0", false], [undefined, false], ["unknown", false]
  ])("compares %s to the 0.159.2 model baseline", (version, expected) => {
    expect(isCodexVersionBelowMinimum(version)).toBe(expected);
  });

  test.each([
    ["/opt/homebrew/Caskroom/codex/0.158.0/codex", "homebrew", "brew upgrade --cask codex"],
    ["/usr/local/Cellar/codex/0.158.0/bin/codex", "homebrew", "brew upgrade codex"],
    ["/home/example/.bun/install/global/node_modules/@openai/codex/bin/codex.js", "bun", "bun add -g @openai/codex@latest"],
    ["/home/example/.local/share/pnpm/global/5/node_modules/@openai/codex/bin/codex.js", "pnpm", "pnpm add -g @openai/codex@latest"],
    ["/home/example/.local/share/pnpm/global/5/node_modules/.pnpm/@openai+codex@0.158.0/node_modules/@openai/codex/bin/codex.js", "pnpm", "pnpm add -g @openai/codex@latest"],
    ["/home/example/.local/share/pnpm/codex", "pnpm", "pnpm add -g @openai/codex@latest"],
    ["/home/example/.nvm/versions/node/v24.14.1/lib/node_modules/@openai/codex/bin/codex.js", "npm", "npm install -g @openai/codex@latest"],
    ["C:\\Users\\example\\AppData\\Roaming\\npm\\codex.cmd", "npm", "npm install -g @openai/codex@latest"],
    ["C:\\Users\\example\\AppData\\Local\\pnpm\\codex.ps1", "pnpm", "pnpm add -g @openai/codex@latest"],
    ["C:\\Users\\example\\.bun\\bin\\codex.exe", "bun", "bun add -g @openai/codex@latest"],
    ["/Applications/Codex.app/Contents/Resources/codex", "application", undefined],
    ["/opt/custom/bin/codex", "unknown", undefined]
  ])("recognizes %s without guessing another installer", (command, installer, upgradeCommand) => {
    expect(classifyCodexInstaller({ command })).toEqual({ installer, ...(upgradeCommand ? { upgradeCommand } : {}) });
  });

  test.each([
    "/usr/local/bin/codex",
    "/opt/homebrew/bin/codex",
    "/home/example/.nvm/versions/node/v24.14.1/bin/codex"
  ])("does not treat discovery's application label as installer provenance for %s", async (command) => {
    const advisory = await buildCodexVersionAdvisory({
      command,
      version: "0.158.0",
      source: "application",
      resolvePath: async () => command
    });
    expect(advisory).toMatchObject({ command, installer: "unknown" });
    expect(advisory?.upgradeCommand).toBeUndefined();
  });

  test("recognizes a real app bundle behind a symlink regardless of discovery source", async () => {
    const advisory = await buildCodexVersionAdvisory({
      command: "/usr/local/bin/codex",
      version: "0.158.0",
      source: "env",
      resolvePath: async () => "/Applications/Codex.app/Contents/Resources/codex"
    });
    expect(advisory?.installer).toBe("application");
  });

  test("resolves symlinks only for old binaries, and deduplicates publications", async () => {
    const resolvePath = vi.fn(async () => "/opt/homebrew/Caskroom/codex/0.158.0/codex");
    expect(await buildCodexVersionAdvisory({ command: "codex", version: "0.159.2", resolvePath })).toBeUndefined();
    expect(resolvePath).not.toHaveBeenCalled();
    const advisory = await buildCodexVersionAdvisory({ command: "/opt/homebrew/bin/codex", version: "codex-cli 0.158.0", resolvePath });
    expect(advisory).toMatchObject({ version: "0.158.0", minimumVersion: "0.159.2", installer: "homebrew" });
    const listener = vi.fn();
    const off = onCodexVersionAdvisoryChanged(listener);
    try {
      publishCodexVersionAdvisory(advisory!);
      publishCodexVersionAdvisory({ ...advisory! });
      expect(listener).toHaveBeenCalledTimes(1);
      publishCodexVersionAdvisory(null);
      expect(listener).toHaveBeenLastCalledWith(null);
    } finally { off(); }
  });
});
