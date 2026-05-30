import { basename, extname } from "node:path";

import { slugifyFilenameStem } from "@pwrsnap/shared";
import type { FilenameTimestampZone } from "@pwrsnap/shared";

const SOURCE_APP_SEGMENT_MAX = 32;
const CONTENT_SEGMENT_MAX = 80;
const FALLBACK_APP_SEGMENT = "unknown";

export type BundleFilenameParts = {
  capturedAt: string;
  sourceAppName: string | null;
  effectiveFilenameStem: string | null;
  sha256: string;
  timestampZone?: FilenameTimestampZone;
};

export function buildCaptureBundleFilenameStem(parts: BundleFilenameParts): string {
  const timestamp = formatCaptureTimestamp(parts.capturedAt, parts.timestampZone ?? "local");
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

function formatCaptureTimestamp(
  capturedAt: string,
  timestampZone: FilenameTimestampZone
): string {
  const date = new Date(capturedAt);
  if (!Number.isNaN(date.getTime())) {
    const parts =
      timestampZone === "utc"
        ? {
            year: date.getUTCFullYear(),
            month: date.getUTCMonth() + 1,
            day: date.getUTCDate(),
            hour: date.getUTCHours(),
            minute: date.getUTCMinutes(),
            second: date.getUTCSeconds()
          }
        : {
            year: date.getFullYear(),
            month: date.getMonth() + 1,
            day: date.getDate(),
            hour: date.getHours(),
            minute: date.getMinutes(),
            second: date.getSeconds()
          };
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}-${pad2(parts.minute)}-${pad2(parts.second)}`;
  }
  return "unknown-date";
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function shortHashSlug(sha256: string): string {
  const slug = sha256.toLowerCase().replace(/[^a-f0-9]/g, "");
  return slug.slice(0, 8) || "nohash";
}

function truncateSegment(segment: string, max: number): string {
  if (segment.length <= max) return segment;
  return segment.slice(0, max).replace(/-+$/g, "");
}
