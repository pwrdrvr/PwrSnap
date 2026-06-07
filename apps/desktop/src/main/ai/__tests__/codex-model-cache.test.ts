import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexModelOption } from "@pwrsnap/shared";

const h = vi.hoisted(() => ({ dir: "" }));
vi.mock("electron", () => ({ app: { getPath: () => h.dir } }));

const { findCodexModelLabel, saveCodexModelLabels } = await import("../codex-model-cache");

function model(id: string, displayName: string): CodexModelOption {
  return {
    id,
    model: id,
    displayName,
    description: "",
    hidden: false,
    inputModalities: ["text", "image"],
    defaultServiceTier: null,
    isDefault: false
  };
}

describe("codex model label cache", () => {
  beforeEach(() => {
    h.dir = mkdtempSync(join(tmpdir(), "pwrsnap-codex-cache-"));
  });
  afterEach(() => rmSync(h.dir, { recursive: true, force: true }));

  it("resolves a model id to its friendly display name after a save", () => {
    expect(findCodexModelLabel("gpt-5.4-mini")).toBeUndefined();
    saveCodexModelLabels([model("gpt-5.4-mini", "GPT-5.4-Mini"), model("gpt-5.5", "GPT-5.5")]);
    expect(findCodexModelLabel("gpt-5.4-mini")).toBe("GPT-5.4-Mini");
    expect(findCodexModelLabel("gpt-5.5")).toBe("GPT-5.5");
  });

  it("does not store entries whose display name equals the id (nothing to gain)", () => {
    saveCodexModelLabels([model("o4-mini", "o4-mini"), model("gpt-5.5", "GPT-5.5")]);
    expect(findCodexModelLabel("o4-mini")).toBeUndefined(); // == id → not cached
    expect(findCodexModelLabel("gpt-5.5")).toBe("GPT-5.5");
  });

  it("matches the id exactly (no prefix) and returns undefined for unknown / empty", () => {
    saveCodexModelLabels([model("gpt-5.4-mini", "GPT-5.4-Mini")]);
    expect(findCodexModelLabel("gpt-5.4")).toBeUndefined(); // not a prefix match
    expect(findCodexModelLabel("grok-build")).toBeUndefined();
    expect(findCodexModelLabel("")).toBeUndefined();
  });
});
