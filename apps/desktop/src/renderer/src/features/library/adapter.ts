// Adapter from the real CaptureRecord shape to the fixture-shaped
// Capture the existing Library wireframe expects. Phase 1.8 keeps the
// design-system polish wired while feeding real data; Phase 2's layout
// refactor will rewrite Library.tsx around the real shape and delete
// this adapter.

import type { CaptureRecord, SizzleProject } from "@pwrsnap/shared";
import type { AppId } from "../shared/AppIcons";
import { PROJECT_APP_KEY, type Capture } from "./captures";

/**
 * Bucket a capture's date into a section header. The returned `day`
 * string is the section's grouping key (so it must be UNIQUE per
 * calendar day — otherwise `groupByDay` collapses different days
 * into the same bucket and the user sees one giant section). The
 * `date` string is the short meta shown to the right of the header,
 * or empty when the `day` field already conveys the absolute date.
 *
 * Format:
 *   - Same day as `now`            → day="Today",     date="May 7"
 *   - Day before `now`             → day="Yesterday", date="May 6"
 *   - Same year, older             → day="Wed, May 4", date=""
 *   - Different year               → day="Wed, May 4, 2025", date=""
 *
 * Relative labels (Today / Yesterday) keep the absolute date in the
 * meta line so the user knows what date "Today" maps to. Explicit-
 * date labels already include the date in the day field, so the meta
 * line drops the redundant date and just shows "{count} captures".
 *
 * Including the weekday in older labels keeps the sidebar scannable
 * (most users remember "I took that on a Tuesday" before the exact
 * date). The year is included only when it differs from `now`'s year
 * — recent labels stay short, cross-year labels disambiguate.
 */
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
  const sameYear = captured.getFullYear() === now.getFullYear();
  const absoluteDate = sameYear
    ? `${monthShort} ${captured.getDate()}`
    : `${monthShort} ${captured.getDate()}, ${captured.getFullYear()}`;

  if (sameDay) return { day: "Today", date: absoluteDate };
  if (isYesterday) return { day: "Yesterday", date: absoluteDate };
  const weekday = captured.toLocaleString(undefined, { weekday: "short" });
  const day = `${weekday}, ${absoluteDate}`;
  // Date is empty for explicit-date labels — the day field already
  // contains the absolute date; the renderers omit the "·" + date
  // segment when this is empty so we don't get "Wed, May 4 · May 4".
  return { day, date: "" };
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
  const appName =
    record.source_app_name !== null && record.source_app_name.length > 0
      ? record.source_app_name
      : null;
  const name =
    appName !== null
      ? `${appName} · ${timeLabel(captured)}`
      : `Snap · ${timeLabel(captured)}`;
  return {
    id: sequence,
    app,
    appName,
    bundleId: record.source_app_bundle_id,
    n: name,
    tags: [],
    day,
    date,
    time: timeLabel(captured),
    size: Math.round(record.byte_size / 1024),
    w: record.width_px,
    h: record.height_px,
    kind: record.kind
  };
}

/**
 * Project a SizzleProject into the fixture-shaped Capture so the
 * Library day-grouped grid + virtualizer can render it as a cell
 * alongside image/video captures. Day-bucket pivots on
 * `project.createdAt` so the grid position is stable while the user
 * edits or renders the project.
 *
 * `app` is a synthetic key (`"_sizzle_"`) that the Source App filter
 * doesn't enumerate; projects never appear under a source-app filter
 * which is the correct semantic (projects aren't FROM any app).
 */
export function projectToFixture(
  project: SizzleProject,
  sequence: number,
  now: Date
): Capture {
  const created = new Date(project.createdAt);
  const { day, date } = dayBucket(created, now);
  return {
    id: sequence,
    app: PROJECT_APP_KEY,
    appName: "Sizzle Reel",
    bundleId: null,
    n: project.name,
    tags: [],
    day,
    date,
    time: timeLabel(created),
    size: 0,
    w: 1920,
    h: 1080,
    kind: "project",
    projectId: project.id
  };
}

/**
 * Bundle-id → AppId grouping key.
 *
 * The AppId is a stable, app-distinctive key the Library sidebar
 * groups + filters by. We use the LOWERCASED bundle id directly
 * (`"com.tinyspeck.slackmacgap"`, `"com.spotify.client"`) so two
 * captures of the same app — even when macOS returns the bundle id
 * with different casing across launches (`com.hnc.Discord` vs
 * `com.hnc.discord`) — fold into the same sidebar group.
 *
 * No brand mapping: the key is NOT used to pick a brand-specific
 * glyph or palette. The chip's icon comes from the OS-extracted app
 * icon (resolved off the raw `bundleId` via the `pwrsnap-app-icon://`
 * protocol), falling back to two-letter procedural initials derived
 * from the captured `source_app_name` / bundle-id segments. `null` /
 * empty bundle ids fold into the synthetic `"any"` group.
 */
export function mapBundleIdToAppId(bundleId: string | null): AppId {
  if (bundleId === null) return "any";
  const lower = bundleId.toLowerCase();
  if (lower.length === 0) return "any";
  return lower;
}

/**
 * Map a fixture Capture back to its underlying real-record id (the
 * UUID string) so click handlers can dispatch against the bus. The
 * fixture uses sequential numeric ids; the real id is preserved
 * separately via this map.
 *
 * Accepts an optional `projects` argument so the grid renders Sizzle
 * Reels projects inline with captures, ordered into the same
 * day-buckets by `project.createdAt`. Project fixtures get a
 * synthetic `app: "_sizzle_"` so the Source App filter doesn't
 * enumerate them. `recordFor` returns null for project fixtures;
 * call `projectFor(sequence)` instead.
 */
export class FixtureBackedRecords {
  private readonly bySequence = new Map<number, CaptureRecord>();
  private readonly bySequenceFixture = new Map<number, Capture>();
  private readonly bySequenceProject = new Map<number, SizzleProject>();
  private readonly byRecordId = new Map<string, CaptureRecord>();

  constructor(records: CaptureRecord[], projects: ReadonlyArray<SizzleProject> = []) {
    const now = new Date();
    let seq = 1;
    for (const record of records) {
      const fixture = recordToFixture(record, seq, now);
      this.bySequence.set(seq, record);
      this.byRecordId.set(record.id, record);
      this.bySequenceFixture.set(seq, fixture);
      seq += 1;
    }
    for (const project of projects) {
      const fixture = projectToFixture(project, seq, now);
      this.bySequenceProject.set(seq, project);
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

  projectFor(sequence: number): SizzleProject | null {
    return this.bySequenceProject.get(sequence) ?? null;
  }

  recordById(id: string): CaptureRecord | null {
    return this.byRecordId.get(id) ?? null;
  }
}
