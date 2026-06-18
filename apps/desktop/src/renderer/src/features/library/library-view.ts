// Library view-state model. Three discrete view-states share the same
// selection model: Grid (default landing), Focus (single-image edit
// overlay reached from Grid), Reel (always-open stage + filmstrip).
//
// Read the three `kind`s as TWO axes, not one: Grid and Reel are two
// *layouts* of the same browse shell (left-nav filters + right inspector
// + select-on-click); Focus is the orthogonal *takeover* you drop into
// from either layout and exit back to it. Don't add `cart`/`peek`/etc.
// kinds — those are inspector/overlay state that lives OUTSIDE this union.
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
  | {
      readonly kind: "reel";
      readonly selectedRecordId: string;
      // True when this reel selection was synthesized from the
      // TOGGLE_VIEW `fallbackId` (the user toggled to Reel with nothing
      // selected) rather than chosen by the user. Consumed by
      // TOGGLE_VIEW→grid so a never-chosen selection doesn't "stick" as a
      // grid selection on return. Reset to false the moment the user
      // navigates a frame (NAVIGATE). Focus never needs this flag —
      // OPEN_FOCUS always carries a real, user-chosen recordId.
      readonly selectionSynthesized: boolean;
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
  /** Single-click on a Grid cell — SELECT the capture (update the right
   *  inspector in place) WITHOUT opening Focus. The grid-first select/edit
   *  split dispatches this on plain click; explicit triggers (Edit CTA /
   *  Enter / double-click) dispatch OPEN_FOCUS instead. No-op outside grid;
   *  same-id is a referential no-op (avoids a wasted grid re-render). */
  | { readonly type: "SELECT_IN_GRID"; readonly recordId: string }
  /** A filter button was clicked while Focus may be open. If Focus
   *  remains open after the filter applies, Esc should return to the
   *  top of the new filtered grid instead of the pre-filter scroll
   *  offset captured when Focus opened. */
  | { readonly type: "RESET_FOCUS_RETURN_SCROLL" }
  /** App filter changed (left rail). Caller passes the ids of records
   *  that survive the new filter. In Focus or Reel, if the current
   *  selection is no longer visible the reducer bails to Grid (filter
   *  is a query, query changed, show the new result set in Grid form).
   *  In Grid, if the now-real grid selection left the visible set, it
   *  is cleared to null so the inspector empties instead of showing an
   *  off-screen record. Decision: see the plan's Resolved Decisions
   *  item 2 + grid-first-select-edit plan SpecFlow I1. */
  | {
      readonly type: "FILTER_CHANGED";
      readonly visibleIds: ReadonlyArray<string>;
      readonly resetReturnScroll?: boolean;
    };

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
        // A reel selection synthesized from the fallback (the user never
        // actually picked it) must not become a grid selection on return
        // — null it so the grid opens with nothing selected.
        if (state.kind === "reel" && state.selectionSynthesized) {
          return { kind: "grid", selectedRecordId: null };
        }
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
      return {
        kind: "reel",
        selectedRecordId: id,
        // Synthesized iff we had no real selection and fell back to
        // `fallbackId` to have something to show in the stage.
        selectionSynthesized: state.selectedRecordId === null
      };
    }

    case "NAVIGATE":
      if (state.kind === "focus") {
        return { ...state, selectedRecordId: action.recordId };
      }
      if (state.kind === "reel") {
        // A frame the user navigated to is a real, chosen selection —
        // clear the synthesized provenance so toggling back to Grid keeps it.
        return {
          ...state,
          selectedRecordId: action.recordId,
          selectionSynthesized: false
        };
      }
      return state; // grid: ←/→ are no-ops

    case "SELECT_IN_GRID":
      if (state.kind !== "grid") return state;
      // Same-id select is a referential no-op — don't allocate a new
      // state object (would trigger a needless grid re-render).
      if (state.selectedRecordId === action.recordId) return state;
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
      if (state.kind === "grid") {
        // Grid now carries a real, inspectable selection. If the selected
        // capture left the visible set, clear it so the inspector empties
        // rather than pointing at an off-screen record. Identity-stable:
        // return the same object when nothing changed (render contract).
        if (state.selectedRecordId === null) return state;
        if (action.visibleIds.includes(state.selectedRecordId)) return state;
        return { kind: "grid", selectedRecordId: null };
      }
      // If we're in focus or reel and the current selection survives,
      // no transition. If it doesn't, bail to a clean grid state.
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
  }
}
