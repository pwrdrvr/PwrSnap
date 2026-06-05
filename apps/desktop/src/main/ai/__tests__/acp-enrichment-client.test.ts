import { describe, expect, it, vi } from "vitest";

// agent-kit-bindings pulls in electron for openExternal — stub it so the
// module graph loads under the node test env.
vi.mock("electron", (): Partial<typeof import("electron")> => ({
  shell: { openExternal: vi.fn() } as unknown as typeof import("electron").shell
}));

import { buildAcpEnrichmentPrompt, extractJsonObject } from "../acp-enrichment-client";
import type { CaptureEnrichmentRequest } from "../capture-enrichment-client";

describe("extractJsonObject", () => {
  it("returns a plain JSON object unchanged", () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });
  it("unwraps a ```json fence", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it("extracts JSON wrapped in reasoning prose (the Gemini flash-preview case)", () => {
    const raw = '**Analyzing the image**\n\nHere is the result:\n{"title":"x","tags":[]}\n\nDone.';
    expect(JSON.parse(extractJsonObject(raw))).toEqual({ title: "x", tags: [] });
  });
  it("handles braces inside string values + nested objects", () => {
    const raw = 'noise {"a":{"b":"a } b"},"c":2} trailing';
    expect(JSON.parse(extractJsonObject(raw))).toEqual({ a: { b: "a } b" }, c: 2 });
  });
});

const request: CaptureEnrichmentRequest = {
  imagePaths: ["/tmp/a.jpg"],
  metadata: {
    sourceAppName: "Figma",
    sourceAppBundleId: "com.figma.Desktop",
    captureKind: "image",
    widthPx: 800,
    heightPx: 600,
    capturedAt: "2026-06-04T00:00:00Z",
    existingUserTags: ["design"],
    videoDurationSec: null
  },
  effort: "low"
};

describe("buildAcpEnrichmentPrompt", () => {
  it("folds the base instructions + metadata + JSON-Schema contract into one prompt", () => {
    const prompt = buildAcpEnrichmentPrompt(request);
    // The per-capture metadata is present (no outputSchema/baseInstructions
    // seam in ACP, so it must ride in the prompt).
    expect(prompt).toContain("Figma");
    expect(prompt).toContain("com.figma.Desktop");
    expect(prompt).toContain("design");
    // The JSON-only contract + the schema's required keys are embedded.
    expect(prompt).toMatch(/ONLY a single JSON object/i);
    expect(prompt).toContain("filenameStem");
    expect(prompt).toContain("textAnchors");
    // No tools / no questions instruction (enrichment is non-interactive).
    expect(prompt).toMatch(/Do not call any tools/i);
  });
});
