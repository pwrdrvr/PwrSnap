import type {
  CaptureSearchRequest,
  CaptureSearchResultRow
} from "@pwrsnap/shared";

export type LocalAgentSearchInput = {
  query?: string | undefined;
  appBundleIds?: Array<string | null> | undefined;
  kinds?: Array<"image" | "video"> | undefined;
  dateRange?: { start: string; end: string } | undefined;
  hasOcr?: boolean | undefined;
  limit?: number | undefined;
};

export type LocalAgentSearchRow = {
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
  title: string | null;
  description: string | null;
  tags: string[];
  hasOcr: boolean;
  matchSnippet: string | null;
};

export function toCaptureSearchRequest(input: LocalAgentSearchInput): CaptureSearchRequest {
  return {
    ...(input.query !== undefined ? { query: input.query } : {}),
    ...(input.appBundleIds !== undefined ? { appBundleIds: input.appBundleIds } : {}),
    ...(input.kinds !== undefined ? { kinds: input.kinds } : {}),
    ...(input.dateRange !== undefined ? { dateRange: input.dateRange } : {}),
    ...(input.hasOcr !== undefined ? { hasOcr: input.hasOcr } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {})
  };
}

export function projectLocalAgentSearchRows(
  rows: readonly CaptureSearchResultRow[]
): LocalAgentSearchRow[] {
  return rows.map(({ record, enrichment, matchSnippet }) =>
    projectLocalAgentCapture({ record, enrichment, matchSnippet })
  );
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
