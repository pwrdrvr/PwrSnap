// Library sidebar filter model — SCOPE + composable FACETS.
//
// The sidebar used to encode "All / Today / Trash / <source app>" as a
// single union, which made Today and a source app *mutually exclusive
// alternatives* instead of composable facets — you could not ask for
// "Activity Monitor, today". Types lived in a separate `useState` that
// history/back never restored, and all three types could be switched
// off leaving a silently empty grid.
//
// The model here splits those into three orthogonal axes:
//
//   scope      — radio, always exactly one of all | today | trash.
//                The LIBRARY section. Owns the "selected row" fill.
//   types      — selected-set over { images, videos, projects }, with an
//                explicit include/exclude mode. A plain click starts an
//                include selection ("only this"); ⌥-click is the explicit
//                negative form. The selected set is never empty.
//   sourceApps — { mode: include | exclude, appIds }. Empty appIds
//                means "no app facet at all" — the mode is then
//                meaningless and normalized to "include".
//
// Everything composes with AND: `Today ∧ (Videos) ∧ ¬Electron` is a
// legal, expressible state. The composed filter is rendered as a chip
// row above the grid (`describeFilterChips`) so a multi-facet /
// negative filter is never invisible.
//
// The reducer is pure (no React, no DOM) and IDENTITY-STABLE: an
// action that doesn't change anything returns the same object, so
// React bails out of the re-render and the memo chain downstream of
// `activeFilter` doesn't churn. Tests: __tests__/library-filters.test.ts.
//
// Design source: docs/brainstorms/2026-08-15-library-video-sizzle-design-critique.md §1.

import type { LibraryCountsRequest } from "@pwrsnap/shared";

/** LIBRARY section — radio scope. Exactly one is active at all times. */
export type LibraryScope = "all" | "today" | "trash";

export type LibraryTypeKey = "images" | "videos" | "projects";

export type LibraryTypeSet = {
  readonly images: boolean;
  readonly videos: boolean;
  readonly projects: boolean;
};

/** How to interpret `types`: normal selections include their true entries;
 *  an explicit ⌥-click excludes their false entries. Keeping this separate
 *  prevents a two-item OR selection from masquerading as "not the third". */
export type LibraryTypeFacetMode = "include" | "exclude";

export type SourceAppFacetMode = "include" | "exclude";

/** Source-app facet. `appIds` empty ⇒ no facet; `mode` is then
 *  normalized to "include" so two "no facet" states compare equal. */
export type SourceAppFacet = {
  readonly mode: SourceAppFacetMode;
  readonly appIds: readonly string[];
};

export type LibraryFilterState = {
  readonly scope: LibraryScope;
  readonly types: LibraryTypeSet;
  readonly typeMode: LibraryTypeFacetMode;
  readonly sourceApps: SourceAppFacet;
};

export const ALL_TYPES_ON: LibraryTypeSet = {
  images: true,
  videos: true,
  projects: true
};

export const NO_APP_FACET: SourceAppFacet = { mode: "include", appIds: [] };

export const initialLibraryFilter: LibraryFilterState = {
  scope: "all",
  types: ALL_TYPES_ON,
  typeMode: "include",
  sourceApps: NO_APP_FACET
};

export const TYPE_KEYS: readonly LibraryTypeKey[] = ["images", "videos", "projects"];

export const TYPE_LABELS: Readonly<Record<LibraryTypeKey, string>> = {
  images: "Images",
  videos: "Videos",
  projects: "Projects"
};

/** Which modifier the user held on a facet row.
 *  - `none` — plain click.
 *  - `meta` — ⌘ (Cmd) / Ctrl: add-or-remove from a multi-selection.
 *  - `alt`  — ⌥ (Option): exclude.
 *  Shift is deliberately NOT a modifier here: the old undiscoverable
 *  shift-click="only" is replaced by the hover `only` pill. */
export type FacetModifier = "none" | "meta" | "alt";

export type LibraryFilterAction =
  /** LIBRARY row click. Pure radio — no toggle-off (there is no
   *  "no scope" state; `all` IS the neutral scope). */
  | { readonly type: "SET_SCOPE"; readonly scope: LibraryScope }
  /** TYPES row click. Plain clicks form an OR selection: from neutral,
   *  select only this type; thereafter add/remove. ⌥-click explicitly
   *  excludes a type. `meta` follows the same add/remove behavior. */
  | { readonly type: "TYPE_ROW_CLICK"; readonly key: LibraryTypeKey; readonly modifier: FacetModifier }
  /** The hover `only` pill on a TYPES row. */
  | { readonly type: "TYPE_ONLY"; readonly key: LibraryTypeKey }
  /** Force a type back on without disturbing the others. Used when an
   *  external "open this capture" intent lands on a capture whose type
   *  is currently filtered out. */
  | { readonly type: "TYPE_ENSURE_ON"; readonly key: LibraryTypeKey }
  /** SOURCE APP row click. See `applyAppRowClick` for the full table. */
  | { readonly type: "APP_ROW_CLICK"; readonly appId: string; readonly modifier: FacetModifier }
  /** The hover `only` pill on a SOURCE APP row — collapses whatever
   *  selection exists down to this single app in include mode. */
  | { readonly type: "APP_ONLY"; readonly appId: string }
  /** Chip × on an app chip. */
  | { readonly type: "REMOVE_APP"; readonly appId: string }
  /** Chip × on the scope chip — back to `all`. */
  | { readonly type: "CLEAR_SCOPE" }
  /** Chip × on a type chip — all types back on. */
  | { readonly type: "CLEAR_TYPES" }
  /** Drop the whole app facet. */
  | { readonly type: "CLEAR_APPS" }
  /** "Clear" at the end of the chip row. */
  | { readonly type: "CLEAR_ALL" }
  /** Hard reset to the default filter (external navigation intents). */
  | { readonly type: "RESET" };

function sortedUnique(appIds: readonly string[]): readonly string[] {
  return Array.from(new Set(appIds)).sort();
}

function sameAppIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Build a facet, normalizing the empty case to `NO_APP_FACET` so
 *  "excluded nothing" and "included nothing" are the same state. */
function makeFacet(mode: SourceAppFacetMode, appIds: readonly string[]): SourceAppFacet {
  const ids = sortedUnique(appIds);
  if (ids.length === 0) return NO_APP_FACET;
  return { mode, appIds: ids };
}

function sameFacet(a: SourceAppFacet, b: SourceAppFacet): boolean {
  return a.mode === b.mode && sameAppIds(a.appIds, b.appIds);
}

function sameTypes(a: LibraryTypeSet, b: LibraryTypeSet): boolean {
  return a.images === b.images && a.videos === b.videos && a.projects === b.projects;
}

export function sameLibraryFilter(a: LibraryFilterState, b: LibraryFilterState): boolean {
  return (
    a.scope === b.scope &&
    a.typeMode === b.typeMode &&
    sameTypes(a.types, b.types) &&
    sameFacet(a.sourceApps, b.sourceApps)
  );
}

function typesOnCount(types: LibraryTypeSet): number {
  return (types.images ? 1 : 0) + (types.videos ? 1 : 0) + (types.projects ? 1 : 0);
}

/** All types on except `key`. This is the canonical "exclude one type"
 *  shape — for a 3-element set, "not Videos" ≡ "Images + Projects", so
 *  negation is derivable and we render it as the negative form only
 *  when EXACTLY one type is off. */
function excludeOnlyType(key: LibraryTypeKey): LibraryTypeSet {
  return {
    images: key !== "images",
    videos: key !== "videos",
    projects: key !== "projects"
  };
}

function onlyType(key: LibraryTypeKey): LibraryTypeSet {
  return {
    images: key === "images",
    videos: key === "videos",
    projects: key === "projects"
  };
}

/**
 * TYPES row click.
 *
 * A plain click starts an include selection. Thus, neutral + Images means
 * "Images", not "everything except Images". Further plain (or ⌘) clicks
 * add/remove values from that OR set. Removing the sole selected type clears
 * the type facet back to neutral instead of creating an empty result set.
 *
 * ⌥-click excludes; ⌥-clicking an already-excluded row restores all
 * three (the gesture is its own undo).
 */
function applyTypeRowClick(
  types: LibraryTypeSet,
  typeMode: LibraryTypeFacetMode,
  key: LibraryTypeKey,
  modifier: FacetModifier
): Pick<LibraryFilterState, "types" | "typeMode"> {
  if (modifier === "alt") {
    const excluded = excludeOnlyType(key);
    return sameTypes(types, excluded) && typeMode === "exclude"
      ? { types: ALL_TYPES_ON, typeMode: "include" }
      : { types: excluded, typeMode: "exclude" };
  }
  // A plain click after an explicit negative selection starts a normal
  // positive selection. It should never silently preserve "not X".
  if (typeMode === "exclude" || sameTypes(types, ALL_TYPES_ON)) {
    return { types: onlyType(key), typeMode: "include" };
  }
  if (!types[key]) return { types: { ...types, [key]: true }, typeMode: "include" };
  if (typesOnCount(types) === 1) return { types: ALL_TYPES_ON, typeMode: "include" };
  return { types: { ...types, [key]: false }, typeMode: "include" };
}

/**
 * SOURCE APP row click.
 *
 *   plain, active single include  → clear the facet (back to All)
 *   plain, anything else          → include exactly this app ("only")
 *   ⌘,     mode preserved         → add/remove this app; empty ⇒ cleared
 *   ⌥,     already excluding      → add/remove from the exclude set
 *   ⌥,     not excluding          → switch to exclude with just this app
 */
function applyAppRowClick(
  facet: SourceAppFacet,
  appId: string,
  modifier: FacetModifier
): SourceAppFacet {
  const inSet = facet.appIds.includes(appId);
  if (modifier === "alt") {
    if (facet.mode === "exclude") {
      return makeFacet(
        "exclude",
        inSet ? facet.appIds.filter((id) => id !== appId) : [...facet.appIds, appId]
      );
    }
    return makeFacet("exclude", [appId]);
  }
  if (modifier === "meta") {
    return makeFacet(
      facet.mode,
      inSet ? facet.appIds.filter((id) => id !== appId) : [...facet.appIds, appId]
    );
  }
  // Plain click. Clicking the ONE currently-included app is the
  // universal "unselect" expectation (Finder, Lightroom, Photos).
  if (facet.mode === "include" && facet.appIds.length === 1 && inSet) return NO_APP_FACET;
  return makeFacet("include", [appId]);
}

export function libraryFilterReducer(
  state: LibraryFilterState,
  action: LibraryFilterAction
): LibraryFilterState {
  switch (action.type) {
    case "SET_SCOPE":
      if (state.scope === action.scope) return state;
      return { ...state, scope: action.scope };

    case "TYPE_ROW_CLICK": {
      const next = applyTypeRowClick(state.types, state.typeMode, action.key, action.modifier);
      if (sameTypes(state.types, next.types) && state.typeMode === next.typeMode) return state;
      return { ...state, ...next };
    }

    case "TYPE_ONLY": {
      const types = onlyType(action.key);
      if (sameTypes(state.types, types) && state.typeMode === "include") return state;
      return { ...state, types, typeMode: "include" };
    }

    case "TYPE_ENSURE_ON": {
      if (state.types[action.key]) return state;
      const types = { ...state.types, [action.key]: true };
      return {
        ...state,
        types,
        typeMode: state.typeMode === "exclude" && sameTypes(types, ALL_TYPES_ON)
          ? "include"
          : state.typeMode
      };
    }

    case "APP_ROW_CLICK": {
      const sourceApps = applyAppRowClick(state.sourceApps, action.appId, action.modifier);
      if (sameFacet(state.sourceApps, sourceApps)) return state;
      return { ...state, sourceApps };
    }

    case "APP_ONLY": {
      const sourceApps = makeFacet("include", [action.appId]);
      if (sameFacet(state.sourceApps, sourceApps)) return state;
      return { ...state, sourceApps };
    }

    case "REMOVE_APP": {
      if (!state.sourceApps.appIds.includes(action.appId)) return state;
      const sourceApps = makeFacet(
        state.sourceApps.mode,
        state.sourceApps.appIds.filter((id) => id !== action.appId)
      );
      return { ...state, sourceApps };
    }

    case "CLEAR_SCOPE":
      if (state.scope === "all") return state;
      return { ...state, scope: "all" };

    case "CLEAR_TYPES":
      if (sameTypes(state.types, ALL_TYPES_ON) && state.typeMode === "include") return state;
      return { ...state, types: ALL_TYPES_ON, typeMode: "include" };

    case "CLEAR_APPS":
      if (sameFacet(state.sourceApps, NO_APP_FACET)) return state;
      return { ...state, sourceApps: NO_APP_FACET };

    case "CLEAR_ALL":
    case "RESET":
      if (sameLibraryFilter(state, initialLibraryFilter)) return state;
      return initialLibraryFilter;
  }
}

/** True when the filter is the neutral default — scope=All, every type
 *  on, no app facet. The chip row hides in exactly this case. */
export function isDefaultLibraryFilter(state: LibraryFilterState): boolean {
  return sameLibraryFilter(state, initialLibraryFilter);
}

/**
 * Stable string identity for the whole filter. Drives the grid
 * scroll-reset `useLayoutEffect` and the `FILTER_CHANGED` dispatch —
 * both want "did the query change?" without deep-comparing on every
 * render. `appIds` is already sorted by `makeFacet`, so the key is
 * order-independent by construction.
 */
export function libraryFilterKey(state: LibraryFilterState): string {
  const types = TYPE_KEYS.filter((key) => state.types[key]).join("+");
  const apps =
    state.sourceApps.appIds.length === 0
      ? "-"
      : `${state.sourceApps.mode}:${state.sourceApps.appIds.join("|")}`;
  return `${state.scope}/${state.typeMode}:${types}/${apps}`;
}

/** Does a capture from `appId` survive the source-app facet? Projects
 *  (which carry the synthetic `_sizzle_` app key) are handled by the
 *  caller — they have no source-app dimension. */
export function sourceAppMatches(facet: SourceAppFacet, appId: string): boolean {
  if (facet.appIds.length === 0) return true;
  const inSet = facet.appIds.includes(appId);
  return facet.mode === "include" ? inSet : !inSet;
}

/** The shared scope + source-app stage for the grid's fixture rows.
 * Types are applied earlier to CaptureRecords, before project fixtures are
 * mixed in. Keeping this stage independent of a row source means the same
 * sidebar state composes with both timeline pages and FTS search results. */
export function filterFixturesByScopeAndSourceAppFacet<
  T extends { readonly day: string; readonly app: string }
>(items: readonly T[], state: LibraryFilterState): T[] {
  let out = state.scope === "today" ? items.filter((item) => item.day === "Today") : [...items];
  if (state.scope !== "trash" && state.sourceApps.appIds.length > 0) {
    out = out.filter((item) => sourceAppMatches(state.sourceApps, item.app));
  }
  return out;
}

/**
 * Translate a composed sidebar filter into a `library:counts` request,
 * so the topbar can report the size of the match set rather than the
 * size of the loaded keyset window.
 *
 * Three semantics from the grid pipeline are mirrored here, and the
 * count is wrong if any of them drifts:
 *
 *   - **Trash bypasses every facet.** It is a SCOPE, not a narrowing —
 *     the same reason `visible` hands trash the unfiltered fixtures.
 *     A facet-narrowed trash count would disagree with what Empty
 *     Trash actually destroys.
 *   - **Today is a date predicate**, expressed as `capturedAtStart`.
 *     The caller supplies the boundary because it is a *local* day.
 *   - **Both kinds selected = no `kinds` field.** Absent means both;
 *     an empty array means none, and that distinction is load-bearing
 *     (a projects-only filter must count zero captures, not all).
 *
 * Projects are deliberately absent: they live outside the captures
 * table, so the caller adds them from the filtered fixture list.
 */
export function libraryCountsRequestFor(
  state: LibraryFilterState,
  args: {
    /** Bundle ids behind the facet's selected appIds, from app_stats. */
    readonly facetBundleIds: ReadonlyArray<string | null>;
    /** Local midnight as an ISO-8601 UTC instant. */
    readonly todayStartIso: string;
  }
): LibraryCountsRequest {
  if (state.scope === "trash") return { scope: "trash" };

  const kinds: Array<"image" | "video"> = [];
  if (state.types.images) kinds.push("image");
  if (state.types.videos) kinds.push("video");

  return {
    scope: "live",
    // Both on is the neutral case — omit rather than send [image, video].
    ...(kinds.length === 2 ? {} : { kinds }),
    ...(state.scope === "today" ? { capturedAtStart: args.todayStartIso } : {}),
    ...(args.facetBundleIds.length === 0
      ? {}
      : state.sourceApps.mode === "include"
        ? { appBundleIds: args.facetBundleIds }
        : { excludeAppBundleIds: args.facetBundleIds })
  };
}

/** Is this app row part of the current selection (checked or excluded)? */
export function appRowState(
  facet: SourceAppFacet,
  appId: string
): "neutral" | "included" | "excluded" {
  if (!facet.appIds.includes(appId)) return "neutral";
  return facet.mode === "include" ? "included" : "excluded";
}

export type LibraryFilterChipKind = "scope" | "type" | "app" | "search";

/** Clearing the search chip is deliberately NOT a `LibraryFilterAction`.
 *  The FTS query is not a facet of `LibraryFilterState` — it swaps the
 *  record source rather than narrowing it, it has its own debounce +
 *  in-flight state, and the reducer is pure over the sidebar model. So
 *  the chip row's clear handler discriminates on this union instead of
 *  growing a reducer case that would have to lie about owning search. */
export type ChipClearAction = LibraryFilterAction | { readonly type: "CLEAR_SEARCH" };

export type LibraryFilterChip = {
  /** Stable React key + test hook. */
  readonly id: string;
  readonly kind: LibraryFilterChipKind;
  readonly label: string;
  /** Rendered with the `not ` prefix + strike styling. */
  readonly negated: boolean;
  /** What the chip's × dispatches. */
  readonly clear: ChipClearAction;
};

/** A chip that describes a FACET, so its × is always a reducer action.
 *  `describeFilterChips` returns these, which keeps callers that feed
 *  the result straight back into `libraryFilterReducer` type-safe — the
 *  search chip is the only one that carries the non-reducer clear. */
export type LibraryFacetChip = LibraryFilterChip & {
  readonly clear: LibraryFilterAction;
};

const SCOPE_CHIP_LABELS: Readonly<Record<LibraryScope, string>> = {
  all: "All Captures",
  today: "Today",
  trash: "Trash"
};

/**
 * Render the composed filter as chips. This is the source of truth
 * that makes a multi-facet / negative filter legible — without it,
 * "Today + Videos + not Electron" is invisible state.
 *
 * TYPES chips are suppressed in Trash: trash deliberately ignores the
 * type facet (the trash banner says so), and showing a "Videos" chip
 * that isn't being applied would be a lie.
 *
 * `appLabel` resolves an appId to its display name; unknown ids fall
 * back to the id itself so a chip is never blank.
 */
export function describeFilterChips(
  state: LibraryFilterState,
  appLabel: (appId: string) => string
): readonly LibraryFacetChip[] {
  const chips: LibraryFacetChip[] = [];
  if (state.scope !== "all") {
    chips.push({
      id: `scope:${state.scope}`,
      kind: "scope",
      label: SCOPE_CHIP_LABELS[state.scope],
      negated: false,
      clear: { type: "CLEAR_SCOPE" }
    });
  }
  if (state.scope !== "trash") {
    const keys =
      state.typeMode === "exclude"
        ? TYPE_KEYS.filter((key) => !state.types[key])
        : TYPE_KEYS.filter((key) => state.types[key]);
    if (!sameTypes(state.types, ALL_TYPES_ON)) {
      for (const key of keys) {
        chips.push({
          id: `type:${state.typeMode === "exclude" ? "not:" : ""}${key}`,
          kind: "type",
          label: TYPE_LABELS[key],
          negated: state.typeMode === "exclude",
          clear: { type: "CLEAR_TYPES" }
        });
      }
    }
  }
  // Trash suppresses the source-app chips for the same reason it
  // suppresses the type chips: the grid bypasses both facets in trash
  // scope (Library.tsx `visible`), so rendering them would advertise a
  // filter that isn't being applied — dangerous next to Empty Trash,
  // which purges the whole trash set.
  if (state.scope !== "trash") {
    for (const appId of state.sourceApps.appIds) {
      chips.push({
        id: `app:${appId}`,
        kind: "app",
        label: appLabel(appId),
        negated: state.sourceApps.mode === "exclude",
        clear: { type: "REMOVE_APP", appId }
      });
    }
  }
  return chips;
}

/**
 * The active search as a chip, or `null` when there is no query.
 *
 * Search used to be visible ONLY inside the search box in the top-right
 * corner — the opposite end of the window from the grid it is
 * narrowing. A composed filter got a chip row; a search that hid 3600
 * captures got a text field the eye slides past. Same class of
 * invisible state the chip row was built for, so it gets the same
 * treatment: a removable chip in the row, and inclusion in "Clear".
 *
 * The label is the TRIMMED query, so leading/trailing whitespace never
 * renders as a blank-looking chip. `negated` is always false — there is
 * no "not this text" search.
 */
export function describeSearchChip(query: string): LibraryFilterChip | null {
  const trimmed = query.trim();
  if (trimmed.length === 0) return null;
  return {
    id: "search",
    kind: "search",
    label: trimmed,
    negated: false,
    clear: { type: "CLEAR_SEARCH" }
  };
}

/**
 * The whole chip row: search first, then the composed facets.
 *
 * Search leads because it is the coarsest narrowing on screen — it
 * replaces the record source outright, while the facets then narrow
 * whatever it returned (see Library.tsx `universeRecordsRaw`). Reading
 * the row left-to-right therefore reads the query in the order it is
 * applied.
 *
 * Trash suppresses the search chip for the same reason it suppresses
 * the type and app chips: `universeRecordsRaw` reads
 * `isTrashView ? trashRecords : isSearchActive ? …`, so trash wins and
 * the query is bypassed outright. Switching to Trash does NOT clear the
 * query (the input is merely disabled), so without this guard a chip
 * would sit there advertising a narrowing that isn't being applied —
 * next to Empty Trash, which purges every row the grid is listing.
 */
export function describeChipRow(
  state: LibraryFilterState,
  appLabel: (appId: string) => string,
  searchQuery: string
): readonly LibraryFilterChip[] {
  const search = state.scope === "trash" ? null : describeSearchChip(searchQuery);
  const facets = describeFilterChips(state, appLabel);
  return search === null ? facets : [search, ...facets];
}

/** One-line summary of the active filter — the Reel timeline header
 *  ("Timeline · today · not Electron"). Returns "all sources" for the
 *  neutral filter so the header never reads empty. */
export function summarizeLibraryFilter(
  state: LibraryFilterState,
  appLabel: (appId: string) => string
): string {
  const chips = describeFilterChips(state, appLabel);
  if (chips.length === 0) return "all sources";
  return chips
    .map((chip) => (chip.negated ? `not ${chip.label}` : chip.label))
    .join(" · ")
    .toLowerCase();
}
