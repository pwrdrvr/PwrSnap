import { setFloatOverState } from "../float-over";
import { findMainLibraryWindow, scheduleDockReclaim } from "../window";
import {
  hideSelector,
  isSelectorInvocationCurrent,
  type SelectorResult
} from "./region-selector";

/** Complete an image or recording selector's cancellation while it still owns
 * the screen. Supersession can occur before this continuation runs or during
 * the compositor wait; neither case may restore chrome or focus over a newer
 * selector's snapshot. */
export async function finishSelectorCancellation(
  selection: Extract<SelectorResult, { ok: false }>
): Promise<void> {
  const invocationId = selection.selectorInvocationId;
  if (!isSelectorInvocationCurrent(invocationId)) return;
  // Park the pre-shown toast before dropping its covering selector. A stale
  // cancel here would restore the waiting dock during the next acquisition.
  setFloatOverState({ kind: "cancel" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (!isSelectorInvocationCurrent(invocationId)) return;
  hideSelector(invocationId);
  // A non-activating selector never deactivated another app. Restore focus
  // only when PwrSnap was frontmost, after the selector relinquishes key.
  if (selection.previousAppPid === null || selection.previousAppPid === undefined) {
    const library = findMainLibraryWindow();
    if (library !== null && !library.isDestroyed()) {
      if (library.isMinimized()) library.restore();
      if (!library.isVisible()) library.show();
      library.focus();
    }
  }
  // Reassert activation policy after AppKit's asynchronous demotion. This
  // helper restores the Dock icon, never application activation or z-order.
  scheduleDockReclaim();
}
