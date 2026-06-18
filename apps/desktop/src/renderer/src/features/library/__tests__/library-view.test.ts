// library-view reducer tests. The reducer is pure logic with no React
// or DOM, so every transition in the plan's table can be a one-line
// assert. Test-first per the Phase A execution note in
// docs/plans/2026-05-05-001-feat-library-three-state-view-model-plan.md.
//
// The discriminated union LibraryView has three kinds: grid, focus,
// reel. The illegal-state guard the type system enforces — focus mode
// must have a non-null selectedRecordId — is checked at compile time
// (test it with @ts-expect-error in one test below); the reducer's job
// is to keep the runtime transitions consistent with that contract.

import { describe, expect, test } from "vitest";
import {
  initialLibraryView,
  libraryReducer,
  type GridReturnAnchor,
  type LibraryView
} from "../library-view";

const ANCHOR_A: GridReturnAnchor = { scrollTop: 1200, cellId: "abc" };
const ANCHOR_B: GridReturnAnchor = { scrollTop: 800, cellId: "xyz" };

describe("initial state", () => {
  test("starts in grid mode with no selection", () => {
    expect(initialLibraryView).toEqual({ kind: "grid", selectedRecordId: null });
  });
});

describe("OPEN_FOCUS", () => {
  test("from grid (no selection) captures returnAnchor + cellId", () => {
    const next = libraryReducer(
      { kind: "grid", selectedRecordId: null },
      { type: "OPEN_FOCUS", recordId: "abc", returnAnchor: ANCHOR_A }
    );
    expect(next).toEqual({
      kind: "focus",
      selectedRecordId: "abc",
      returnAnchor: ANCHOR_A
    });
  });

  test("from grid (with prior selection) overrides selection with new recordId", () => {
    const next = libraryReducer(
      { kind: "grid", selectedRecordId: "previously-selected" },
      { type: "OPEN_FOCUS", recordId: "abc", returnAnchor: ANCHOR_A }
    );
    if (next.kind !== "focus") throw new Error("expected focus");
    expect(next.selectedRecordId).toBe("abc");
    expect(next.returnAnchor).toEqual(ANCHOR_A);
  });

  test("from focus replaces with new returnAnchor (defensive — should not happen in practice)", () => {
    // OPEN_FOCUS is dispatched from Grid cell click in the plan;
    // dispatching it from focus is technically valid (e.g., an
    // imperative re-open) and should swap the active record.
    const next = libraryReducer(
      { kind: "focus", selectedRecordId: "abc", returnAnchor: ANCHOR_A },
      { type: "OPEN_FOCUS", recordId: "xyz", returnAnchor: ANCHOR_B }
    );
    expect(next).toEqual({
      kind: "focus",
      selectedRecordId: "xyz",
      returnAnchor: ANCHOR_B
    });
  });
});

describe("CLOSE_FOCUS", () => {
  test("from focus → grid, preserves selectedRecordId for cell highlight", () => {
    const next = libraryReducer(
      { kind: "focus", selectedRecordId: "abc", returnAnchor: ANCHOR_A },
      { type: "CLOSE_FOCUS" }
    );
    expect(next).toEqual({ kind: "grid", selectedRecordId: "abc" });
  });

  test("from grid is a no-op", () => {
    const before: LibraryView = { kind: "grid", selectedRecordId: "abc" };
    expect(libraryReducer(before, { type: "CLOSE_FOCUS" })).toBe(before);
  });

  test("from reel is a no-op (reel exits via TOGGLE_VIEW, not CLOSE_FOCUS)", () => {
    const before: LibraryView = {
      kind: "reel",
      selectedRecordId: "abc",
      selectionSynthesized: false
    };
    expect(libraryReducer(before, { type: "CLOSE_FOCUS" })).toBe(before);
  });
});

describe("TOGGLE_VIEW to grid", () => {
  test("from focus preserves selection", () => {
    const next = libraryReducer(
      { kind: "focus", selectedRecordId: "abc", returnAnchor: ANCHOR_A },
      { type: "TOGGLE_VIEW", to: "grid", fallbackId: null }
    );
    expect(next).toEqual({ kind: "grid", selectedRecordId: "abc" });
  });

  test("from reel (real selection) preserves selection", () => {
    const next = libraryReducer(
      { kind: "reel", selectedRecordId: "abc", selectionSynthesized: false },
      { type: "TOGGLE_VIEW", to: "grid", fallbackId: null }
    );
    expect(next).toEqual({ kind: "grid", selectedRecordId: "abc" });
  });

  test("from reel (synthesized selection) returns to grid with NO selection", () => {
    // The user toggled to Reel with nothing selected (fallback supplied
    // the id); toggling back must not gift a selection they never made.
    const next = libraryReducer(
      { kind: "reel", selectedRecordId: "abc", selectionSynthesized: true },
      { type: "TOGGLE_VIEW", to: "grid", fallbackId: null }
    );
    expect(next).toEqual({ kind: "grid", selectedRecordId: null });
  });

  test("from grid → grid is identity (no-op)", () => {
    const before: LibraryView = { kind: "grid", selectedRecordId: "abc" };
    const next = libraryReducer(before, {
      type: "TOGGLE_VIEW",
      to: "grid",
      fallbackId: null
    });
    expect(next).toEqual(before);
  });
});

describe("TOGGLE_VIEW round-trip selection provenance (SpecFlow I2)", () => {
  test("grid(no selection) → reel(via fallback) → grid leaves no selection", () => {
    const reel = libraryReducer(
      { kind: "grid", selectedRecordId: null },
      { type: "TOGGLE_VIEW", to: "reel", fallbackId: "xyz" }
    );
    expect(reel).toEqual({
      kind: "reel",
      selectedRecordId: "xyz",
      selectionSynthesized: true
    });
    const grid = libraryReducer(reel, {
      type: "TOGGLE_VIEW",
      to: "grid",
      fallbackId: null
    });
    expect(grid).toEqual({ kind: "grid", selectedRecordId: null });
  });

  test("grid(selection) → reel → grid keeps the user's selection", () => {
    const reel = libraryReducer(
      { kind: "grid", selectedRecordId: "abc" },
      { type: "TOGGLE_VIEW", to: "reel", fallbackId: "xyz" }
    );
    expect(reel).toEqual({
      kind: "reel",
      selectedRecordId: "abc",
      selectionSynthesized: false
    });
    const grid = libraryReducer(reel, {
      type: "TOGGLE_VIEW",
      to: "grid",
      fallbackId: null
    });
    expect(grid).toEqual({ kind: "grid", selectedRecordId: "abc" });
  });

  test("synthesized reel, then NAVIGATE a frame, then → grid keeps it (now a real choice)", () => {
    const reel = libraryReducer(
      { kind: "grid", selectedRecordId: null },
      { type: "TOGGLE_VIEW", to: "reel", fallbackId: "xyz" }
    );
    const navigated = libraryReducer(reel, { type: "NAVIGATE", recordId: "def" });
    expect(navigated).toEqual({
      kind: "reel",
      selectedRecordId: "def",
      selectionSynthesized: false
    });
    const grid = libraryReducer(navigated, {
      type: "TOGGLE_VIEW",
      to: "grid",
      fallbackId: null
    });
    expect(grid).toEqual({ kind: "grid", selectedRecordId: "def" });
  });
});

describe("TOGGLE_VIEW to reel", () => {
  test("from grid (with selection) carries selection into reel, not synthesized", () => {
    const next = libraryReducer(
      { kind: "grid", selectedRecordId: "abc" },
      { type: "TOGGLE_VIEW", to: "reel", fallbackId: "xyz" }
    );
    expect(next).toEqual({
      kind: "reel",
      selectedRecordId: "abc",
      selectionSynthesized: false
    });
  });

  test("from grid (no selection, fallback present) uses fallback, marked synthesized", () => {
    const next = libraryReducer(
      { kind: "grid", selectedRecordId: null },
      { type: "TOGGLE_VIEW", to: "reel", fallbackId: "xyz" }
    );
    expect(next).toEqual({
      kind: "reel",
      selectedRecordId: "xyz",
      selectionSynthesized: true
    });
  });

  test("from grid (no selection, no fallback) STAYS in grid — can't enter reel without a record", () => {
    const next = libraryReducer(
      { kind: "grid", selectedRecordId: null },
      { type: "TOGGLE_VIEW", to: "reel", fallbackId: null }
    );
    expect(next).toEqual({ kind: "grid", selectedRecordId: null });
  });

  test("from focus carries selection into reel, not synthesized", () => {
    const next = libraryReducer(
      { kind: "focus", selectedRecordId: "abc", returnAnchor: ANCHOR_A },
      { type: "TOGGLE_VIEW", to: "reel", fallbackId: null }
    );
    expect(next).toEqual({
      kind: "reel",
      selectedRecordId: "abc",
      selectionSynthesized: false
    });
  });
});

describe("NAVIGATE", () => {
  test("in focus updates selectedRecordId, preserves returnAnchor", () => {
    const next = libraryReducer(
      { kind: "focus", selectedRecordId: "abc", returnAnchor: ANCHOR_A },
      { type: "NAVIGATE", recordId: "xyz" }
    );
    expect(next).toEqual({
      kind: "focus",
      selectedRecordId: "xyz",
      returnAnchor: ANCHOR_A
    });
  });

  test("in reel updates selectedRecordId and clears synthesized provenance", () => {
    const next = libraryReducer(
      { kind: "reel", selectedRecordId: "abc", selectionSynthesized: true },
      { type: "NAVIGATE", recordId: "xyz" }
    );
    expect(next).toEqual({
      kind: "reel",
      selectedRecordId: "xyz",
      selectionSynthesized: false
    });
  });

  test("in grid is a no-op (← / → don't navigate in grid)", () => {
    const before: LibraryView = { kind: "grid", selectedRecordId: "abc" };
    expect(libraryReducer(before, { type: "NAVIGATE", recordId: "xyz" })).toBe(before);
  });
});

describe("SELECT_IN_GRID", () => {
  test("in grid updates selectedRecordId without opening focus", () => {
    const next = libraryReducer(
      { kind: "grid", selectedRecordId: null },
      { type: "SELECT_IN_GRID", recordId: "abc" }
    );
    expect(next).toEqual({ kind: "grid", selectedRecordId: "abc" });
  });

  test("re-selecting the already-selected cell is a referential no-op", () => {
    // Avoids allocating a new state object, which would re-render the grid.
    const before: LibraryView = { kind: "grid", selectedRecordId: "abc" };
    expect(libraryReducer(before, { type: "SELECT_IN_GRID", recordId: "abc" })).toBe(
      before
    );
  });

  test("in focus is a no-op", () => {
    const before: LibraryView = {
      kind: "focus",
      selectedRecordId: "abc",
      returnAnchor: ANCHOR_A
    };
    expect(libraryReducer(before, { type: "SELECT_IN_GRID", recordId: "xyz" })).toBe(
      before
    );
  });

  test("in reel is a no-op", () => {
    const before: LibraryView = {
      kind: "reel",
      selectedRecordId: "abc",
      selectionSynthesized: false
    };
    expect(libraryReducer(before, { type: "SELECT_IN_GRID", recordId: "xyz" })).toBe(
      before
    );
  });
});

describe("RESET_FOCUS_RETURN_SCROLL", () => {
  test("in focus clears returnAnchor scrollTop", () => {
    const next = libraryReducer(
      { kind: "focus", selectedRecordId: "abc", returnAnchor: ANCHOR_A },
      { type: "RESET_FOCUS_RETURN_SCROLL" }
    );
    expect(next).toEqual({
      kind: "focus",
      selectedRecordId: "abc",
      returnAnchor: { ...ANCHOR_A, scrollTop: 0 }
    });
  });

  test("outside focus is a no-op", () => {
    const before: LibraryView = { kind: "grid", selectedRecordId: "abc" };
    expect(libraryReducer(before, { type: "RESET_FOCUS_RETURN_SCROLL" })).toBe(before);
  });
});

describe("FILTER_CHANGED", () => {
  test("in focus, current selection still in visible set → no transition", () => {
    const before: LibraryView = {
      kind: "focus",
      selectedRecordId: "abc",
      returnAnchor: ANCHOR_A
    };
    const next = libraryReducer(before, {
      type: "FILTER_CHANGED",
      visibleIds: ["abc", "xyz"]
    });
    expect(next).toBe(before);
  });

  test("in focus, filter reset clears return scroll when selection survives", () => {
    const next = libraryReducer(
      { kind: "focus", selectedRecordId: "abc", returnAnchor: ANCHOR_A },
      {
        type: "FILTER_CHANGED",
        visibleIds: ["abc", "xyz"],
        resetReturnScroll: true
      }
    );
    expect(next).toEqual({
      kind: "focus",
      selectedRecordId: "abc",
      returnAnchor: { ...ANCHOR_A, scrollTop: 0 }
    });
  });

  test("in focus, current selection NOT in new visible set → bail to grid (selection cleared)", () => {
    // Plan decision: filter is a query, query changed, show new result
    // set in grid form. Wraparound math otherwise breaks.
    const next = libraryReducer(
      { kind: "focus", selectedRecordId: "abc", returnAnchor: ANCHOR_A },
      { type: "FILTER_CHANGED", visibleIds: ["xyz", "qrs"] }
    );
    expect(next).toEqual({ kind: "grid", selectedRecordId: null });
  });

  test("in reel, current selection NOT in new visible set → bail to grid", () => {
    const next = libraryReducer(
      { kind: "reel", selectedRecordId: "abc", selectionSynthesized: false },
      { type: "FILTER_CHANGED", visibleIds: ["xyz"] }
    );
    expect(next).toEqual({ kind: "grid", selectedRecordId: null });
  });

  test("in grid, selection filtered away → cleared to null (SpecFlow I1)", () => {
    // Grid now carries a real, inspectable selection; if it leaves the
    // visible set the inspector must empty rather than show an off-screen
    // record. (Previously FILTER_CHANGED was a no-op in grid.)
    const next = libraryReducer(
      { kind: "grid", selectedRecordId: "abc" },
      { type: "FILTER_CHANGED", visibleIds: ["xyz"] }
    );
    expect(next).toEqual({ kind: "grid", selectedRecordId: null });
  });

  test("in grid, selection still visible → identity no-op", () => {
    const before: LibraryView = { kind: "grid", selectedRecordId: "abc" };
    const next = libraryReducer(before, {
      type: "FILTER_CHANGED",
      visibleIds: ["abc", "xyz"]
    });
    expect(next).toBe(before);
  });

  test("in grid with no selection → identity no-op", () => {
    const before: LibraryView = { kind: "grid", selectedRecordId: null };
    const next = libraryReducer(before, {
      type: "FILTER_CHANGED",
      visibleIds: ["xyz"]
    });
    expect(next).toBe(before);
  });

  test("empty visibleIds in focus → bails to grid (whole filter has no captures)", () => {
    const next = libraryReducer(
      { kind: "focus", selectedRecordId: "abc", returnAnchor: ANCHOR_A },
      { type: "FILTER_CHANGED", visibleIds: [] }
    );
    expect(next).toEqual({ kind: "grid", selectedRecordId: null });
  });

});

describe("type-system guarantees", () => {
  test("focus state always has non-null selectedRecordId at compile time", () => {
    const view: LibraryView = {
      kind: "focus",
      selectedRecordId: "abc",
      returnAnchor: ANCHOR_A
    };
    if (view.kind === "focus") {
      // No `!` non-null assertion needed; TypeScript narrows this to string.
      expect(typeof view.selectedRecordId).toBe("string");
      expect(view.returnAnchor).toBeDefined();
    }
  });

  // The compile-time guard is exercised here. Uncommenting the @ts-expect-error
  // line below should be a TS error — focus state cannot have a null selection.
  test("invalid focus shape is a TS error (compile-time guard)", () => {
    // @ts-expect-error — focus state requires non-null selectedRecordId
    const _illegal: LibraryView = { kind: "focus", selectedRecordId: null };
    void _illegal;
  });
});
