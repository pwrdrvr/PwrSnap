import type { CaptureSearchDiscovery, CaptureSearchResultRow } from "@pwrsnap/shared";
import { describe, expect, test } from "vitest";
import {
  LOCAL_AGENT_MCP_DEFAULT_LIMIT,
  LOCAL_AGENT_MCP_MAX_LIMIT,
  limitLocalAgentMcpList,
  localAgentMcpResultLimit,
  localAgentSearchOrder,
  projectLocalAgentSearchDiscovery,
  projectLocalAgentSearchRows,
  searchRangeEndsBefore,
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
      hasAlpha: false,
      hasOcr: true
    }]);
    expect(JSON.stringify(projected)).not.toContain("Private");
  });

  test("maps public structured search filters while omitting undefined fields", () => {
    expect(toCaptureSearchRequest({
      query: "pairing",
      sourceAppNames: ["Claude"],
      tagFilter: { labels: ["Important", "Release blocker"], match: "all" },
      kinds: ["image"],
      hasOcr: false,
      order: "oldest",
      limit: 25,
      detail: "enriched"
    })).toEqual({
      query: "pairing",
      sourceAppNames: ["Claude"],
      tagFilter: { labels: ["Important", "Release blocker"], match: "all" },
      kinds: ["image"],
      hasOcr: false,
      order: "oldest",
      limit: 25
    });
  });

  test("omits source-app context rather than serializing null metadata", () => {
    const row: CaptureSearchResultRow = {
      record: {
        id: "unknown-source",
        kind: "image",
        captured_at: "2026-06-07T12:00:00.000Z",
        legacy_src_path: null,
        bundle_path: null,
        flat_png_path: null,
        bundle_modified_at: null,
        bundle_format_version: 2,
        bundle_edits_version: 0,
        width_px: 100,
        height_px: 100,
        device_pixel_ratio: 1,
        byte_size: 1,
        sha256: "private-content-hash",
        source_app_bundle_id: null,
        source_app_name: null,
        edits_version: 0,
        deleted_at: null,
        has_alpha: false
      },
      enrichment: null,
      matchSnippet: null
    };

    expect(projectLocalAgentSearchRows([row])).toEqual([
      expect.not.objectContaining({ sourceApp: expect.anything() })
    ]);
  });

  test("makes the effective search order explicit", () => {
    expect(localAgentSearchOrder({})).toBe("newest");
    expect(localAgentSearchOrder({ query: "pairing" })).toBe("relevance");
    expect(localAgentSearchOrder({ query: "pairing", order: "oldest" })).toBe("oldest");
  });

  test("bounds MCP list responses and reports truncation", () => {
    const rows = Array.from({ length: LOCAL_AGENT_MCP_DEFAULT_LIMIT + 1 }, (_, index) => index);
    expect(localAgentMcpResultLimit({})).toBe(LOCAL_AGENT_MCP_DEFAULT_LIMIT);
    expect(localAgentMcpResultLimit({ limit: LOCAL_AGENT_MCP_MAX_LIMIT })).toBe(
      LOCAL_AGENT_MCP_MAX_LIMIT
    );
    expect(limitLocalAgentMcpList(rows, {})).toEqual({
      items: rows.slice(0, LOCAL_AGENT_MCP_DEFAULT_LIMIT),
      limit: LOCAL_AGENT_MCP_DEFAULT_LIMIT,
      hasMore: true
    });
    expect(limitLocalAgentMcpList(rows, { limit: 2 })).toEqual({
      items: [0, 1],
      limit: 2,
      hasMore: true
    });
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

  test("clamps requested history to the role horizon", () => {
    const notBefore = "2026-07-25T12:00:00.000Z";
    expect(toCaptureSearchRequest({
      dateRange: {
        start: "2020-01-01T00:00:00.000Z",
        end: "2026-08-01T12:00:00.000Z"
      }
    }, { notBefore })).toEqual({
      dateRange: {
        start: notBefore,
        end: "2026-08-01T12:00:00.000Z"
      }
    });
    expect(searchRangeEndsBefore({
      dateRange: {
        start: "2020-01-01T00:00:00.000Z",
        end: "2020-02-01T00:00:00.000Z"
      }
    }, notBefore)).toBe(true);
  });
});
