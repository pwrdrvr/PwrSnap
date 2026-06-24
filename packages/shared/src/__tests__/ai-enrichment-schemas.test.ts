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

  test("drops blank tag labels instead of rejecting the whole result", () => {
    // Lenient by design: weak ACP models over-produce. A blank-label tag is
    // dropped (not a hard failure) so a valid caption/description survives.
    const parsed = EnrichmentResultSchema.parse({
      title: "Build status",
      tags: [{ label: "   ", confidence: 0.5 }, { label: "ci", confidence: 0.8 }]
    });
    expect(parsed.tags).toEqual([{ label: "ci", confidence: 0.8 }]);
  });

  test("accepts a generous number of text anchors (no nitpicking 5 vs 6)", () => {
    const parsed = EnrichmentResultSchema.parse({
      title: "x",
      textAnchors: ["a", "b", "c", "d", "e", "f", "g"]
    });
    expect(parsed.textAnchors).toHaveLength(7);
  });

  test("only clamps text anchors at the sanity ceiling (100)", () => {
    const parsed = EnrichmentResultSchema.parse({
      title: "x",
      textAnchors: Array.from({ length: 150 }, (_, i) => `anchor-${i}`)
    });
    expect(parsed.textAnchors).toHaveLength(100);
  });

  test("clamps an over-length title rather than rejecting", () => {
    const parsed = EnrichmentResultSchema.parse({ title: "T".repeat(200) });
    expect(parsed.title).toHaveLength(120);
  });

  test("drops a structurally-wrong field instead of sinking the whole result", () => {
    // A model returns `title` as an object (genuinely wrong type) but the
    // description/OCR are perfect. The bad field drops to its default; the
    // valuable fields survive. No single field can fail the whole parse.
    const parsed = EnrichmentResultSchema.parse({
      title: { unexpected: "object" },
      description: "A login screen with an SSO button",
      ocrText: "Sign in with SSO"
    });
    expect(parsed.title).toBe("");
    expect(parsed.description).toBe("A login screen with an SSO button");
    expect(parsed.ocrText).toBe("Sign in with SSO");
  });

  test("drops a non-array tags value instead of rejecting", () => {
    const parsed = EnrichmentResultSchema.parse({
      title: "Build log",
      tags: "ci,deploy" // a string, not an array
    });
    expect(parsed.title).toBe("Build log");
    expect(parsed.tags).toEqual([]);
  });

  test("coerces a numeric title to a string rather than rejecting", () => {
    const parsed = EnrichmentResultSchema.parse({ title: 42 });
    expect(parsed.title).toBe("42");
  });

  test("nulls an out-of-range tag confidence instead of rejecting", () => {
    const parsed = EnrichmentResultSchema.parse({
      title: "x",
      tags: [{ label: "deploy", confidence: 1.1 }]
    });
    expect(parsed.tags).toEqual([{ label: "deploy", confidence: null }]);
  });

  test("rejects confidence outside [0, 1] on the persisted SuggestedTagSchema", () => {
    // The DB-facing schema stays strict — only the AI-output schema is lenient.
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
      suggestedFilenameStem: null,
      acceptedFilenameStem: null,
      filenameAcceptedAt: null,
      suggestedDescription: null,
      acceptedDescription: null,
      descriptionAcceptedAt: null,
      suggestedTags: [],
      acceptedTags: []
    });
    expect(parsed.captureId).toBe("cap_1");
  });

  test("clamps overlong persisted run errors", () => {
    const parsed = CaptureEnrichmentSchema.parse({
      captureId: "cap_1",
      latestRunId: "run_1",
      status: "failed",
      error: `  ${"x".repeat(2_500)}  `,
      ocrText: null,
      suggestedTitle: null,
      acceptedTitle: null,
      titleAcceptedAt: null,
      suggestedFilenameStem: null,
      acceptedFilenameStem: null,
      filenameAcceptedAt: null,
      suggestedDescription: null,
      acceptedDescription: null,
      descriptionAcceptedAt: null,
      suggestedTags: [],
      acceptedTags: []
    });
    expect(parsed.error).toHaveLength(2_000);
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
      suggestedFilenameStem: null,
      acceptedFilenameStem: null,
      filenameAcceptedAt: null,
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
      suggestedFilenameStem: null,
      acceptedFilenameStem: null,
      filenameAcceptedAt: null,
        suggestedDescription: null,
        acceptedDescription: null,
        descriptionAcceptedAt: null,
        suggestedTags: [],
        acceptedTags: []
      })
    ).toThrow();
  });
});

describe("slugifyFilenameStem (via AcceptFilenameStemRequestSchema)", () => {
  test("lowercases, collapses runs of non-alphanumeric to '-', strips edges", async () => {
    const { AcceptFilenameStemRequestSchema, slugifyFilenameStem } = await import(
      "../ai-enrichment-schemas"
    );

    expect(slugifyFilenameStem("My Awesome File!")).toBe("my-awesome-file");
    expect(slugifyFilenameStem("  --hello---world__foo bar  ")).toBe("hello-world-foo-bar");
    expect(slugifyFilenameStem("UPPER_case-MixED")).toBe("upper-case-mixed");

    // Verb validator runs the slug + then enforces non-empty + ≤120.
    const parsed = AcceptFilenameStemRequestSchema.parse({
      captureId: "cap_1",
      filenameStem: "My Awesome File!"
    });
    expect(parsed.filenameStem).toBe("my-awesome-file");
  });

  test("rejects input that slugifies to empty", async () => {
    const { AcceptFilenameStemRequestSchema } = await import("../ai-enrichment-schemas");
    expect(() =>
      AcceptFilenameStemRequestSchema.parse({
        captureId: "cap_1",
        filenameStem: "!!!---___"
      })
    ).toThrow();
  });
});

describe("normalizeTagLabel", () => {
  test("trims, folds whitespace, and lowercases", () => {
    expect(normalizeTagLabel("  Prod   Deploy  ")).toBe("prod deploy");
  });
});
