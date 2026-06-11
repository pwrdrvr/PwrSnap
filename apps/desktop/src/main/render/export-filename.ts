import type { CaptureEnrichment, CaptureRecord, RenderPreset, VideoPreset } from "@pwrsnap/shared";
import { slugifyFilenameStem } from "@pwrsnap/shared";

const FALLBACK_STEM = "pwrsnap";
const STEM_MAX = 120;

export type ExportFilenamePreset = RenderPreset | VideoPreset;

export function buildPresetExportDisplayName(args: {
  record: Pick<CaptureRecord, "id" | "source_app_name">;
  enrichment: Pick<CaptureEnrichment, "acceptedFilenameStem" | "suggestedFilenameStem"> | null;
  preset: ExportFilenamePreset;
  ext: string;
}): string {
  const stem = exportFilenameStem(args.record, args.enrichment);
  const ext = normalizeExtension(args.ext);
  return `${stem}-${args.preset}.${ext}`;
}

export function exportFilenameStem(
  record: Pick<CaptureRecord, "id" | "source_app_name">,
  enrichment: Pick<CaptureEnrichment, "acceptedFilenameStem" | "suggestedFilenameStem"> | null
): string {
  const candidates = [
    enrichment?.acceptedFilenameStem,
    enrichment?.suggestedFilenameStem,
    record.source_app_name,
    record.id
  ];
  for (const candidate of candidates) {
    const slug = truncateStem(slugifyFilenameStem(candidate ?? ""));
    if (slug.length > 0) return slug;
  }
  return FALLBACK_STEM;
}

function normalizeExtension(ext: string): string {
  const normalized = ext.trim().replace(/^\.+/, "").toLowerCase();
  return normalized.length > 0 ? normalized : "bin";
}

function truncateStem(stem: string): string {
  if (stem.length <= STEM_MAX) return stem;
  return stem.slice(0, STEM_MAX).replace(/-+$/g, "");
}
