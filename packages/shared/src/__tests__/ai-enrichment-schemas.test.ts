import { describe, expect, test } from "vitest";
import {
  CaptureEnrichmentSchema,
  EnrichmentResultSchema,
  normalizeTagLabel,
  SuggestedTagSchema
} from "../ai-enrichment-schemas";

describe("EnrichmentResultSchema", () => {
  test("accepts OCR, description, and bounded tags", () => {
    const parsed = EnrichmentResultSchema.parse({
      ocrText: "Deploy succeeded",
      description: "CI status page showing a successful deployment",
      tags: [{ label: "deploy", confidence: 0.91 }]
    });
    expect(parsed.tags[0]?.label).toBe("deploy");
  });

  test("rejects empty tag labels", () => {
    expect(() =>
      EnrichmentResultSchema.parse({
        ocrText: "",
        description: "",
        tags: [{ label: "   ", confidence: 0.5 }]
      })
    ).toThrow();
  });

  test("rejects confidence outside [0, 1]", () => {
    expect(() => SuggestedTagSchema.parse({ label: "deploy", confidence: 1.1 })).toThrow();
  });
});

describe("CaptureEnrichmentSchema", () => {
  test("round-trips nullable empty enrichment", () => {
    const parsed = CaptureEnrichmentSchema.parse({
      captureId: "cap_1",
      latestRunId: null,
      status: null,
      ocrText: null,
      suggestedTitle: null,
      acceptedTitle: null,
      titleAcceptedAt: null,
      suggestedDescription: null,
      acceptedDescription: null,
      descriptionAcceptedAt: null,
      suggestedTags: [],
      acceptedTags: []
    });
    expect(parsed.captureId).toBe("cap_1");
  });

  test("rejects overlong descriptions", () => {
    expect(() =>
      CaptureEnrichmentSchema.parse({
        captureId: "cap_1",
        latestRunId: null,
        status: null,
        ocrText: null,
        suggestedTitle: null,
        acceptedTitle: null,
        titleAcceptedAt: null,
        suggestedDescription: "x".repeat(2_001),
        acceptedDescription: null,
        descriptionAcceptedAt: null,
        suggestedTags: [],
        acceptedTags: []
      })
    ).toThrow();
  });

  test("rejects overlong titles", () => {
    expect(() =>
      CaptureEnrichmentSchema.parse({
        captureId: "cap_1",
        latestRunId: null,
        status: null,
        ocrText: null,
        suggestedTitle: "x".repeat(121),
        acceptedTitle: null,
        titleAcceptedAt: null,
        suggestedDescription: null,
        acceptedDescription: null,
        descriptionAcceptedAt: null,
        suggestedTags: [],
        acceptedTags: []
      })
    ).toThrow();
  });
});

describe("normalizeTagLabel", () => {
  test("trims, folds whitespace, and lowercases", () => {
    expect(normalizeTagLabel("  Prod   Deploy  ")).toBe("prod deploy");
  });
});
