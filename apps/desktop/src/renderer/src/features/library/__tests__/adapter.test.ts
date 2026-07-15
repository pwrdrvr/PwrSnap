// Tests for the bundle-id → AppId grouping key. The mapper is pure
// logic: it lowercases the bundle id so two captures of the same app
// fold into one sidebar group regardless of the casing macOS returns,
// with null / empty folding into the synthetic `"any"` group. It does
// NOT map bundle ids onto brand-specific keys — the chip icon comes
// from the OS-extracted app icon (keyed off the raw bundle id) or the
// two-letter procedural initials, never a brand facsimile.

import { describe, expect, test } from "vitest";
import type { CaptureRecord, SizzleProject } from "@pwrsnap/shared";
import {
  FixtureBackedRecords,
  isSameLocalDay,
  mapBundleIdToAppId,
  projectToFixture,
  recordToFixture
} from "../adapter";
import { PROJECT_APP_KEY } from "../captures";

// Helpers — build the minimal fixture shapes the adapter needs. Each
// helper takes a sparse override so individual tests can change just
// the field they care about without restating the rest. Keep these
// LOCAL to the test file (not exported from production code) so a
// future schema change to `SizzleProject` / `CaptureRecord` doesn't
// silently degrade the test signal — the test must be edited in lock
// step with the type to keep compiling.
function makeProject(overrides: Partial<SizzleProject> = {}): SizzleProject {
  return {
    id: "proj-1",
    name: "Untitled reel",
    createdAt: "2026-05-27T00:00:00.000Z",
    modifiedAt: "2026-05-27T12:00:00.000Z",
    coverCaptureId: null,
    scenes: [],
    voice: "alloy",
    ttsModel: "tts-1",
    ttsProvider: "openai",
    resolution: "1080p",
    outputPath: null,
    lastRenderedAt: null,
    ...overrides
  };
}

function makeRecord(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
  return {
    id: "rec-1",
    kind: "image",
    captured_at: "2026-05-27T10:00:00.000Z",
    legacy_src_path: null,
    bundle_path: null,
    flat_png_path: null,
    bundle_modified_at: null,
    bundle_format_version: 2,
    bundle_edits_version: 0,
    width_px: 1920,
    height_px: 1080,
    device_pixel_ratio: 2,
    byte_size: 1024 * 200,
    sha256: "deadbeef",
    source_app_bundle_id: null,
    source_app_name: null,
    edits_version: 0,
    has_alpha: false,
    deleted_at: null,
    ...overrides
  };
}

describe("mapBundleIdToAppId — null / empty input", () => {
  test("null bundle id falls back to 'any'", () => {
    expect(mapBundleIdToAppId(null)).toBe("any");
  });

  test("empty string falls back to 'any'", () => {
    expect(mapBundleIdToAppId("")).toBe("any");
  });
});

describe("mapBundleIdToAppId — lowercased passthrough (no brand mapping)", () => {
  // The key is ALWAYS the lowercased bundle id verbatim — no bundle
  // id is folded onto a brand-specific short key. Each row is the
  // EXACT id macOS returns from CFBundleIdentifier; the expected
  // value is just its lowercase form. This is the stable sidebar
  // group key; the chip's icon is resolved separately off the raw
  // bundle id (OS-extracted) or from procedural initials.
  test.each<[string, string]>([
    ["com.tinyspeck.slackmacgap", "com.tinyspeck.slackmacgap"],
    ["com.apple.Terminal", "com.apple.terminal"],
    ["com.microsoft.VSCode", "com.microsoft.vscode"],
    ["com.microsoft.VSCodeInsiders", "com.microsoft.vscodeinsiders"],
    ["com.apple.finder", "com.apple.finder"],
    ["com.google.Chrome", "com.google.chrome"],
    ["com.apple.Safari", "com.apple.safari"],
    ["com.figma.Desktop", "com.figma.desktop"],
    ["notion.id", "notion.id"],
    ["com.github.GitHubClient", "com.github.githubclient"],
    ["com.linear.LinearMac", "com.linear.linearmac"],
    ["us.zoom.xos", "us.zoom.xos"],
    ["com.apple.Preview", "com.apple.preview"],
    ["com.microsoft.Excel", "com.microsoft.excel"],
    ["ru.keepcoder.Telegram", "ru.keepcoder.telegram"],
    ["com.mitchellh.ghostty", "com.mitchellh.ghostty"]
  ])("%s → %s (lowercased, no brand key)", (bundleId, expected) => {
    expect(mapBundleIdToAppId(bundleId)).toBe(expected);
  });
});

describe("mapBundleIdToAppId — grouping key is stable across casing", () => {
  // The Library sidebar groups by this key, so two captures of the
  // same app must produce the same key regardless of whether macOS
  // returned the bundle id as `com.hnc.Discord` or `com.hnc.discord`.
  test.each<[string, string]>([
    ["com.spotify.client", "com.spotify.client"],
    ["com.hnc.Discord", "com.hnc.discord"],
    ["com.microsoft.edgemac", "com.microsoft.edgemac"],
    ["com.apple.ActivityMonitor", "com.apple.activitymonitor"],
    ["com.anthropic.claudefordesktop", "com.anthropic.claudefordesktop"],
    ["com.github.Electron", "com.github.electron"],
    ["com.openai.codex", "com.openai.codex"],
    ["com.apple.systempreferences", "com.apple.systempreferences"],
    ["com.zeitalabs.jottleai", "com.zeitalabs.jottleai"]
  ])("%s → %s (lowercased)", (bundleId, expected) => {
    expect(mapBundleIdToAppId(bundleId)).toBe(expected);
  });

  test("differently-cased ids of the same app fold into one group key", () => {
    expect(mapBundleIdToAppId("com.hnc.Discord")).toBe(
      mapBundleIdToAppId("com.hnc.discord")
    );
  });
});

describe("mapBundleIdToAppId — no facsimile false positives", () => {
  // No brand mapping means a third-party clone like
  // `com.acme.notion-importer` can never steal another app's brand
  // glyph — it just gets its own lowercased group key and a
  // procedural initials icon. These rows pin that there's no
  // residual substring/brand matching.
  test.each<string>([
    "com.acme.notion-importer",
    "com.someone.fakelinear",
    "com.example.previewer",
    "com.anothercompany.figmaclone",
    "com.apple.dt.Xcode"
  ])("%s → its own lowercased key (no brand fold)", (bundleId) => {
    expect(mapBundleIdToAppId(bundleId)).toBe(bundleId.toLowerCase());
  });
});

describe("projectToFixture — shape + day bucketing", () => {
  // The grid renders projects as cells alongside image/video captures.
  // The Capture view-model fields it relies on are:
  //
  //   - `kind: "project"`        → CellThumb branches on this
  //   - `app: PROJECT_APP_KEY`   → keeps Source-App filter from
  //                                 enumerating projects
  //   - `projectId`              → click handler dispatches sizzle:open
  //   - `day` / `date`           → day-grouped grid bucket key (must
  //                                 reflect stable `createdAt`, not now)
  //
  // The tests below are scoped to those invariants — the rest of the
  // fixture (placeholder dims, zero size) is implementation detail
  // the grid happens to tolerate today.

  test("project pivots on createdAt for stable day bucketing", () => {
    // Reference "now" pinned to 2026-05-27 14:00 local. A project
    // created at 2026-05-26 23:30 should land in the "Yesterday"
    // bucket even if it was edited today.
    const now = new Date(2026, 4, 27, 14, 0, 0);
    const yesterdayLate = new Date(2026, 4, 26, 23, 30, 0).toISOString();
    const today = new Date(2026, 4, 27, 12, 0, 0).toISOString();
    const project = makeProject({
      createdAt: yesterdayLate,
      modifiedAt: today
    });
    const fixture = projectToFixture(project, 1, now);
    expect(fixture.day).toBe("Yesterday");
  });

  test("emits kind=project and synthetic app key", () => {
    const now = new Date(2026, 4, 27, 14, 0, 0);
    const fixture = projectToFixture(makeProject(), 7, now);
    expect(fixture.kind).toBe("project");
    expect(fixture.app).toBe(PROJECT_APP_KEY);
    // appName lights up the chip label; project cells show "Sizzle Reel"
    // (the noun for the cell badge) rather than the project name (which
    // is rendered as the title text under the cell).
    expect(fixture.appName).toBe("Sizzle Reel");
    expect(fixture.bundleId).toBeNull();
  });

  test("threads projectId through for click handlers", () => {
    const now = new Date(2026, 4, 27, 14, 0, 0);
    const fixture = projectToFixture(makeProject({ id: "proj-xyz" }), 1, now);
    expect(fixture.projectId).toBe("proj-xyz");
  });

  test("propagates project name as the cell title", () => {
    const now = new Date(2026, 4, 27, 14, 0, 0);
    const project = makeProject({ name: "Launch teaser v2" });
    const fixture = projectToFixture(project, 1, now);
    expect(fixture.n).toBe("Launch teaser v2");
  });
});

describe("FixtureBackedRecords — mixed records + projects", () => {
  // The adapter assigns sequential numeric ids (the `Capture.id`
  // field) across BOTH records and projects so the grid's selection
  // model — which keys off the numeric id — never collides. The
  // back-lookups (`recordFor` / `projectFor`) then dispatch on which
  // source-side bucket the sequence id was assigned to.

  test("sequence ids are unique and dense across record + project lists", () => {
    const recs = [
      makeRecord({ id: "rec-a" }),
      makeRecord({ id: "rec-b" }),
      makeRecord({ id: "rec-c" })
    ];
    const projs = [
      makeProject({ id: "proj-x" }),
      makeProject({ id: "proj-y" })
    ];
    const backed = new FixtureBackedRecords(recs, projs);
    const seqs = backed.fixtures().map((f) => f.id);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
  });

  test("recordFor returns the matching CaptureRecord for record sequences", () => {
    const rec = makeRecord({ id: "rec-target" });
    const backed = new FixtureBackedRecords([rec]);
    const fixture = backed.fixtures()[0];
    expect(fixture).toBeDefined();
    if (fixture === undefined) return; // narrow for TS
    expect(backed.recordFor(fixture.id)?.id).toBe("rec-target");
  });

  test("recordFor returns null for project sequences", () => {
    // A sequence id assigned to a project must NOT resolve as a
    // record — callers branch on this so the "open capture" code
    // path never tries to invoke library:byId for a project id.
    const backed = new FixtureBackedRecords(
      [makeRecord({ id: "rec-a" })],
      [makeProject({ id: "proj-only" })]
    );
    const projectFixture = backed.fixtures().find((f) => f.kind === "project");
    expect(projectFixture).toBeDefined();
    if (projectFixture === undefined) return; // narrow for TS
    expect(backed.recordFor(projectFixture.id)).toBeNull();
  });

  test("recordById returns records independently of fixture sequence ids", () => {
    const backed = new FixtureBackedRecords([
      makeRecord({ id: "rec-a" }),
      makeRecord({ id: "rec-cover", kind: "video" })
    ]);
    expect(backed.recordById("rec-cover")?.kind).toBe("video");
    expect(backed.recordById("missing")).toBeNull();
  });

  test("projectFor returns the matching SizzleProject for project sequences", () => {
    const backed = new FixtureBackedRecords(
      [makeRecord({ id: "rec-a" })],
      [makeProject({ id: "proj-target" })]
    );
    const projectFixture = backed.fixtures().find((f) => f.kind === "project");
    expect(projectFixture).toBeDefined();
    if (projectFixture === undefined) return; // narrow for TS
    expect(backed.projectFor(projectFixture.id)?.id).toBe("proj-target");
  });

  test("projectFor returns null for record sequences", () => {
    const backed = new FixtureBackedRecords(
      [makeRecord({ id: "rec-a" })],
      [makeProject({ id: "proj-x" })]
    );
    const recordFixture = backed.fixtures().find((f) => f.kind === "image");
    expect(recordFixture).toBeDefined();
    if (recordFixture === undefined) return; // narrow for TS
    expect(backed.projectFor(recordFixture.id)).toBeNull();
  });

  test("empty projects list keeps record-only behavior intact", () => {
    // Construction with the default projects argument (the back-compat
    // overload) must still work — older call sites that haven't been
    // updated to pass projects shouldn't break.
    const backed = new FixtureBackedRecords([makeRecord({ id: "rec-a" })]);
    expect(backed.fixtures()).toHaveLength(1);
    expect(backed.fixtures()[0]?.kind).toBe("image");
  });

  test("records are emitted before projects (preserves grid ordering)", () => {
    // The grid's day-grouping then sorts cells by modifiedAt/captured
    // anyway, so ordering at the fixture level isn't a hard contract —
    // BUT this test pins the current behavior so a future refactor
    // doesn't silently change which side wins the lower sequence ids.
    // If that changes, update the test and audit the grid's tie-break
    // logic at the same time.
    const backed = new FixtureBackedRecords(
      [makeRecord({ id: "rec-a" })],
      [makeProject({ id: "proj-x" })]
    );
    const fixtures = backed.fixtures();
    expect(fixtures[0]?.kind).toBe("image");
    expect(fixtures[1]?.kind).toBe("project");
  });
});

describe("recordToFixture — date/time label parity", () => {
  // The adapter formats day-bucket + time labels with cached
  // module-level Intl.DateTimeFormat instances (per-record
  // `toLocaleString(undefined, opts)` calls construct a fresh
  // formatter each time — the Library-grid page-append hot spot).
  // These tests pin the output against the equivalent one-shot
  // `toLocaleString` / `toLocaleTimeString` calls so the cached
  // formatters can never drift from what the old per-record calls
  // produced, whatever the runtime locale is.
  const monthShort = (d: Date): string =>
    d.toLocaleString(undefined, { month: "short" });
  const weekdayShort = (d: Date): string =>
    d.toLocaleString(undefined, { weekday: "short" });
  const timeShort = (d: Date): string =>
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  // Pinned "now": 2026-05-27 14:00 local.
  const now = new Date(2026, 4, 27, 14, 0, 0);

  test("same day → day=Today, date carries the absolute date", () => {
    const captured = new Date(2026, 4, 27, 9, 5, 0);
    const fixture = recordToFixture(
      makeRecord({ captured_at: captured.toISOString() }),
      1,
      now
    );
    expect(fixture.day).toBe("Today");
    expect(fixture.date).toBe(`${monthShort(captured)} 27`);
    expect(fixture.time).toBe(timeShort(captured));
  });

  test("day before → day=Yesterday, date carries the absolute date", () => {
    const captured = new Date(2026, 4, 26, 23, 30, 0);
    const fixture = recordToFixture(
      makeRecord({ captured_at: captured.toISOString() }),
      1,
      now
    );
    expect(fixture.day).toBe("Yesterday");
    expect(fixture.date).toBe(`${monthShort(captured)} 26`);
  });

  test("yesterday across a year boundary keeps the year in the date", () => {
    // now = Jan 1: yesterday is Dec 31 of the PREVIOUS year, so the
    // absolute date must disambiguate with the year.
    const janFirst = new Date(2026, 0, 1, 10, 0, 0);
    const captured = new Date(2025, 11, 31, 18, 45, 0);
    const fixture = recordToFixture(
      makeRecord({ captured_at: captured.toISOString() }),
      1,
      janFirst
    );
    expect(fixture.day).toBe("Yesterday");
    expect(fixture.date).toBe(`${monthShort(captured)} 31, 2025`);
  });

  test("same year, older → weekday-prefixed day label, empty date", () => {
    const captured = new Date(2026, 4, 4, 11, 0, 0);
    const fixture = recordToFixture(
      makeRecord({ captured_at: captured.toISOString() }),
      1,
      now
    );
    expect(fixture.day).toBe(
      `${weekdayShort(captured)}, ${monthShort(captured)} 4`
    );
    expect(fixture.date).toBe("");
  });

  test("different year → day label includes the year, empty date", () => {
    const captured = new Date(2025, 11, 15, 11, 0, 0);
    const fixture = recordToFixture(
      makeRecord({ captured_at: captured.toISOString() }),
      1,
      now
    );
    expect(fixture.day).toBe(
      `${weekdayShort(captured)}, ${monthShort(captured)} 15, 2025`
    );
    expect(fixture.date).toBe("");
  });

  test("time label matches toLocaleTimeString incl. 2-digit minute padding", () => {
    // 9:05 exercises the minute:"2-digit" padding.
    const captured = new Date(2026, 4, 27, 9, 5, 0);
    const fixture = recordToFixture(
      makeRecord({ captured_at: captured.toISOString() }),
      1,
      now
    );
    expect(fixture.time).toBe(timeShort(captured));
  });

  test("name suffix and time field agree (single timeLabel per record)", () => {
    const captured = new Date(2026, 4, 27, 16, 20, 0);
    const named = recordToFixture(
      makeRecord({
        captured_at: captured.toISOString(),
        source_app_name: "Safari"
      }),
      1,
      now
    );
    expect(named.n).toBe(`Safari · ${named.time}`);
    const unnamed = recordToFixture(
      makeRecord({ captured_at: captured.toISOString() }),
      1,
      now
    );
    expect(unnamed.n).toBe(`Snap · ${unnamed.time}`);
  });

  test("projectToFixture time label uses the same formatter", () => {
    const created = new Date(2026, 4, 26, 8, 7, 0);
    const fixture = projectToFixture(
      makeProject({ createdAt: created.toISOString() }),
      1,
      now
    );
    expect(fixture.time).toBe(timeShort(created));
  });
});

describe("isSameLocalDay", () => {
  test("same calendar day, different times → true", () => {
    expect(
      isSameLocalDay(new Date(2026, 4, 27, 0, 0, 1), new Date(2026, 4, 27, 23, 59, 59))
    ).toBe(true);
  });

  test("adjacent days across midnight → false", () => {
    expect(
      isSameLocalDay(new Date(2026, 4, 26, 23, 59, 59), new Date(2026, 4, 27, 0, 0, 1))
    ).toBe(false);
  });

  test("same month+day in different years → false", () => {
    expect(
      isSameLocalDay(new Date(2025, 4, 27, 12, 0, 0), new Date(2026, 4, 27, 12, 0, 0))
    ).toBe(false);
  });
});

describe("recordToFixture — kind threading", () => {
  // The grid's Types filter dispatches on Capture.kind. The adapter
  // must thread the underlying CaptureRecord.kind through directly —
  // no mapping, no defaulting — so a video record never appears as an
  // image cell (and vice versa).
  test("image record → kind=image", () => {
    const now = new Date(2026, 4, 27, 14, 0, 0);
    const fixture = recordToFixture(makeRecord({ kind: "image" }), 1, now);
    expect(fixture.kind).toBe("image");
  });

  test("video record → kind=video", () => {
    const now = new Date(2026, 4, 27, 14, 0, 0);
    const fixture = recordToFixture(makeRecord({ kind: "video" }), 1, now);
    expect(fixture.kind).toBe("video");
  });
});

describe("recordToFixture — has_alpha threading", () => {
  // The grid checker (`.psl__cell-thumb--alpha`) gates on Capture.hasAlpha.
  // The adapter must thread CaptureRecord.has_alpha straight through so a
  // transparent capture is flagged in the grid and an opaque one isn't.
  const now = new Date(2026, 4, 27, 14, 0, 0);

  test("transparent record → hasAlpha=true", () => {
    expect(recordToFixture(makeRecord({ has_alpha: true }), 1, now).hasAlpha).toBe(true);
  });

  test("opaque record → hasAlpha=false", () => {
    expect(recordToFixture(makeRecord({ has_alpha: false }), 1, now).hasAlpha).toBe(false);
  });
});
