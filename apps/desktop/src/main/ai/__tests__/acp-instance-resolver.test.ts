import { describe, expect, test } from "vitest";
import type { AcpAgentInstance } from "@pwrsnap/shared";
import { resolveActiveAcpInstance } from "../acp-instance-resolver";

const nvm: AcpAgentInstance = { command: "/nvm/qwen", version: "0.16.1", source: "path" };
const brew: AcpAgentInstance = { command: "/opt/homebrew/bin/qwen", version: "0.15.0", source: "path" };
const override: AcpAgentInstance = { command: "/custom/qwen", version: "9.9.9", source: "override" };

describe("resolveActiveAcpInstance", () => {
  test("defaults to the first instance (auto)", () => {
    expect(resolveActiveAcpInstance([nvm, brew], undefined)).toBe(nvm);
    expect(resolveActiveAcpInstance([nvm, brew], {})).toBe(nvm);
  });

  test("honors a user-picked selectedPath when still present", () => {
    expect(
      resolveActiveAcpInstance([nvm, brew], { selectedPath: "/opt/homebrew/bin/qwen" })
    ).toBe(brew);
  });

  test("falls back to first when the picked path is no longer installed", () => {
    expect(
      resolveActiveAcpInstance([nvm, brew], { selectedPath: "/gone/qwen" })
    ).toBe(nvm);
  });

  test("an override instance wins over everything (including a stale pick)", () => {
    expect(
      resolveActiveAcpInstance([override, nvm, brew], {
        selectedPath: "/opt/homebrew/bin/qwen"
      })
    ).toBe(override);
  });
});
