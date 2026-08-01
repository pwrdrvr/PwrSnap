import type {
  CaptureSearchRequest,
  CaptureSearchResultRow
} from "@pwrsnap/shared";

export type LocalAgentSearchInput = {
  query?: string | undefined;
  appBundleIds?: string[] | undefined;
  includeCapturesWithoutSourceApp?: boolean | undefined;
  kinds?: Array<"image" | "video"> | undefined;
  dateRange?: { start: string; end: string } | undefined;
  hasOcr?: boolean | undefined;
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
  sourceApp: {
    bundleId: string | null;
    name: string | null;
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

export function toCaptureSearchRequest(input: LocalAgentSearchInput): CaptureSearchRequest {
  const appBundleIds = input.appBundleIds === undefined
    ? input.includeCapturesWithoutSourceApp === true
      ? [null]
      : undefined
    : [
        ...input.appBundleIds,
        ...(input.includeCapturesWithoutSourceApp === true ? [null] : [])
      ];
  return {
    ...(input.query !== undefined ? { query: input.query } : {}),
    ...(appBundleIds !== undefined ? { appBundleIds } : {}),
    ...(input.kinds !== undefined ? { kinds: input.kinds } : {}),
    ...(input.dateRange !== undefined ? { dateRange: input.dateRange } : {}),
    ...(input.hasOcr !== undefined ? { hasOcr: input.hasOcr } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {})
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
      sourceApp: projected.sourceApp,
      hasAlpha: projected.hasAlpha,
      hasOcr: projected.hasOcr
    };
  });
}

export function projectLocalAgentCapture(
  row: CaptureSearchResultRow
): LocalAgentSearchRow {
  const { record, enrichment, matchSnippet } = row;
  return {
    id: record.id,
    kind: record.kind,
    capturedAt: record.captured_at,
    widthPx: record.width_px,
    heightPx: record.height_px,
    byteSize: record.byte_size,
    sourceApp: {
      bundleId: record.source_app_bundle_id,
      name: record.source_app_name
    },
    hasAlpha: record.has_alpha,
    title: enrichment?.acceptedTitle ?? enrichment?.suggestedTitle ?? null,
    description:
      enrichment?.acceptedDescription ?? enrichment?.suggestedDescription ?? null,
    tags: enrichment?.acceptedTags ?? [],
    hasOcr: (enrichment?.ocrText?.trim().length ?? 0) > 0,
    matchSnippet
  };
}
