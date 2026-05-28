// Pure decision function for "what happens to the selection when the
// user clicks?" — extracted from Editor.tsx onPointerDown so the
// matrix of (hit / no-hit, additive / plain, already-in-selection /
// not) can be tested in isolation without mounting the Editor.
//
// The single non-obvious rule: a PLAIN click on a layer that is
// already in a MULTI-selection KEEPS the selection (returns `keep`)
// rather than collapsing to a singleton. That's the gesture that
// starts a group drag-to-move — without `keep` the click would
// replace the selection with [hit] and the user would lose the
// group before they ever moved the cursor. Same code path is used
// by both the pointer-tool and drawing-tool branches of
// `Editor.onPointerDown`.

export type ClickSelectionAction =
  | { readonly type: "replace"; readonly id: string }
  | { readonly type: "toggle"; readonly id: string }
  | { readonly type: "clear" }
  | { readonly type: "keep" };

export interface DecideClickSelectionArgs {
  /** Layer id under the cursor, or `null` for empty canvas. */
  readonly hit: string | null;
  /** Selection at the moment of the click. */
  readonly currentSelection: readonly string[];
  /** `event.metaKey || event.ctrlKey` — Cmd/Ctrl held = multi-select
   *  toggle gesture. */
  readonly additive: boolean;
}

export function decideClickSelection(
  args: DecideClickSelectionArgs
): ClickSelectionAction {
  const { hit, currentSelection, additive } = args;
  if (hit === null) {
    // No layer under the cursor. Plain click clears (the user is
    // saying "select nothing"); additive Cmd-click leaves the
    // selection alone (the additive gesture shouldn't drop
    // everything when the user misses — they're trying to ADD, not
    // reset).
    return additive ? { type: "keep" } : { type: "clear" };
  }
  if (additive) {
    // Cmd/Ctrl-click on a layer toggles its membership in the
    // selection — already in → remove; not in → add. Handled by
    // toggleSelection in the caller.
    return { type: "toggle", id: hit };
  }
  if (currentSelection.includes(hit)) {
    // Plain click on a layer that's ALREADY in the selection. This
    // is the start of a group drag-to-move — don't collapse the
    // selection to a singleton, because the caller's drag pathway
    // is going to translate ALL selected layers by the cursor delta
    // on pointerup. Pre-fix this returned `replace`, and the user
    // reported "group selecting a bunch of things should then allow
    // click+drag to move them all... but instead it unselects the
    // group."
    return { type: "keep" };
  }
  // Plain click on a layer NOT in the current selection — replace.
  // This is the standard "click a layer to select it" gesture.
  return { type: "replace", id: hit };
}
