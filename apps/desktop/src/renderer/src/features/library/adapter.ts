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
 * Anchored regex patterns matching the lowercased bundle ids of the
 * apps we ship a hand-drawn glyph for. Each pattern:
 *
 *   - Anchors the needle to a dotted segment boundary (start of
 *     string or preceded by `.`) so we only match dotted SEGMENTS,
 *     not arbitrary substrings — `com.acme.notion-importer` no
 *     longer steals Notion's glyph.
 *   - Allows the legitimate trailing-suffix glueing real bundle ids
 *     use (`slackmacgap`, `edgemac`, `vscodeinsiders`, `desktop`,
 *     `client`, `mac`) so we don't false-negative the curated set.
 *
 * Order is irrelevant — patterns are pairwise disjoint by anchor +
 * needle. The first match wins regardless.
 */
const KNOWN_APP_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["vscode",   /(?:^|\.)vscode(?:insiders)?(?:\.|$)/],
  ["chrome",   /(?:^|\.)chrome(?:\.|$)/],
  ["safari",   /(?:^|\.)safari(?:\.|$)/],
  ["slack",    /(?:^|\.)slack(?:macgap)?(?:\.|$)/],
  ["figma",    /(?:^|\.)figma(?:\.desktop)?(?:\.|$)/],
  ["terminal", /(?:^|\.)(?:terminal|ghostty)(?:\.|$)/],
  ["notion",   /(?:^|\.)notion(?:\.|$)/],
  ["github",   /(?:^|\.)github(?:client|desktop)?(?:\.|$)/],
  ["linear",   /(?:^|\.)linear(?:\.|$)/],
  ["zoom",     /(?:^|\.)(?:zoom|zoomus)(?:\.|$)/],
  ["preview",  /(?:^|\.)preview(?:\.|$)/],
  ["finder",   /(?:^|\.)finder(?:\.|$)/],
  ["excel",    /(?:^|\.)excel(?:\.|$)/],
  ["telegram", /(?:^|\.)telegram(?:\.|$)/]
];

/**
 * Bundle-id → AppId mapping with an open fallback set.
 *
 * Known apps map to a curated short id (`"slack"`, `"vscode"`, …)
 * so they pick up the hand-drawn icon set in `AppIcons.tsx`. Anything
 * we don't have a glyph for falls through to the lowercased bundle
 * id itself (`"com.spotify.client"`, `"com.hnc.discord"`) — the
 * Library sidebar groups by that key and the chip renders procedural
 * initials taken from the captured `source_app_name`.
 *
 * Matching is case-insensitive: real bundle ids use CamelCase tail
 * components (`com.apple.Terminal`, `com.microsoft.VSCode`,
 * `com.hnc.Discord`) that wouldn't match a lowercase substring
 * directly. Patterns are anchored to dotted segment boundaries to
 * keep false positives down (`com.acme.notion-importer` won't pick
 * up Notion's glyph).
 */
export function mapBundleIdToAppId(bundleId: string | null): AppId {
  if (bundleId === null) return "any";
  const lower = bundleId.toLowerCase();
  if (lower.length === 0) return "any";
  for (const [appId, pattern] of KNOWN_APP_PATTERNS) {
    if (pattern.test(lower)) return appId;
  }
  return lower;
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
