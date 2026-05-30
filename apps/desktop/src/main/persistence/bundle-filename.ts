import { basename, extname } from "node:path";

import { slugifyFilenameStem } from "@pwrsnap/shared";

const SOURCE_APP_SEGMENT_MAX = 32;
const CONTENT_SEGMENT_MAX = 80;
const FALLBACK_APP_SEGMENT = "unknown";

export type BundleFilenameParts = {
  capturedAt: string;
  sourceAppName: string | null;
  effectiveFilenameStem: string | null;
  sha256: string;
};

export function buildCaptureBundleFilenameStem(parts: BundleFilenameParts): string {
  const timestamp = formatCaptureTimestamp(parts.capturedAt);
  const appSlug = truncateSegment(
    slugifyFilenameStem(parts.sourceAppName ?? ""),
    SOURCE_APP_SEGMENT_MAX
  ) || FALLBACK_APP_SEGMENT;
  const contentSlug = truncateSegment(
    slugifyFilenameStem(parts.effectiveFilenameStem ?? ""),
    CONTENT_SEGMENT_MAX
  );
  const hashSlug = shortHashSlug(parts.sha256);

  const segments = [timestamp, appSlug];
  if (contentSlug.length > 0 && contentSlug !== appSlug) {
    segments.push(contentSlug);
  }
  segments.push(hashSlug);
  return segments.join("_");
}

export function bundleStemFromPath(bundlePath: string): string {
  const name = basename(bundlePath);
  const ext = extname(name);
  return ext === ".pwrsnap" ? name.slice(0, -ext.length) : name;
}

function formatCaptureTimestamp(capturedAt: string): string {
  const date = new Date(capturedAt);
  if (!Number.isNaN(date.getTime())) {
    return date.toISOString().slice(0, 19).replace(/:/g, "-");
  }
  return "unknown-date";
}

function shortHashSlug(sha256: string): string {
  const slug = sha256.toLowerCase().replace(/[^a-f0-9]/g, "");
  return slug.slice(0, 8) || "nohash";
}

function truncateSegment(segment: string, max: number): string {
  if (segment.length <= max) return segment;
  return segment.slice(0, max).replace(/-+$/g, "");
}
