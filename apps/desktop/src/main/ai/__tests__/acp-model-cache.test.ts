import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const h = vi.hoisted(() => ({ dir: "" }));
vi.mock("electron", () => ({ app: { getPath: () => h.dir } }));

const { findAcpModelLabel, saveAcpModelCacheEntry, loadAcpModelCacheEntry } = await import(
  "../acp-model-cache"
);

describe("findAcpModelLabel", () => {
  beforeEach(() => {
    h.dir = mkdtempSync(join(tmpdir(), "pwrsnap-acp-cache-"));
    writeFileSync(
      join(h.dir, "acp-model-cache.json"),
      JSON.stringify({
        version: 1,
        agents: {
          grok: {
            models: [
              { id: "grok-composer-2.5-fast", label: "Composer 2.5" },
              { id: "grok-build", label: "Grok Build" }
            ],
            command: "/grok",
            discoveredAt: "2026-06-05T00:00:00Z"
          },
          gemini: {
            models: [{ id: "gemini-3-flash-preview", label: "Gemini 3 Flash" }],
            command: "/gemini",
            discoveredAt: "2026-06-05T00:00:00Z"
          }
        }
      })
    );
  });
  afterEach(() => rmSync(h.dir, { recursive: true, force: true }));

  it("resolves a model id to its friendly label across all cached agents", () => {
    expect(findAcpModelLabel("grok-build")).toBe("Grok Build");
    expect(findAcpModelLabel("grok-composer-2.5-fast")).toBe("Composer 2.5");
    expect(findAcpModelLabel("gemini-3-flash-preview")).toBe("Gemini 3 Flash");
  });

  it("returns undefined for an unknown id (e.g. a Codex model) or empty input", () => {
    expect(findAcpModelLabel("gpt-5.4-mini")).toBeUndefined();
    expect(findAcpModelLabel("")).toBeUndefined();
  });

  it("matches the id EXACTLY — never a prefix/substring", () => {
    // Regression guard: looking up "grok-build" must NOT match "grok-build-3".
    saveAcpModelCacheEntry("grok", {
      models: [
        { id: "grok-build-3", label: "Grok Build 3" },
        { id: "grok-build-2", label: "Grok Build 2" },
        { id: "grok-build", label: "Grok Build" }
      ],
      command: "/grok",
      discoveredAt: "2026-06-07T00:00:00Z"
    });
    expect(findAcpModelLabel("grok-build")).toBe("Grok Build"); // exact, not the -3 entry
    expect(findAcpModelLabel("grok-build-2")).toBe("Grok Build 2");
    expect(findAcpModelLabel("grok-buil")).toBeUndefined(); // not a prefix match
  });
});

describe("acp model cache memo", () => {
  beforeEach(() => {
    h.dir = mkdtempSync(join(tmpdir(), "pwrsnap-acp-cache-"));
  });
  afterEach(() => rmSync(h.dir, { recursive: true, force: true }));

  it("a save is immediately visible to reads (memo refreshed on write)", () => {
    expect(loadAcpModelCacheEntry("kimi")).toBeUndefined();
    saveAcpModelCacheEntry("kimi", {
      models: [{ id: "kimi-k2", label: "Kimi K2" }],
      command: "/kimi",
      discoveredAt: "2026-06-07T00:00:00Z"
    });
    expect(loadAcpModelCacheEntry("kimi")?.models[0]?.label).toBe("Kimi K2");
    expect(findAcpModelLabel("kimi-k2")).toBe("Kimi K2");
  });
});
