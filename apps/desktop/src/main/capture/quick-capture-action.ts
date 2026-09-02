// Main-side resolution of the Snap-vs-Record chooser (issue #75).
//
// The selector reports which affordance the user reached for; this
// decides what actually runs. The two are not the same thing, and the
// split is deliberate: the renderer is where the keys and buttons live,
// but only main knows what policy it configured the show with.

import type { QuickCaptureAction, SelectorTerminalAction } from "@pwrsnap/shared";

/**
 * What a committed selection should do.
 *
 * `preference` is the persisted policy this show was opened under;
 * `reported` is the renderer's echo (absent = the user took the snap
 * path, which is every pre-chooser call site).
 *
 * Only ONE case overrides the renderer: `"snap"`, where no Record
 * affordance was rendered and no `R` was bound, so a `"record"` echo
 * could only come from a bug or a hand-rolled IPC message. `"ask"` and
 * `"record"` both put both actions on screen, so there the user's
 * keystroke is the answer — resolving `"record"` for a policy of
 * `"record"` regardless of the echo would eat the `S` escape hatch and
 * record a selection the user explicitly asked to photograph.
 *
 * Note what this function is NOT: it does not know about pick sets. A
 * multi-window commit cannot be recorded at all, and that is enforced
 * where the two facts meet — the renderer's `recordAvailable()` and the
 * transport backstop in region-selector.ts, both of which strip the
 * action before it ever reaches here.
 */
export function resolveQuickCaptureAction(
  preference: QuickCaptureAction,
  reported: SelectorTerminalAction | undefined
): SelectorTerminalAction {
  if (preference === "snap") return "snap";
  return reported ?? "snap";
}
