// Adapter from the real CaptureRecord shape to the fixture-shaped
// Capture the existing Library wireframe expects. Phase 1.8 keeps the
// design-system polish wired while feeding real data; Phase 2's layout
// refactor will rewrite Library.tsx around the real shape and delete
// this adapter.

import type { CaptureRecord } from "@pwrsnap/shared";
import type { AppId } from "../shared/AppIcons";
import type { Capture } from "./captures";

const DAY_LABELS = ["Today", "Yesterday", "Earlier"];

function dayBucket(captured: Date, now: Date): { day: string; date: string } {
  const sameDay =
    captured.getFullYear() === now.getFullYear() &&
    captured.getMonth() === now.getMonth() &&
    captured.getDate() === now.getDate();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    captured.getFullYear() === yesterday.getFullYear() &&
    captured.getMonth() === yesterday.getMonth() &&
    captured.getDate() === yesterday.getDate();

  const monthShort = captured.toLocaleString(undefined, { month: "short" });
  const date = `${monthShort} ${captured.getDate()}`;
  if (sameDay) return { day: DAY_LABELS[0]!, date };
  if (isYesterday) return { day: DAY_LABELS[1]!, date };
  return { day: DAY_LABELS[2]!, date };
}

function timeLabel(captured: Date): string {
  return captured.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * Project a real CaptureRecord into the fixture-shaped Capture the
 * Library wireframe consumes. Source-app id falls back to `any`
 * until Phase 3's NSWorkspace bridge populates source_app_bundle_id.
 */
export function recordToFixture(record: CaptureRecord, sequence: number, now: Date): Capture {
  const captured = new Date(record.captured_at);
  const { day, date } = dayBucket(captured, now);
  const app: AppId = mapBundleIdToAppId(record.source_app_bundle_id);
  const name =
    record.source_app_name !== null && record.source_app_name.length > 0
      ? `${record.source_app_name} · ${timeLabel(captured)}`
      : `Snap · ${timeLabel(captured)}`;
  return {
    id: sequence,
    app,
    n: name,
    tags: [],
    day,
    date,
    time: timeLabel(captured),
    size: Math.round(record.byte_size / 1024),
    w: record.width_px,
    h: record.height_px
  };
}

/**
 * Best-effort bundle-id → AppId mapping. Phase 3 will populate
 * `source_app_bundle_id` properly; for now everything falls back to
 * the generic "any" mark.
 */
export function mapBundleIdToAppId(bundleId: string | null): AppId {
  if (bundleId === null) return "any";
  if (bundleId.includes("vscode") || bundleId.includes("code")) return "vscode";
  if (bundleId.includes("chrome")) return "chrome";
  if (bundleId.includes("safari")) return "safari";
  if (bundleId.includes("slack")) return "slack";
  if (bundleId.includes("figma")) return "figma";
  if (bundleId.includes("terminal") || bundleId.includes("ghostty")) return "terminal";
  if (bundleId.includes("notion")) return "notion";
  if (bundleId.includes("github")) return "github";
  if (bundleId.includes("linear")) return "linear";
  if (bundleId.includes("zoom")) return "zoom";
  if (bundleId.includes("preview")) return "preview";
  if (bundleId.includes("finder")) return "finder";
  if (bundleId.includes("excel")) return "excel";
  if (bundleId.includes("telegram")) return "telegram";
  return "any";
}

/**
 * Map a fixture Capture back to its underlying real-record id (the
 * UUID string), so click handlers can dispatch against the bus. The
 * fixture uses sequential numeric ids; the real id is preserved
 * separately via this map.
 */
export class FixtureBackedRecords {
  private readonly bySequence = new Map<number, CaptureRecord>();
  private readonly bySequenceFixture = new Map<number, Capture>();

  constructor(records: CaptureRecord[]) {
    const now = new Date();
    let seq = 1;
    for (const record of records) {
      const fixture = recordToFixture(record, seq, now);
      this.bySequence.set(seq, record);
      this.bySequenceFixture.set(seq, fixture);
      seq += 1;
    }
  }

  fixtures(): Capture[] {
    return Array.from(this.bySequenceFixture.values());
  }

  recordFor(sequence: number): CaptureRecord | null {
    return this.bySequence.get(sequence) ?? null;
  }
}
