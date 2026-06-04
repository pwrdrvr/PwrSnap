import { describe, expect, it, vi } from "vitest";

// agent-kit-bindings pulls in electron for openExternal — stub it so the
// module graph loads under the node test env.
vi.mock("electron", (): Partial<typeof import("electron")> => ({
  shell: { openExternal: vi.fn() } as unknown as typeof import("electron").shell
}));

import { buildAcpEnrichmentPrompt } from "../acp-enrichment-client";
import type { CaptureEnrichmentRequest } from "../capture-enrichment-client";

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
