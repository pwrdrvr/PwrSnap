import { describe, expect, it, vi } from "vitest";

// agent-kit-bindings pulls in electron for openExternal — stub it so the
// module graph loads under the node test env.
vi.mock("electron", (): Partial<typeof import("electron")> => ({
  shell: { openExternal: vi.fn() } as unknown as typeof import("electron").shell
}));

import {
  buildAcpEnrichmentPrompt,
  buildAcpEnrichmentRepairPrompt,
  extractJsonObject,
  extractJsonObjects,
  parseEnrichmentReply,
  repairJsonish
} from "../acp-enrichment-client";
import { CAPTURE_ENRICHMENT_EXAMPLE } from "../enrichment-schema";
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
  it("folds the base instructions + metadata + output contract into one prompt", () => {
    const prompt = buildAcpEnrichmentPrompt(request);
    // The per-capture metadata is present (no outputSchema/baseInstructions
    // seam in ACP, so it must ride in the prompt).
    expect(prompt).toContain("Figma");
    expect(prompt).toContain("com.figma.Desktop");
    expect(prompt).toContain("design");
    // The JSON-only contract + the required keys are embedded.
    expect(prompt).toMatch(/ONLY a single JSON object/i);
    expect(prompt).toContain("filenameStem");
    expect(prompt).toContain("textAnchors");
    expect(prompt).toMatch(/Do not call any tools/i);
  });

  it("forbids placeholder ellipses, comments, and trailing commas (Grok `[...]` regression)", () => {
    const prompt = buildAcpEnrichmentPrompt(request);
    expect(prompt).toMatch(/\[\.\.\.\]/); // the forbidden example is named
    expect(prompt).toMatch(/no comments, no trailing commas/i);
    expect(prompt).toMatch(/placeholder/i);
  });

  it("hands a CONCRETE example, not a raw JSON Schema (Grok schema-echo regression)", () => {
    // Grok echoed the schema's type names (`"ocrText": string`) when told to
    // conform to a JSON Schema. The prompt must instead carry a parseable
    // example instance + a 'real values, not types' instruction.
    const prompt = buildAcpEnrichmentPrompt(request);
    // No bareword type annotations that would break JSON.parse, no schema dump.
    expect(prompt).not.toMatch(/"ocrText":\s*string/);
    expect(prompt).not.toContain('"type": "object"');
    expect(prompt).toMatch(/real values/i);
    expect(prompt).toMatch(/never output the words "string"/i);
    // The embedded example is a real, parseable instance with the required keys.
    const exampleJson = JSON.stringify(CAPTURE_ENRICHMENT_EXAMPLE);
    const example = JSON.parse(exampleJson) as Record<string, unknown>;
    for (const key of ["ocrText", "title", "description", "filenameStem", "textAnchors", "tags"]) {
      expect(example).toHaveProperty(key);
    }
    expect(typeof example.title).toBe("string");
    expect(Array.isArray(example.tags)).toBe(true);
    // And it's actually in the prompt.
    expect(prompt).toContain(String(example.title));
  });
});

describe("repairJsonish", () => {
  it("strips trailing commas before } and ]", () => {
    expect(JSON.parse(repairJsonish('{"a":1,"b":[1,2,],}'))).toEqual({ a: 1, b: [1, 2] });
  });

  it("strips // line and /* block */ comments", () => {
    const dirty = `{
      // a comment
      "title": "x", /* inline */ "tags": []
    }`;
    expect(JSON.parse(repairJsonish(dirty))).toEqual({ title: "x", tags: [] });
  });

  it("leaves comment-like and comma-like sequences inside strings untouched", () => {
    const value = '{"description":"see https://x.y, end","title":"a, "}';
    // No structural trailing comma / comment here — the string content must
    // survive verbatim (the // in a URL, the comma before the closing quote).
    expect(JSON.parse(repairJsonish(value))).toEqual({
      description: "see https://x.y, end",
      title: "a, "
    });
  });
});

describe("parseEnrichmentReply", () => {
  it("parses a clean reply", () => {
    expect(parseEnrichmentReply('{"title":"Login screen","tags":[]}').title).toBe("Login screen");
  });

  it("recovers a reply with comments + trailing commas (the Qwen case)", () => {
    const raw = '```json\n{\n  "title": "Receipt", // headline\n  "tags": [],\n}\n```';
    expect(parseEnrichmentReply(raw).title).toBe("Receipt");
  });

  it("still throws on a literal placeholder ellipsis (the Grok `[...]` case)", () => {
    // repairJsonish deliberately does NOT guess at placeholders — this must
    // surface as a parse error so enrichCapture retries with a corrective prompt.
    expect(() => parseEnrichmentReply('{"textAnchors": [...], "title": "x"}')).toThrow();
  });

  it("accepts an over-5 textAnchors array instead of rejecting (the Kimi case)", () => {
    // Kimi returned valid JSON with 7 text anchors and was rejected by the old
    // .max(5) cap, sinking an otherwise-perfect enrichment. The cap is now a
    // generous sanity bound, so this just parses.
    const result = parseEnrichmentReply(
      JSON.stringify({
        title: "Settings",
        description: "AI providers page",
        textAnchors: ["a", "b", "c", "d", "e", "f", "g"]
      })
    );
    expect(result.title).toBe("Settings");
    expect(result.textAnchors).toHaveLength(7);
  });

  it("recovers the real answer past a reasoning model's scratch `{}` (the Kimi empty-retry case)", () => {
    // A reasoning model emits a scratch object early, then the real answer last.
    // The first `{}` defaults to a valid-but-empty result; it must NOT shadow
    // the substantive trailing object.
    const raw =
      "Let me think. First I'll sketch the shape {} then fill it in.\n\n" +
      'Final answer:\n{"title":"Receipt total","description":"A receipt window"}';
    const result = parseEnrichmentReply(raw);
    expect(result.title).toBe("Receipt total");
  });

  it("extractJsonObjects returns every balanced top-level object in order", () => {
    expect(extractJsonObjects('noise {"a":1} mid {"b":{"c":2}} end')).toEqual([
      '{"a":1}',
      '{"b":{"c":2}}'
    ]);
  });
});

describe("buildAcpEnrichmentRepairPrompt", () => {
  it("quotes the bad reply + restates the full task", () => {
    const prompt = buildAcpEnrichmentRepairPrompt(request, '{"textAnchors": [...]}', "the reply was not valid JSON");
    expect(prompt).toMatch(/could not be used/i);
    expect(prompt).toContain("the reply was not valid JSON");
    expect(prompt).toContain("[...]"); // the offending reply is shown back
    // The original task (metadata + contract) is restated for the fresh session.
    expect(prompt).toContain("Figma");
    expect(prompt).toMatch(/ONLY a single JSON object/i);
  });

  it("truncates an overlong bad reply", () => {
    const huge = `{"x":"${"z".repeat(5000)}"}`;
    const prompt = buildAcpEnrichmentRepairPrompt(request, huge, "empty");
    expect(prompt).toContain("…");
    // The full 5000-char run must NOT be echoed back verbatim.
    expect(prompt).not.toContain("z".repeat(5000));
    expect(prompt).toContain("z".repeat(100)); // a bounded prefix is present
  });
});
