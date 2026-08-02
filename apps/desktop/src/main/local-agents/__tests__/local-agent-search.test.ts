import type { CaptureSearchDiscovery, CaptureSearchResultRow } from "@pwrsnap/shared";
import { describe, expect, test } from "vitest";
import {
  localAgentSearchOrder,
  projectLocalAgentSearchDiscovery,
  projectLocalAgentSearchRows,
  toCaptureSearchRequest
} from "../local-agent-search";

describe("local-agent search boundary", () => {
  test("projects search rows without internal paths, hashes, or full OCR", () => {
    const row: CaptureSearchResultRow = {
      record: {
        id: "cap_123",
        kind: "image",
        captured_at: "2026-06-07T12:00:00.000Z",
        legacy_src_path: "/Users/person/private/legacy.png",
        bundle_path: "/Users/person/Documents/PwrSnap/secret.pwrsnap",
        flat_png_path: "/Users/person/Documents/PwrSnap/secret.png",
        bundle_modified_at: "2026-06-07T12:00:00.000Z",
        bundle_format_version: 2,
        bundle_edits_version: 4,
        width_px: 1440,
        height_px: 900,
        device_pixel_ratio: 2,
        byte_size: 123_456,
        sha256: "private-content-hash",
        source_app_bundle_id: "com.example.app",
        source_app_name: "Example",
        edits_version: 4,
        deleted_at: null,
        has_alpha: false
      },
      enrichment: {
        captureId: "cap_123",
        latestRunId: "run_123",
        status: "completed",
        error: null,
        ocrText: "private full OCR text",
        suggestedTitle: "Suggested title",
        acceptedTitle: "Accepted title",
        titleAcceptedAt: "2026-06-07T12:01:00.000Z",
        suggestedDescription: "Suggested description",
        acceptedDescription: null,
        descriptionAcceptedAt: null,
        suggestedFilenameStem: "private-filename",
        acceptedFilenameStem: null,
        filenameAcceptedAt: null,
        suggestedTags: [],
        acceptedTags: ["pairing", "settings"]
      },
      matchSnippet: "A [pairing] request"
    };

    const projected = projectLocalAgentSearchRows([row], "enriched");
    expect(projected).toEqual([
      {
        id: "cap_123",
        kind: "image",
        capturedAt: "2026-06-07T12:00:00.000Z",
        widthPx: 1440,
        heightPx: 900,
        byteSize: 123_456,
        sourceApp: {
          bundleId: "com.example.app",
          name: "Example"
        },
        hasAlpha: false,
        title: "Accepted title",
        description: "Suggested description",
        tags: ["pairing", "settings"],
        hasOcr: true,
        matchSnippet: "A [pairing] request"
      }
    ]);
    const json = JSON.stringify(projected);
    expect(json).not.toContain("/Users/person");
    expect(json).not.toContain("private-content-hash");
    expect(json).not.toContain("private full OCR text");
    expect(json).not.toContain("private-filename");
  });

  test("defaults to summary rows without generated text or match snippets", () => {
    const row: CaptureSearchResultRow = {
      record: {
        id: "cap_123",
        kind: "image",
        captured_at: "2026-06-07T12:00:00.000Z",
        legacy_src_path: null,
        bundle_path: "/private/capture.pwrsnap",
        flat_png_path: null,
        bundle_modified_at: "2026-06-07T12:00:00.000Z",
        bundle_format_version: 2,
        bundle_edits_version: 4,
        width_px: 1440,
        height_px: 900,
        device_pixel_ratio: 2,
        byte_size: 123_456,
        sha256: "private-content-hash",
        source_app_bundle_id: null,
        source_app_name: null,
        edits_version: 4,
        deleted_at: null,
        has_alpha: false
      },
      enrichment: {
        captureId: "cap_123",
        latestRunId: "run_123",
        status: "completed",
        error: null,
        ocrText: "private full OCR text",
        suggestedTitle: "Private title",
        acceptedTitle: null,
        titleAcceptedAt: null,
        suggestedDescription: "Private description",
        acceptedDescription: null,
        descriptionAcceptedAt: null,
        suggestedFilenameStem: null,
        acceptedFilenameStem: null,
        filenameAcceptedAt: null,
        suggestedTags: [],
        acceptedTags: [],
      },
      matchSnippet: "Private OCR [match]"
    };

    const projected = projectLocalAgentSearchRows([row]);
    expect(projected).toEqual([{
      id: "cap_123",
      kind: "image",
      capturedAt: "2026-06-07T12:00:00.000Z",
      widthPx: 1440,
      heightPx: 900,
      byteSize: 123_456,
      sourceApp: { bundleId: null, name: null },
      hasAlpha: false,
      hasOcr: true
    }]);
    expect(JSON.stringify(projected)).not.toContain("Private");
  });

  test("preserves structured search filters while omitting undefined fields", () => {
    expect(toCaptureSearchRequest({
      query: "pairing",
      appBundleIds: ["com.example.app"],
      sourceAppNames: ["Claude"],
      includeCapturesWithoutSourceApp: true,
      tagFilter: { labels: ["Important", "Release blocker"], match: "all" },
      kinds: ["image"],
      hasOcr: false,
      order: "oldest",
      limit: 25,
      detail: "enriched"
    })).toEqual({
      query: "pairing",
      appBundleIds: ["com.example.app", null],
      sourceAppNames: ["Claude"],
      tagFilter: { labels: ["Important", "Release blocker"], match: "all" },
      kinds: ["image"],
      hasOcr: false,
      order: "oldest",
      limit: 25
    });
  });

  test("can filter exclusively to captures with no source application", () => {
    expect(toCaptureSearchRequest({ includeCapturesWithoutSourceApp: true })).toEqual({
      appBundleIds: [null]
    });
  });

  test("makes the effective search order explicit", () => {
    expect(localAgentSearchOrder({})).toBe("newest");
    expect(localAgentSearchOrder({ query: "pairing" })).toBe("relevance");
    expect(localAgentSearchOrder({ query: "pairing", order: "oldest" })).toBe("oldest");
  });

  test("projects reusable discovery filters with optional bundle metadata", () => {
    const discovery: CaptureSearchDiscovery = {
      applications: [
        {
          name: "Claude",
          bundleId: "com.anthropic.claudefordesktop",
          count: 4,
          mostRecentCapturedAt: "2026-06-07T12:00:00.000Z"
        },
        {
          name: "Claude Preview",
          count: 2,
          mostRecentCapturedAt: "2026-06-06T12:00:00.000Z"
        }
      ],
      tags: [
        {
          label: "Important",
          count: 3,
          mostRecentCapturedAt: "2026-06-07T12:00:00.000Z"
        }
      ]
    };

    expect(projectLocalAgentSearchDiscovery(discovery)).toEqual(discovery);
    expect(JSON.stringify(projectLocalAgentSearchDiscovery(discovery))).not.toContain(
      '"bundleId":null'
    );
  });
});
