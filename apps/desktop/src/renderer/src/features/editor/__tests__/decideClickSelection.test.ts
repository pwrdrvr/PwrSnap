// Tests for `decideClickSelection` — the pure-function decision step
// inside Editor.onPointerDown. The user-reported regression that
// motivated extracting this:
//
//   "Group selecting a bunch of things should then allow click+drag
//   to move them all... but instead it unselects the group."
//
// Pre-fix that click went through `replaceSelection(hit)` which
// collapsed the multi-select to a singleton before the drag could
// even fire. The `keep` action is the load-bearing addition; the
// rest of the matrix is pinned to lock the surrounding behavior.

import { describe, expect, test } from "vitest";
import { decideClickSelection } from "../decideClickSelection";

describe("decideClickSelection — empty canvas (no hit)", () => {
  test("plain click clears the selection", () => {
    expect(
      decideClickSelection({
        hit: null,
        currentSelection: ["a", "b"],
        additive: false
      })
    ).toEqual({ type: "clear" });
  });

  test("Cmd-click on empty canvas KEEPS the selection (additive gesture missed)", () => {
    // Without this, Cmd-click on whitespace would wipe everything
    // the user had just spent time building up — the additive
    // gesture shouldn't be punished for missing.
    expect(
      decideClickSelection({
        hit: null,
        currentSelection: ["a", "b"],
        additive: true
      })
    ).toEqual({ type: "keep" });
  });
});

describe("decideClickSelection — Cmd-click matrix (additive)", () => {
  test("Cmd-click on a layer not in selection → toggle (add)", () => {
    expect(
      decideClickSelection({
        hit: "x",
        currentSelection: ["a"],
        additive: true
      })
    ).toEqual({ type: "toggle", id: "x" });
  });

  test("Cmd-click on a layer already in selection → toggle (remove)", () => {
    expect(
      decideClickSelection({
        hit: "a",
        currentSelection: ["a", "b"],
        additive: true
      })
    ).toEqual({ type: "toggle", id: "a" });
  });

  test("Cmd-click on a layer from empty selection → toggle (initial add)", () => {
    expect(
      decideClickSelection({
        hit: "a",
        currentSelection: [],
        additive: true
      })
    ).toEqual({ type: "toggle", id: "a" });
  });
});

describe("decideClickSelection — plain click matrix (the bug + the surround)", () => {
  test("plain click on a layer NOT in current selection → replace", () => {
    expect(
      decideClickSelection({
        hit: "x",
        currentSelection: ["a", "b"],
        additive: false
      })
    ).toEqual({ type: "replace", id: "x" });
  });

  test("plain click on a SINGLE-selected layer (clicking the same one) → keep", () => {
    // The selection is already [a] and the user clicks a. Returning
    // `keep` is functionally identical to `replace(a)` for
    // selectedLayerIds — the caller's effect is the same. We use
    // `keep` uniformly for "hit is already selected" so the drag-
    // initiation branch downstream only has to check ONE action
    // shape (`keep` ⇒ the user is starting a drag on an
    // already-selected layer). Single-selected drag still goes
    // through TransformHandles' body-hit rect (which catches the
    // pointerdown before this code runs), so this branch is mostly
    // exercised by the multi-select case below.
    expect(
      decideClickSelection({
        hit: "a",
        currentSelection: ["a"],
        additive: false
      })
    ).toEqual({ type: "keep" });
  });

  test("plain click on a layer in a MULTI-selection → keep (DO NOT collapse the group)", () => {
    // The user-reported regression. Pre-fix this returned `replace`
    // which collapsed the multi-selection to [a] before the drag
    // could fire. With `keep` the selection survives and the caller
    // can proceed to initiate a group drag-to-move.
    expect(
      decideClickSelection({
        hit: "a",
        currentSelection: ["a", "b", "c"],
        additive: false
      })
    ).toEqual({ type: "keep" });
  });

  test("plain click on a different member of a MULTI-selection → keep (still no collapse)", () => {
    // Same as above but the user clicks a NON-FIRST member of the
    // group. Behavior is symmetric — any layer in the group keeps
    // the group.
    expect(
      decideClickSelection({
        hit: "c",
        currentSelection: ["a", "b", "c"],
        additive: false
      })
    ).toEqual({ type: "keep" });
  });

  test("plain click on a layer OUTSIDE a multi-selection → replace (single)", () => {
    // Clicking a layer that's NOT part of the group switches the
    // selection to just that layer — standard "click a different
    // layer to select it" gesture.
    expect(
      decideClickSelection({
        hit: "outsider",
        currentSelection: ["a", "b", "c"],
        additive: false
      })
    ).toEqual({ type: "replace", id: "outsider" });
  });
});
