import { describe, expect, it } from "vitest";
import {
  CAPTURE_ENRICHMENT_SCHEMA,
  parseCaptureEnrichmentResponse
} from "../enrichment-schema";

describe("capture enrichment schema", () => {
  it("parses fenced JSON from Codex", () => {
    const parsed = parseCaptureEnrichmentResponse(`\`\`\`json
{
  "ocrText": "Invoice\\nTotal $12.00",
  "description": "A receipt window showing a total.",
  "tags": [{ "label": "receipt", "confidence": 0.9 }]
}
\`\`\``);

    expect(parsed.ocrText).toContain("Invoice");
    expect(parsed.description).toBe("A receipt window showing a total.");
    expect(parsed.tags).toEqual([{ label: "receipt", confidence: 0.9 }]);
  });

  it("rejects malformed results", () => {
    expect(() =>
      parseCaptureEnrichmentResponse(
        JSON.stringify({ ocrText: "", description: "", tags: [{ label: "" }] })
      )
    ).toThrow();
  });

  it("exposes a strict object output schema", () => {
    expect(CAPTURE_ENRICHMENT_SCHEMA).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["ocrText", "description", "tags"]
    });
  });
});
