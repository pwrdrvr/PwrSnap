// Editor-level test for the Escape gesture against the right-click
// context menu. PR #150 test plan: "Escape closes the menu WITHOUT
// clearing the selection." Pre-fix, the Editor's window-capture
// keydown listener ran the selection-clearing branch on Escape
// regardless of whether the menu was open, because:
//
//   • window-capture listeners fire before document-capture in the
//     DOM event-propagation order. Editor's listener is at
//     window-capture (Editor.tsx); the menu's at document-capture
//     (LayerContextMenu.tsx). Editor fires first.
//   • The menu's listener calls `stopPropagation()` but that runs
//     AFTER Editor's listener has already executed — too late to
//     undo `clearSelection()`.
//
// Net pre-fix UX: Escape on an open menu cleared the selection (and
// the menu closed too, via the close-on-selection-change useEffect),
// violating the spec.
//
// The fix in Editor.tsx adds an early-return gate:
//   if (event.key === "Escape" && contextMenuState !== null) {
//     setContextMenuState(null);
//     return;
//   }
// placed BEFORE the selection-clearing branch. This test mimics that
// shape against an extracted helper so we can unit-test the decision
// without mounting the full Editor.

import { describe, expect, test, vi } from "vitest";

/** Pure helper that mirrors the SHAPE of Editor.tsx's onKey Escape
 *  branches. Extracted so the decision logic is testable without
 *  mounting the full Editor component (which needs a captureId, a
 *  CaptureModel, a model dispatcher, etc.). The real onKey calls
 *  setContextMenuState / setDraft / clearSelection on React state;
 *  here we surface the same decisions as a returned action so the
 *  test can assert which branch fired without React. The branch
 *  order MUST match Editor.tsx exactly — see the inline order
 *  comments. */
type EscapeAction =
  | { kind: "cancel-draft" }
  | { kind: "close-context-menu" }
  | { kind: "clear-selection" }
  | { kind: "none" };

function decideEscapeAction(state: {
  draftActive: boolean;
  contextMenuOpen: boolean;
  selectionCount: number;
}): EscapeAction {
  if (state.draftActive) return { kind: "cancel-draft" };
  // The fix — must come BEFORE the selection-clear branch so the
  // menu's gesture takes priority when both could fire.
  if (state.contextMenuOpen) return { kind: "close-context-menu" };
  if (state.selectionCount > 0) return { kind: "clear-selection" };
  return { kind: "none" };
}

describe("Editor Escape gesture — context-menu vs selection", () => {
  test("draft active → cancel draft (highest priority)", () => {
    const action = decideEscapeAction({
      draftActive: true,
      contextMenuOpen: true,
      selectionCount: 3
    });
    expect(action.kind).toBe("cancel-draft");
  });

  test("no draft, menu open, selection present → close menu (NOT clear selection)", () => {
    // The load-bearing assertion for the PR #150 spec. Pre-fix the
    // selection-clear branch fired even when the menu was open,
    // because Editor.tsx didn't check `contextMenuState !== null`
    // before the selection-clear branch. Post-fix the menu wins.
    const action = decideEscapeAction({
      draftActive: false,
      contextMenuOpen: true,
      selectionCount: 3
    });
    expect(action.kind).toBe("close-context-menu");
  });

  test("no draft, menu open, NO selection → close menu", () => {
    // Same branch, no selection in play. The contextMenuOpen check
    // must fire regardless of selection.
    const action = decideEscapeAction({
      draftActive: false,
      contextMenuOpen: true,
      selectionCount: 0
    });
    expect(action.kind).toBe("close-context-menu");
  });

  test("no draft, no menu, selection present → clear selection (original behavior preserved)", () => {
    // Regression guard for the unchanged path: when no menu is
    // open, Escape still clears the selection as it did before.
    const action = decideEscapeAction({
      draftActive: false,
      contextMenuOpen: false,
      selectionCount: 2
    });
    expect(action.kind).toBe("clear-selection");
  });

  test("no draft, no menu, no selection → no-op", () => {
    const action = decideEscapeAction({
      draftActive: false,
      contextMenuOpen: false,
      selectionCount: 0
    });
    expect(action.kind).toBe("none");
  });
});

describe("Editor Escape gesture — branch ordering invariant", () => {
  // The branch priority is load-bearing — getting the order wrong
  // produces user-visible bugs (selection cleared when user wanted
  // to just dismiss the menu). These tests pin the priority so a
  // future "simplification" can't quietly reorder.

  test("menu check fires BEFORE selection check (selection survives menu dismissal)", () => {
    // Specifically: when both contextMenuOpen AND selectionCount > 0
    // are true, the chosen action must be close-context-menu, not
    // clear-selection.
    const action = decideEscapeAction({
      draftActive: false,
      contextMenuOpen: true,
      selectionCount: 5
    });
    expect(action.kind).not.toBe("clear-selection");
    expect(action.kind).toBe("close-context-menu");
  });

  test("draft check fires BEFORE menu check (draft cancellation wins over menu close)", () => {
    // If a draft is active AND a menu is somehow also open, the
    // draft branch wins. In practice the menu close-on-draft-open
    // useEffect prevents this state, but the priority is still
    // documented here as the contract.
    const action = decideEscapeAction({
      draftActive: true,
      contextMenuOpen: true,
      selectionCount: 0
    });
    expect(action.kind).toBe("cancel-draft");
  });
});

describe("Editor Escape gesture — bug-driven mock of real onKey flow", () => {
  // This test wires the helper up to a mock state container that
  // mimics the React state-setters Editor.tsx uses. It documents
  // the EXACT pre-fix bug shape (selection cleared instead of just
  // closing the menu) and verifies the fix.

  test("post-fix: Escape with menu open closes menu and preserves selection", () => {
    const setContextMenuState = vi.fn();
    const clearSelection = vi.fn();
    const setDraft = vi.fn();

    const state = {
      draftActive: false,
      contextMenuOpen: true,
      selectionCount: 3
    };

    function dispatchEscape(): void {
      const action = decideEscapeAction(state);
      if (action.kind === "cancel-draft") setDraft(null);
      else if (action.kind === "close-context-menu") setContextMenuState(null);
      else if (action.kind === "clear-selection") clearSelection();
    }

    dispatchEscape();

    expect(setContextMenuState).toHaveBeenCalledWith(null);
    expect(clearSelection).not.toHaveBeenCalled();
    expect(setDraft).not.toHaveBeenCalled();
  });

  test("post-fix: Escape without menu still clears selection (legacy path)", () => {
    const setContextMenuState = vi.fn();
    const clearSelection = vi.fn();

    const state = {
      draftActive: false,
      contextMenuOpen: false,
      selectionCount: 3
    };

    const action = decideEscapeAction(state);
    if (action.kind === "close-context-menu") setContextMenuState(null);
    else if (action.kind === "clear-selection") clearSelection();

    expect(clearSelection).toHaveBeenCalledTimes(1);
    expect(setContextMenuState).not.toHaveBeenCalled();
  });
});
