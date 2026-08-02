import type {
  CaptureSearchDiscovery,
  CaptureSearchOrder,
  CaptureSearchRequest,
  CaptureSearchResultRow,
  CaptureSearchTagFilter
} from "@pwrsnap/shared";

/** Keep external-agent list responses small enough to be useful in a tool
 * transcript. The Library command itself keeps its broader internal limit. */
export const LOCAL_AGENT_MCP_DEFAULT_LIMIT = 25;
export const LOCAL_AGENT_MCP_MAX_LIMIT = 50;

export type LocalAgentSearchInput = {
  query?: string | undefined;
  sourceAppNames?: string[] | undefined;
  tagFilter?: CaptureSearchTagFilter | undefined;
  kinds?: Array<"image" | "video"> | undefined;
  dateRange?: { start: string; end: string } | undefined;
  hasOcr?: boolean | undefined;
  order?: CaptureSearchOrder | undefined;
  limit?: number | undefined;
  detail?: "summary" | "enriched" | undefined;
};

export type LocalAgentSearchSummaryRow = {
  id: string;
  kind: "image" | "video";
  capturedAt: string;
  widthPx: number;
  heightPx: number;
  byteSize: number;
  /** Omitted when PwrSnap did not capture source-app context. `bundleId` is
   * read-only diagnostic metadata, not an MCP search parameter. */
  sourceApp?: {
    name?: string;
    bundleId?: string;
  };
  hasAlpha: boolean;
  hasOcr: boolean;
};

export type LocalAgentSearchEnrichedRow = LocalAgentSearchSummaryRow & {
  title: string | null;
  description: string | null;
  tags: string[];
  matchSnippet: string | null;
};

export type LocalAgentSearchRow =
  | LocalAgentSearchSummaryRow
  | LocalAgentSearchEnrichedRow;

export function localAgentMcpResultLimit(
  input: { limit?: number | undefined }
): number {
  return input.limit ?? LOCAL_AGENT_MCP_DEFAULT_LIMIT;
}

export function limitLocalAgentMcpList<T>(
  items: readonly T[],
  input: { limit?: number | undefined }
): { items: T[]; limit: number; hasMore: boolean } {
  const limit = localAgentMcpResultLimit(input);
  return {
    items: items.slice(0, limit),
    limit,
    hasMore: items.length > limit
  };
}

export function toCaptureSearchRequest(
  input: LocalAgentSearchInput,
  options: { notBefore?: string } = {}
): CaptureSearchRequest {
  const dateRange = constrainedDateRange(input.dateRange, options.notBefore);
  return {
    ...(input.query !== undefined ? { query: input.query } : {}),
    ...(input.sourceAppNames !== undefined ? { sourceAppNames: input.sourceAppNames } : {}),
    ...(input.tagFilter !== undefined ? { tagFilter: input.tagFilter } : {}),
    ...(input.kinds !== undefined ? { kinds: input.kinds } : {}),
    ...(dateRange !== undefined ? { dateRange } : {}),
    ...(input.hasOcr !== undefined ? { hasOcr: input.hasOcr } : {}),
    ...(input.order !== undefined ? { order: input.order } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {})
  };
}

/** Mirrors the repository's documented default so MCP responses make their
 * effective order visible even when the caller omitted `order`. */
export function localAgentSearchOrder(input: LocalAgentSearchInput): CaptureSearchOrder {
  return input.order ?? (input.query === undefined ? "newest" : "relevance");
}

/** Explicitly project the discovery surface rather than exposing an internal
 * persistence row. `name` is reusable as sourceAppNames; bundleId stays
 * optional when a human app name cannot be mapped unambiguously. */
export function projectLocalAgentSearchDiscovery(
  discovery: CaptureSearchDiscovery
): CaptureSearchDiscovery {
  return {
    applications: discovery.applications.map((application) => ({
      name: application.name,
      ...(application.bundleId === undefined ? {} : { bundleId: application.bundleId }),
      count: application.count,
      mostRecentCapturedAt: application.mostRecentCapturedAt
    })),
    tags: discovery.tags.map((tag) => ({
      label: tag.label,
      count: tag.count,
      mostRecentCapturedAt: tag.mostRecentCapturedAt
    }))
  };
}

export function searchRangeEndsBefore(
  input: LocalAgentSearchInput,
  notBefore: string
): boolean {
  return (
    input.dateRange !== undefined &&
    Date.parse(input.dateRange.end) < Date.parse(notBefore)
  );
}

function constrainedDateRange(
  requested: LocalAgentSearchInput["dateRange"],
  notBefore: string | undefined
): CaptureSearchRequest["dateRange"] {
  if (notBefore === undefined) return requested;
  if (requested === undefined) {
    return { start: notBefore, end: new Date().toISOString() };
  }
  return {
    start:
      Date.parse(requested.start) < Date.parse(notBefore)
        ? notBefore
        : requested.start,
    end: requested.end
  };
}

export function projectLocalAgentSearchRows(
  rows: readonly CaptureSearchResultRow[],
  detail: "summary" | "enriched" = "summary"
): LocalAgentSearchRow[] {
  return rows.map((row) => {
    const projected = projectLocalAgentCapture(row);
    if (detail === "enriched") return projected;
    return {
      id: projected.id,
      kind: projected.kind,
      capturedAt: projected.capturedAt,
      widthPx: projected.widthPx,
      heightPx: projected.heightPx,
      byteSize: projected.byteSize,
      ...(projected.sourceApp === undefined ? {} : { sourceApp: projected.sourceApp }),
      hasAlpha: projected.hasAlpha,
      hasOcr: projected.hasOcr
    };
  });
}

export function projectLocalAgentCapture(
  row: CaptureSearchResultRow
): LocalAgentSearchRow {
  const { record, enrichment, matchSnippet } = row;
  const sourceApp = record.source_app_name === null && record.source_app_bundle_id === null
    ? undefined
    : {
        ...(record.source_app_name === null ? {} : { name: record.source_app_name }),
        ...(record.source_app_bundle_id === null
          ? {}
          : { bundleId: record.source_app_bundle_id })
      };
  return {
    id: record.id,
    kind: record.kind,
    capturedAt: record.captured_at,
    widthPx: record.width_px,
    heightPx: record.height_px,
    byteSize: record.byte_size,
    ...(sourceApp === undefined ? {} : { sourceApp }),
    hasAlpha: record.has_alpha,
    title: enrichment?.acceptedTitle ?? enrichment?.suggestedTitle ?? null,
    description:
      enrichment?.acceptedDescription ?? enrichment?.suggestedDescription ?? null,
    tags: enrichment?.acceptedTags ?? [],
    hasOcr: (enrichment?.ocrText?.trim().length ?? 0) > 0,
    matchSnippet
  };
}
