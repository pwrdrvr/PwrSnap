// Tests for the bundle-id → AppId mapping. The mapper is pure logic
// keyed off a small table of anchored regex patterns; each branch
// gets one realistic bundle id so a future edit that breaks a row
// (regression on case sensitivity, anchor drift, accidental false
// positive) fails loudly.

import { describe, expect, test } from "vitest";
import type { CaptureRecord, SizzleProject } from "@pwrsnap/shared";
import {
  FixtureBackedRecords,
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

describe("mapBundleIdToAppId — curated apps (case-insensitive)", () => {
  // Real macOS bundle ids use CamelCase tail components; the matcher
  // must lowercase before testing. Each row is the EXACT id macOS
  // returns from CFBundleIdentifier.
  test.each<[string, string]>([
    ["com.tinyspeck.slackmacgap", "slack"],
    ["com.apple.Terminal", "terminal"],
    ["com.microsoft.VSCode", "vscode"],
    ["com.microsoft.VSCodeInsiders", "vscode"],
    ["com.apple.finder", "finder"],
    ["com.google.Chrome", "chrome"],
    ["com.apple.Safari", "safari"],
    ["com.figma.Desktop", "figma"],
    ["notion.id", "notion"],
    ["com.github.GitHubClient", "github"],
    ["com.linear.LinearMac", "linear"],
    ["us.zoom.xos", "zoom"],
    ["com.apple.Preview", "preview"],
    ["com.microsoft.Excel", "excel"],
    ["ru.keepcoder.Telegram", "telegram"],
    ["com.mitchellh.ghostty", "terminal"]
  ])("%s → %s", (bundleId, expected) => {
    expect(mapBundleIdToAppId(bundleId)).toBe(expected);
  });
});

describe("mapBundleIdToAppId — open fallback for unknown apps", () => {
  // Unknown apps return their LOWERCASED bundle id as a stable
  // group key. The Library sidebar groups by this key, so two
  // captures of the same app must produce the same key regardless
  // of whether macOS returned the bundle id as `com.hnc.Discord`
  // or `com.hnc.discord`.
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
});

describe("mapBundleIdToAppId — anchored matching prevents false positives", () => {
  // The matcher used to do unanchored substring tests
  // (`bundleId.includes("notion")`), so a third-party clone like
  // `com.acme.notion-importer` would steal Notion's hand-drawn
  // glyph. After the regex tightening, generic-name third parties
  // fall through to the open set and get a procedural icon.
  test.each<string>([
    "com.acme.notion-importer",
    "com.someone.fakelinear",
    "com.example.previewer",
    "com.anothercompany.figmaclone"
  ])("%s falls through (no false positive)", (bundleId) => {
    expect(mapBundleIdToAppId(bundleId)).toBe(bundleId.toLowerCase());
  });

  // But legitimate vendor-glued tail words MUST still match — the
  // matcher allows known suffixes (slackmacgap, vscodeinsiders,
  // githubclient, …) for this reason.
  test("Slack still matches despite glued 'macgap' suffix", () => {
    expect(mapBundleIdToAppId("com.tinyspeck.slackmacgap")).toBe("slack");
  });

  test("VS Code Insiders still matches", () => {
    expect(mapBundleIdToAppId("com.microsoft.VSCodeInsiders")).toBe("vscode");
  });

  test("GitHub Client still matches", () => {
    expect(mapBundleIdToAppId("com.github.GitHubClient")).toBe("github");
  });
});

describe("mapBundleIdToAppId — Xcode does not get VS Code's glyph", () => {
  // Regression: when the matcher had a `lower.includes("code")`
  // branch, Xcode (`com.apple.dt.Xcode`) and any other app with
  // "code" in its bundle id would inherit VS Code's glyph. The
  // `vscode`-only needle, anchored, prevents that.
  test("Xcode falls through to its lowercased bundle id", () => {
    expect(mapBundleIdToAppId("com.apple.dt.Xcode")).toBe("com.apple.dt.xcode");
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
