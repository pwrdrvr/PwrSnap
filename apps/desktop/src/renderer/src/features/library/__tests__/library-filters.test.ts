// library-filters reducer tests. Pure logic, no React and no DOM, so
// every row of the interaction table in library-filters.ts gets a
// one-line assert.
//
// The three things worth protecting here, in order:
//   1. COMPOSITION — scope ∧ types ∧ source apps. The bug this module
//      replaces was that Today and a source app were alternatives in
//      one union, so "Activity Monitor, today" was inexpressible.
//   2. TOGGLE-OFF — clicking the one selected app returns to All. The
//      old `selectFilter` re-set the same filter, so the click did
//      nothing.
//   3. TYPE SELECTION — a first plain click means "only this", and
//      removing the last selection clears the facet rather than leaving
//      a silently blank grid.

import { describe, expect, test } from "vitest";
import {
  ALL_TYPES_ON,
  appRowState,
  describeChipRow,
  describeFilterChips,
  describeSearchChip,
  filterFixturesByScopeAndSourceAppFacet,
  initialLibraryFilter,
  isDefaultLibraryFilter,
  libraryFilterKey,
  libraryFilterReducer,
  NO_APP_FACET,
  sameLibraryFilter,
  sourceAppMatches,
  summarizeLibraryFilter,
  type LibraryFilterAction,
  type LibraryFilterState
} from "../library-filters";

/** Apply a sequence of actions, left to right. */
function run(
  state: LibraryFilterState,
  ...actions: LibraryFilterAction[]
): LibraryFilterState {
  return actions.reduce(libraryFilterReducer, state);
}

const ELECTRON = "com.github.electron";
const ACTIVITY = "com.apple.activitymonitor";
const SAFARI = "com.apple.safari";

const upperLabel = (appId: string): string => appId.split(".").pop() ?? appId;

describe("initial state", () => {
  test("defaults to All + every type on + no app facet", () => {
    expect(initialLibraryFilter).toEqual({
      scope: "all",
      types: { images: true, videos: true, projects: true },
      typeMode: "include",
      sourceApps: { mode: "include", appIds: [] }
    });
    expect(isDefaultLibraryFilter(initialLibraryFilter)).toBe(true);
  });
});

describe("scope (LIBRARY section — radio)", () => {
  test("SET_SCOPE swaps the scope and leaves facets alone", () => {
    const next = run(
      initialLibraryFilter,
      { type: "TYPE_ROW_CLICK", key: "images", modifier: "none" },
      { type: "SET_SCOPE", scope: "today" }
    );
    expect(next.scope).toBe("today");
    expect(next.types).toEqual({ images: true, videos: false, projects: false });
  });

  test("re-selecting the active scope is identity-stable (no re-render)", () => {
    const today = libraryFilterReducer(initialLibraryFilter, {
      type: "SET_SCOPE",
      scope: "today"
    });
    expect(libraryFilterReducer(today, { type: "SET_SCOPE", scope: "today" })).toBe(today);
  });

  test("CLEAR_SCOPE returns to all", () => {
    const next = run(
      initialLibraryFilter,
      { type: "SET_SCOPE", scope: "trash" },
      { type: "CLEAR_SCOPE" }
    );
    expect(next.scope).toBe("all");
  });
});

describe("types (facet, include-set)", () => {
  test("first plain click selects only that type", () => {
    const next = libraryFilterReducer(initialLibraryFilter, {
      type: "TYPE_ROW_CLICK",
      key: "videos",
      modifier: "none"
    });
    expect(next.types).toEqual({ images: false, videos: true, projects: false });
    expect(next.typeMode).toBe("include");
  });

  test("plain click adds a different type to the OR selection", () => {
    const next = run(
      initialLibraryFilter,
      { type: "TYPE_ROW_CLICK", key: "videos", modifier: "none" },
      { type: "TYPE_ROW_CLICK", key: "images", modifier: "none" }
    );
    expect(next.types).toEqual({ images: true, videos: true, projects: false });
  });

  test("removing the LAST selected type clears the facet instead of emptying the grid", () => {
    const onlyImages = libraryFilterReducer(initialLibraryFilter, {
      type: "TYPE_ONLY",
      key: "images"
    });
    expect(onlyImages.types).toEqual({ images: true, videos: false, projects: false });

    const next = libraryFilterReducer(onlyImages, {
      type: "TYPE_ROW_CLICK",
      key: "images",
      modifier: "none"
    });
    expect(next.types).toEqual(ALL_TYPES_ON);
    expect(next.typeMode).toBe("include");
  });

  test("no gesture sequence can switch every type off", () => {
    let state = initialLibraryFilter;
    for (const key of ["images", "videos", "projects", "images", "videos", "projects"] as const) {
      state = libraryFilterReducer(state, {
        type: "TYPE_ROW_CLICK",
        key,
        modifier: "none"
      });
      const onCount =
        (state.types.images ? 1 : 0) +
        (state.types.videos ? 1 : 0) +
        (state.types.projects ? 1 : 0);
      expect(onCount).toBeGreaterThan(0);
    }
  });

  test("⌥-click excludes exactly one type", () => {
    const next = libraryFilterReducer(initialLibraryFilter, {
      type: "TYPE_ROW_CLICK",
      key: "videos",
      modifier: "alt"
    });
    expect(next.types).toEqual({ images: true, videos: false, projects: true });
    expect(next.typeMode).toBe("exclude");
  });

  test("⌥-click on an already-excluded type restores all three", () => {
    const next = run(
      initialLibraryFilter,
      { type: "TYPE_ROW_CLICK", key: "videos", modifier: "alt" },
      { type: "TYPE_ROW_CLICK", key: "videos", modifier: "alt" }
    );
    expect(next.types).toEqual(ALL_TYPES_ON);
    expect(next.typeMode).toBe("include");
  });

  test("TYPE_ONLY collapses to a single type", () => {
    const next = libraryFilterReducer(initialLibraryFilter, {
      type: "TYPE_ONLY",
      key: "videos"
    });
    expect(next.types).toEqual({ images: false, videos: true, projects: false });
  });

  test("TYPE_ENSURE_ON turns one back on without disturbing the others", () => {
    const next = run(
      initialLibraryFilter,
      { type: "TYPE_ONLY", key: "images" },
      { type: "TYPE_ENSURE_ON", key: "videos" }
    );
    expect(next.types).toEqual({ images: true, videos: true, projects: false });
  });

  test("TYPE_ENSURE_ON on an already-visible type is identity-stable", () => {
    expect(
      libraryFilterReducer(initialLibraryFilter, { type: "TYPE_ENSURE_ON", key: "images" })
    ).toBe(initialLibraryFilter);
  });
});

describe("source apps (facet, include/exclude)", () => {
  test("plain click selects only that app", () => {
    const next = libraryFilterReducer(initialLibraryFilter, {
      type: "APP_ROW_CLICK",
      appId: ELECTRON,
      modifier: "none"
    });
    expect(next.sourceApps).toEqual({ mode: "include", appIds: [ELECTRON] });
  });

  test("plain click on the ONE selected app returns to All (the old no-op click)", () => {
    const next = run(
      initialLibraryFilter,
      { type: "APP_ROW_CLICK", appId: ELECTRON, modifier: "none" },
      { type: "APP_ROW_CLICK", appId: ELECTRON, modifier: "none" }
    );
    expect(next.sourceApps).toEqual(NO_APP_FACET);
  });

  test("plain click on a different app replaces the selection", () => {
    const next = run(
      initialLibraryFilter,
      { type: "APP_ROW_CLICK", appId: ELECTRON, modifier: "none" },
      { type: "APP_ROW_CLICK", appId: SAFARI, modifier: "none" }
    );
    expect(next.sourceApps.appIds).toEqual([SAFARI]);
  });

  test("⌘-click builds a multi-selection, sorted for a stable key", () => {
    const next = run(
      initialLibraryFilter,
      { type: "APP_ROW_CLICK", appId: SAFARI, modifier: "none" },
      { type: "APP_ROW_CLICK", appId: ACTIVITY, modifier: "meta" }
    );
    expect(next.sourceApps).toEqual({
      mode: "include",
      appIds: [ACTIVITY, SAFARI].sort()
    });
  });

  test("⌘-click removes from the selection, and emptying it clears the facet", () => {
    const next = run(
      initialLibraryFilter,
      { type: "APP_ROW_CLICK", appId: SAFARI, modifier: "none" },
      { type: "APP_ROW_CLICK", appId: ACTIVITY, modifier: "meta" },
      { type: "APP_ROW_CLICK", appId: ACTIVITY, modifier: "meta" },
      { type: "APP_ROW_CLICK", appId: SAFARI, modifier: "meta" }
    );
    expect(next.sourceApps).toEqual(NO_APP_FACET);
  });

  test("⌥-click switches to exclude mode", () => {
    const next = libraryFilterReducer(initialLibraryFilter, {
      type: "APP_ROW_CLICK",
      appId: ELECTRON,
      modifier: "alt"
    });
    expect(next.sourceApps).toEqual({ mode: "exclude", appIds: [ELECTRON] });
  });

  test("⌥-click discards an existing include selection rather than mixing modes", () => {
    const next = run(
      initialLibraryFilter,
      { type: "APP_ROW_CLICK", appId: SAFARI, modifier: "none" },
      { type: "APP_ROW_CLICK", appId: ELECTRON, modifier: "alt" }
    );
    expect(next.sourceApps).toEqual({ mode: "exclude", appIds: [ELECTRON] });
  });

  test("⌥-click accumulates within exclude mode and un-excludes on repeat", () => {
    const two = run(
      initialLibraryFilter,
      { type: "APP_ROW_CLICK", appId: ELECTRON, modifier: "alt" },
      { type: "APP_ROW_CLICK", appId: SAFARI, modifier: "alt" }
    );
    expect(two.sourceApps.mode).toBe("exclude");
    expect(two.sourceApps.appIds).toEqual([ELECTRON, SAFARI].sort());

    const back = libraryFilterReducer(two, {
      type: "APP_ROW_CLICK",
      appId: SAFARI,
      modifier: "alt"
    });
    expect(back.sourceApps).toEqual({ mode: "exclude", appIds: [ELECTRON] });
  });

  test("APP_ONLY collapses a multi-selection down to one app in include mode", () => {
    const next = run(
      initialLibraryFilter,
      { type: "APP_ROW_CLICK", appId: ELECTRON, modifier: "alt" },
      { type: "APP_ONLY", appId: SAFARI }
    );
    expect(next.sourceApps).toEqual({ mode: "include", appIds: [SAFARI] });
  });

  test("REMOVE_APP drops one app, and the last removal clears the facet", () => {
    const two = run(
      initialLibraryFilter,
      { type: "APP_ROW_CLICK", appId: SAFARI, modifier: "none" },
      { type: "APP_ROW_CLICK", appId: ACTIVITY, modifier: "meta" }
    );
    const one = libraryFilterReducer(two, { type: "REMOVE_APP", appId: SAFARI });
    expect(one.sourceApps.appIds).toEqual([ACTIVITY]);
    const none = libraryFilterReducer(one, { type: "REMOVE_APP", appId: ACTIVITY });
    expect(none.sourceApps).toEqual(NO_APP_FACET);
  });

  test("appRowState reports the glyph each row should draw", () => {
    const included = run(initialLibraryFilter, {
      type: "APP_ROW_CLICK",
      appId: SAFARI,
      modifier: "none"
    });
    expect(appRowState(included.sourceApps, SAFARI)).toBe("included");
    expect(appRowState(included.sourceApps, ELECTRON)).toBe("neutral");

    const excluded = run(initialLibraryFilter, {
      type: "APP_ROW_CLICK",
      appId: ELECTRON,
      modifier: "alt"
    });
    expect(appRowState(excluded.sourceApps, ELECTRON)).toBe("excluded");
    expect(appRowState(excluded.sourceApps, SAFARI)).toBe("neutral");
  });
});

describe("sourceAppMatches", () => {
  test("no facet matches everything", () => {
    expect(sourceAppMatches(NO_APP_FACET, ELECTRON)).toBe(true);
  });

  test("include keeps only listed apps", () => {
    const facet = { mode: "include" as const, appIds: [SAFARI] };
    expect(sourceAppMatches(facet, SAFARI)).toBe(true);
    expect(sourceAppMatches(facet, ELECTRON)).toBe(false);
  });

  test("exclude drops only listed apps", () => {
    const facet = { mode: "exclude" as const, appIds: [ELECTRON] };
    expect(sourceAppMatches(facet, ELECTRON)).toBe(false);
    expect(sourceAppMatches(facet, SAFARI)).toBe(true);
    // Project fixtures carry the synthetic `_sizzle_` app key, so an
    // exclude facet leaves them alone.
    expect(sourceAppMatches(facet, "_sizzle_")).toBe(true);
  });
});

describe("scope + source-app fixture composition", () => {
  const fixtures = [
    { id: "today-electron", day: "Today", app: ELECTRON },
    { id: "today-safari", day: "Today", app: SAFARI },
    { id: "yesterday-electron", day: "Yesterday", app: ELECTRON }
  ] as const;

  test("applies Today and source-app facets to any fixture source, including search", () => {
    const state = run(
      initialLibraryFilter,
      { type: "SET_SCOPE", scope: "today" },
      { type: "APP_ROW_CLICK", appId: ELECTRON, modifier: "alt" }
    );
    expect(filterFixturesByScopeAndSourceAppFacet(fixtures, state).map((fixture) => fixture.id)).toEqual([
      "today-safari"
    ]);
  });
});

describe("composition — the whole point of the split", () => {
  test("Today + one app + one type all survive together", () => {
    const state = run(
      initialLibraryFilter,
      { type: "SET_SCOPE", scope: "today" },
      { type: "APP_ROW_CLICK", appId: ACTIVITY, modifier: "none" },
      { type: "TYPE_ONLY", key: "videos" }
    );
    expect(state).toEqual({
      scope: "today",
      types: { images: false, videos: true, projects: false },
      typeMode: "include",
      sourceApps: { mode: "include", appIds: [ACTIVITY] }
    });
  });

  test("Today + not-Electron + not-Videos composes", () => {
    const state = run(
      initialLibraryFilter,
      { type: "SET_SCOPE", scope: "today" },
      { type: "APP_ROW_CLICK", appId: ELECTRON, modifier: "alt" },
      { type: "TYPE_ROW_CLICK", key: "videos", modifier: "alt" }
    );
    expect(state.scope).toBe("today");
    expect(state.sourceApps).toEqual({ mode: "exclude", appIds: [ELECTRON] });
    expect(state.types.videos).toBe(false);
    expect(state.types.images).toBe(true);
    expect(state.typeMode).toBe("exclude");
  });

  test("changing the app facet does not disturb scope or types", () => {
    const base = run(
      initialLibraryFilter,
      { type: "SET_SCOPE", scope: "today" },
      { type: "TYPE_ONLY", key: "images" }
    );
    const next = libraryFilterReducer(base, {
      type: "APP_ROW_CLICK",
      appId: SAFARI,
      modifier: "none"
    });
    expect(next.scope).toBe("today");
    expect(next.types).toEqual(base.types);
  });

  test("CLEAR_ALL resets every axis at once", () => {
    const messy = run(
      initialLibraryFilter,
      { type: "SET_SCOPE", scope: "today" },
      { type: "APP_ROW_CLICK", appId: ELECTRON, modifier: "alt" },
      { type: "TYPE_ONLY", key: "videos" }
    );
    expect(libraryFilterReducer(messy, { type: "CLEAR_ALL" })).toEqual(initialLibraryFilter);
  });

  test("CLEAR_ALL on the default filter is identity-stable", () => {
    expect(libraryFilterReducer(initialLibraryFilter, { type: "CLEAR_ALL" })).toBe(
      initialLibraryFilter
    );
  });
});

describe("libraryFilterKey", () => {
  test("changes when any axis changes", () => {
    const base = libraryFilterKey(initialLibraryFilter);
    expect(
      libraryFilterKey(libraryFilterReducer(initialLibraryFilter, { type: "SET_SCOPE", scope: "today" }))
    ).not.toBe(base);
    expect(
      libraryFilterKey(
        libraryFilterReducer(initialLibraryFilter, { type: "TYPE_ONLY", key: "videos" })
      )
    ).not.toBe(base);
    expect(
      libraryFilterKey(
        libraryFilterReducer(initialLibraryFilter, {
          type: "APP_ROW_CLICK",
          appId: SAFARI,
          modifier: "none"
        })
      )
    ).not.toBe(base);
  });

  test("include and exclude of the same app are different keys", () => {
    const include = libraryFilterReducer(initialLibraryFilter, {
      type: "APP_ROW_CLICK",
      appId: SAFARI,
      modifier: "none"
    });
    const exclude = libraryFilterReducer(initialLibraryFilter, {
      type: "APP_ROW_CLICK",
      appId: SAFARI,
      modifier: "alt"
    });
    expect(libraryFilterKey(include)).not.toBe(libraryFilterKey(exclude));
  });

  test("include and exclude interpretations of the same type bits are different keys", () => {
    const include = run(
      initialLibraryFilter,
      { type: "TYPE_ROW_CLICK", key: "images", modifier: "none" },
      { type: "TYPE_ROW_CLICK", key: "videos", modifier: "none" }
    );
    const exclude = libraryFilterReducer(initialLibraryFilter, {
      type: "TYPE_ROW_CLICK",
      key: "projects",
      modifier: "alt"
    });
    expect(include.types).toEqual(exclude.types);
    expect(libraryFilterKey(include)).not.toBe(libraryFilterKey(exclude));
  });

  test("selection order does not change the key", () => {
    const a = run(
      initialLibraryFilter,
      { type: "APP_ROW_CLICK", appId: SAFARI, modifier: "none" },
      { type: "APP_ROW_CLICK", appId: ACTIVITY, modifier: "meta" }
    );
    const b = run(
      initialLibraryFilter,
      { type: "APP_ROW_CLICK", appId: ACTIVITY, modifier: "none" },
      { type: "APP_ROW_CLICK", appId: SAFARI, modifier: "meta" }
    );
    expect(libraryFilterKey(a)).toBe(libraryFilterKey(b));
    expect(sameLibraryFilter(a, b)).toBe(true);
  });
});

describe("chips", () => {
  test("the default filter renders no chips (row hides entirely)", () => {
    expect(describeFilterChips(initialLibraryFilter, upperLabel)).toEqual([]);
  });

  test("Today + Videos + not Electron reads as three chips", () => {
    const state = run(
      initialLibraryFilter,
      { type: "SET_SCOPE", scope: "today" },
      { type: "TYPE_ONLY", key: "videos" },
      { type: "APP_ROW_CLICK", appId: ELECTRON, modifier: "alt" }
    );
    const chips = describeFilterChips(state, upperLabel);
    expect(chips.map((c) => ({ label: c.label, negated: c.negated }))).toEqual([
      { label: "Today", negated: false },
      { label: "Videos", negated: false },
      { label: "electron", negated: true }
    ]);
  });

  test("exactly one type off renders as a single negated chip", () => {
    const state = libraryFilterReducer(initialLibraryFilter, {
      type: "TYPE_ROW_CLICK",
      key: "videos",
      modifier: "alt"
    });
    const chips = describeFilterChips(state, upperLabel);
    expect(chips).toHaveLength(1);
    expect(chips[0]?.negated).toBe(true);
    expect(chips[0]?.label).toBe("Videos");
  });

  test("Trash suppresses type chips — trash ignores the type facet", () => {
    const state = run(
      initialLibraryFilter,
      { type: "SET_SCOPE", scope: "trash" },
      { type: "TYPE_ONLY", key: "videos" }
    );
    const chips = describeFilterChips(state, upperLabel);
    expect(chips.map((c) => c.kind)).toEqual(["scope"]);
  });

  test("Trash suppresses source-app chips — trash ignores the app facet", () => {
    // The grid bypasses the app facet in trash scope (Library.tsx
    // `visible`), and Empty Trash purges the WHOLE trash set — a chip
    // claiming "not Electron" while the button destroys Electron rows
    // too is the exact mismatch this guards.
    const state = run(
      initialLibraryFilter,
      { type: "SET_SCOPE", scope: "trash" },
      { type: "APP_ROW_CLICK", appId: ELECTRON, modifier: "alt" }
    );
    expect(state.sourceApps).toEqual({ mode: "exclude", appIds: [ELECTRON] });
    const chips = describeFilterChips(state, upperLabel);
    expect(chips.map((c) => c.kind)).toEqual(["scope"]);
  });

  test("each chip's × action removes exactly that facet", () => {
    const state = run(
      initialLibraryFilter,
      { type: "SET_SCOPE", scope: "today" },
      { type: "APP_ROW_CLICK", appId: SAFARI, modifier: "none" },
      { type: "APP_ROW_CLICK", appId: ACTIVITY, modifier: "meta" }
    );
    const chips = describeFilterChips(state, upperLabel);
    const safariChip = chips.find((c) => c.label === "safari");
    expect(safariChip).toBeDefined();
    const after = libraryFilterReducer(state, safariChip!.clear);
    expect(after.scope).toBe("today");
    expect(after.sourceApps.appIds).toEqual([ACTIVITY]);
  });

  test("an active search renders a removable chip, ahead of the facets", () => {
    const state = libraryFilterReducer(initialLibraryFilter, {
      type: "TYPE_ONLY",
      key: "images"
    });
    const chips = describeChipRow(state, upperLabel, "  star map  ");
    expect(chips.map((c) => ({ kind: c.kind, label: c.label }))).toEqual([
      // Search leads: it swaps the record source, the facets then
      // narrow whatever it returned.
      { kind: "search", label: "star map" },
      { kind: "type", label: "Images" }
    ]);
    expect(chips[0]?.clear).toEqual({ type: "CLEAR_SEARCH" });
  });

  test("a whitespace-only query is not a search — no chip", () => {
    expect(describeSearchChip("   ")).toBeNull();
    expect(describeSearchChip("")).toBeNull();
    expect(describeChipRow(initialLibraryFilter, upperLabel, "  ")).toEqual([]);
  });

  test("search alone still renders the row (the facets are all default)", () => {
    const chips = describeChipRow(initialLibraryFilter, upperLabel, "star map");
    expect(chips.map((c) => c.kind)).toEqual(["search"]);
  });

  test("Trash suppresses the search chip — trash bypasses the query", () => {
    // Switching to Trash does not clear the search box (it only
    // disables it), and `universeRecordsRaw` puts trash ahead of
    // search — so a chip here would advertise a narrowing the grid
    // ignored, right next to Empty Trash.
    const state = libraryFilterReducer(initialLibraryFilter, {
      type: "SET_SCOPE",
      scope: "trash"
    });
    const chips = describeChipRow(state, upperLabel, "star map");
    expect(chips.map((c) => c.kind)).toEqual(["scope"]);
  });

  test("summarizeLibraryFilter reads the composed query in one line", () => {
    const state = run(
      initialLibraryFilter,
      { type: "SET_SCOPE", scope: "today" },
      { type: "APP_ROW_CLICK", appId: ELECTRON, modifier: "alt" }
    );
    expect(summarizeLibraryFilter(state, upperLabel)).toBe("today · not electron");
    expect(summarizeLibraryFilter(initialLibraryFilter, upperLabel)).toBe("all sources");
  });
});
