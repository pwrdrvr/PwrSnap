// Library view-state model. Three discrete view-states share the same
// selection model: Grid (default landing), Focus (single-image edit
// overlay reached from Grid), Reel (always-open stage + filmstrip).
//
// Plan: docs/plans/2026-05-05-001-feat-library-three-state-view-model-plan.md
//
// The discriminated union encodes the illegal-state guard at compile
// time: `kind: "focus"` REQUIRES non-null `selectedRecordId`, so render
// paths that destructure on `view.kind === "focus"` get a `string`
// (not `string | null`) for the recordId — no `!` non-null assertions
// needed, no defensive null guards inside the focus subtree.
//
// The reducer runs OUT of React (pure logic, no DOM). All transition
// rules in the plan's transition table are encoded here. Tests live
// at __tests__/library-view.test.ts.

export type GridReturnAnchor = {
  /** scrollTop of the grid's main pane at the moment the user clicked
   *  a cell. Used by the cell-pulse animation effect to find the cell
   *  that was open when Focus closes. With Grid kept mounted (per the
   *  Phase B/C decision in the plan), `scrollTop` survives the
   *  display:none toggle natively, so this is no longer load-bearing
   *  for scroll restoration — only the `cellId` is. We keep the field
   *  for symmetry and in case future virtualization re-introduces the
   *  manual restore path. */
  readonly scrollTop: number;
  readonly cellId: string;
};

export type LibraryView =
  | { readonly kind: "grid"; readonly selectedRecordId: string | null }
  | {
      readonly kind: "focus";
      readonly selectedRecordId: string;
      readonly returnAnchor: GridReturnAnchor;
    }
  | { readonly kind: "reel"; readonly selectedRecordId: string }
  | {
      /** In-library Sizzle Reel project mode. The grid filters to the
       *  project's scenes (in order). `adding === true` flips the grid
       *  back to the full library with +/✓ overlays so the user can
       *  toggle scene membership inline. Clicking a project in the
       *  sidebar dispatches OPEN_PROJECT; closing returns to grid. */
      readonly kind: "project";
      readonly projectId: string;
      readonly selectedRecordId: string | null;
      readonly adding: boolean;
    };

export type LibraryAction =
  /** User clicked a Grid cell — open Focus on that capture, capturing
   *  the grid scroll position + cell id so the close transition can
   *  pulse the right cell. */
  | { readonly type: "OPEN_FOCUS"; readonly recordId: string; readonly returnAnchor: GridReturnAnchor }
  /** User pressed Esc or clicked × in Focus — return to Grid. The
   *  selectedRecordId is preserved so the cell highlights on return. */
  | { readonly type: "CLOSE_FOCUS" }
  /** User clicked the Grid/Reel segmented control. The fallbackId is
   *  used when transitioning Grid (with no selection) → Reel; we need
   *  a record to open in the always-on stage, so the caller passes
   *  `visible[0]?.id ?? null` as the fallback. If both selection and
   *  fallback are null, the transition stays in Grid (Reel is
   *  meaningless without a record). */
  | { readonly type: "TOGGLE_VIEW"; readonly to: "grid" | "reel"; readonly fallbackId: string | null }
  /** ←/→ in Focus or Reel — caller computed the neighbor in the
   *  filtered visible set and passes the new id. */
  | { readonly type: "NAVIGATE"; readonly recordId: string }
  /** Cell click in Grid that does NOT open Focus. Reserved for future
   *  multi-select / hover-preview features; not dispatched in this
   *  plan but the reducer handles it for completeness. */
  | { readonly type: "SELECT_IN_GRID"; readonly recordId: string }
  /** A filter button was clicked while Focus may be open. If Focus
   *  remains open after the filter applies, Esc should return to the
   *  top of the new filtered grid instead of the pre-filter scroll
   *  offset captured when Focus opened. */
  | { readonly type: "RESET_FOCUS_RETURN_SCROLL" }
  /** App filter changed (left rail). Caller passes the ids of records
   *  that survive the new filter. If the current selection is no
   *  longer in the visible set AND we're in Focus or Reel, the
   *  reducer bails to Grid (filter is a query, query changed, show
   *  the new result set in Grid form). Decision: see the plan's
   *  Resolved Decisions item 2. */
  | {
      readonly type: "FILTER_CHANGED";
      readonly visibleIds: ReadonlyArray<string>;
      readonly resetReturnScroll?: boolean;
    }
  /** Sidebar Sizzle Reels row clicked. Transitions from any view to
   *  `project` mode. The grid query layer swaps to library:listByIds
   *  filtered by the project's scene captures. */
  | { readonly type: "OPEN_PROJECT"; readonly projectId: string }
  /** Project breadcrumb close button — returns to Grid. */
  | { readonly type: "CLOSE_PROJECT" }
  /** Project topbar "Add captures" toggle. Flips `adding` so the
   *  grid query reverts to the full library while +/✓ overlays light
   *  up on each cell. */
  | { readonly type: "TOGGLE_ADDING" };

export const initialLibraryView: LibraryView = {
  kind: "grid",
  selectedRecordId: null
};

export function libraryReducer(state: LibraryView, action: LibraryAction): LibraryView {
  switch (action.type) {
    case "OPEN_FOCUS":
      return {
        kind: "focus",
        selectedRecordId: action.recordId,
        returnAnchor: action.returnAnchor
      };

    case "CLOSE_FOCUS":
      if (state.kind !== "focus") return state;
      return { kind: "grid", selectedRecordId: state.selectedRecordId };

    case "TOGGLE_VIEW": {
      const id = state.selectedRecordId ?? action.fallbackId;
      if (action.to === "grid") {
        return { kind: "grid", selectedRecordId: id };
      }
      // to === "reel"
      if (id === null) {
        // No record to open — staying in grid is the honest answer.
        // Reel without a record makes no sense; the caller's fallback
        // logic should have provided visible[0]?.id, so reaching this
        // branch means visible is empty.
        return { kind: "grid", selectedRecordId: null };
      }
      return { kind: "reel", selectedRecordId: id };
    }

    case "NAVIGATE":
      if (state.kind === "focus") {
        return { ...state, selectedRecordId: action.recordId };
      }
      if (state.kind === "reel") {
        return { ...state, selectedRecordId: action.recordId };
      }
      return state; // grid: ←/→ are no-ops

    case "SELECT_IN_GRID":
      if (state.kind !== "grid") return state;
      return { ...state, selectedRecordId: action.recordId };

    case "RESET_FOCUS_RETURN_SCROLL":
      if (state.kind !== "focus") return state;
      return {
        ...state,
        returnAnchor: {
          ...state.returnAnchor,
          scrollTop: 0
        }
      };

    case "FILTER_CHANGED": {
      // If we're in focus or reel and the current selection survives,
      // no transition. If it doesn't, bail to a clean grid state.
      if (state.kind === "grid") return state;
      // Project mode: filter changes are the project's filter itself
      // (visibleIds = the project's scene captures). Stay in project
      // mode regardless of selection survival.
      if (state.kind === "project") return state;
      const stillVisible =
        state.selectedRecordId !== null &&
        action.visibleIds.includes(state.selectedRecordId);
      if (stillVisible) {
        if (state.kind === "focus" && action.resetReturnScroll === true) {
          return {
            ...state,
            returnAnchor: {
              ...state.returnAnchor,
              scrollTop: 0
            }
          };
        }
        return state;
      }
      return { kind: "grid", selectedRecordId: null };
    }

    case "OPEN_PROJECT":
      return {
        kind: "project",
        projectId: action.projectId,
        selectedRecordId: null,
        adding: false
      };

    case "CLOSE_PROJECT":
      if (state.kind !== "project") return state;
      return { kind: "grid", selectedRecordId: null };

    case "TOGGLE_ADDING":
      if (state.kind !== "project") return state;
      return { ...state, adding: !state.adding };
  }
}
