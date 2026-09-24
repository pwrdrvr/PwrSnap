// Escape for every click-opened overlay — dialogs, confirm popovers, menus —
// resolved ONCE per keypress, so exactly one overlay answers it.
//
// Before this, each overlay added its own keydown listener, on whichever
// target and phase its author picked: DeleteConfirm on document-capture, the
// grid context menus on document-capture, ChatApprovalModal on window-capture,
// HotkeyResetModal and the storage popover on window-bubble, and
// AiConsentDialog on nothing at all. The app's own Escape handlers (the
// Library's "leave Focus" / "collapse the rail", the editor's "clear the
// selection") are plain window listeners that do not check
// `defaultPrevented`, so an overlay that did not stop the event let one
// Escape do two things: the storage popover closed AND the rail collapsed.
//
// Ported from PwrGit's `useDismissable` (pwrdrvr/PwrGit#307) with one
// deliberate difference, below in `onGlobalKeyDown`: a claimed Escape is
// STOPPED, not just default-prevented, because PwrSnap's underlying handlers
// never learned to check.

import { useEffect, useRef, type RefObject } from "react";

type Layer = {
  /** The control that opened the overlay, when there is one. Counts as
   *  "inside" for ownership, and is where focus goes on Escape. */
  triggerRef: RefObject<HTMLElement | null> | undefined;
  surfaceRef: RefObject<HTMLElement | null>;
  /** Read at dismiss time so a re-rendered callback is never stale. */
  onDismiss: RefObject<() => void>;
};

/** Every overlay currently open, in the order they opened. */
const openOverlays: Layer[] = [];

/** Ancestor count. Shared with `useFocusTrap`, which resolves Tab by the
 *  same deepest-holder rule. */
export function depth(el: Element): number {
  let n = 0;
  for (let node = el.parentElement; node !== null; node = node.parentElement) n++;
  return n;
}

/**
 * Which open overlay owns Escape.
 *
 * **The one holding focus wins**, the deepest when nested surfaces both hold
 * it, and open order only breaks ties. Three cheaper rules each look right
 * and are wrong:
 *
 * - *Listener order.* Everything listens on `window`, so it is decided by
 *   registration order — backwards for a menu opened inside a dialog that
 *   registered first.
 * - *Open order alone.* React runs child effects before parent effects, so
 *   two overlays mounting in one commit register innermost-FIRST.
 * - *The last layer containing focus.* Nested surfaces BOTH contain it;
 *   depth is what tells them apart.
 *
 * Focus parked in something that is not a registered overlay claims nothing:
 * it may be a surface that does not use this hook, and closing the overlay
 * underneath while the user dismisses the thing on top is the bug this file
 * exists to stop. Only "nowhere in particular" (`<body>`, null, detached) —
 * which is where focus lands when the element holding it unmounts — falls
 * through to the newest overlay.
 */
function escapeOwner(): Layer | undefined {
  const active = document.activeElement;
  if (active !== null) {
    let best: Layer | undefined;
    let bestDepth = -1;
    for (const layer of openOverlays) {
      const surface = layer.surfaceRef.current;
      const trigger = layer.triggerRef?.current ?? null;
      // The trigger belongs to its overlay as much as the surface does: the
      // storage popover never takes focus off the button that opened it, and
      // Escape from there must still close it.
      const holder =
        surface?.contains(active) === true
          ? surface
          : trigger?.contains(active) === true
            ? trigger
            : null;
      if (holder === null) continue;
      const d = depth(holder);
      // >= so a later-opened sibling at equal depth still wins.
      if (d >= bestDepth) {
        best = layer;
        bestDepth = d;
      }
    }
    if (best !== undefined) return best;
  }
  const nowhere = active === null || active === document.body || !active.isConnected;
  return nowhere ? openOverlays[openOverlays.length - 1] : undefined;
}

/**
 * One listener for every overlay, not one per hook instance: per-instance
 * listeners all fire for the same key, and dismissing the owner moves focus,
 * so the next one computes a DIFFERENT owner and dismisses that too — one
 * Escape closing a menu and the dialog behind it.
 *
 * **Why it is stopped, not only default-prevented.** PwrGit's version only
 * calls `preventDefault` and relies on every other Escape handler checking
 * `defaultPrevented`. PwrSnap's do not — Library.tsx's view keydown,
 * Editor.tsx's selection clear, RightActivityBar's hover panel — and the
 * overlays here always stopped the event instead (see the header of this
 * file). Stopping is the rule that works without editing every handler.
 *
 * `stopImmediatePropagation`, not `stopPropagation`, because the editor's
 * handler is ALSO a window-capture listener, and `stopPropagation` does not
 * reach listeners on the same target. That only works if this listener is
 * the FIRST window-capture keydown listener — which is why it is installed
 * when this module is evaluated (below), before any component mounts, and
 * never removed. Adding and removing it as the stack empties and refills
 * (PwrGit's shape) would move it behind the editor's.
 *
 * IME composition keeps its Escape: in a text field it cancels the
 * composition, not the dialog.
 */
function onGlobalKeyDown(e: KeyboardEvent): void {
  if (e.key !== "Escape" || e.isComposing || e.defaultPrevented) return;
  const owner = escapeOwner();
  if (owner === undefined) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  // Dismiss FIRST, then move focus. Moving it first blurs whatever held it
  // while the overlay is still live, and a field that commits on blur then
  // commits the very edit Escape was meant to throw away — the zoom field
  // did exactly that. And only park focus on the trigger if it is still in
  // the overlay: a dismiss handler that sent it somewhere on purpose wins.
  owner.onDismiss.current();
  const trigger = owner.triggerRef?.current ?? null;
  if (trigger !== null && trigger.isConnected) {
    const active = document.activeElement;
    const inside =
      active === trigger || (active !== null && owner.surfaceRef.current?.contains(active) === true);
    if (inside) trigger.focus();
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("keydown", onGlobalKeyDown, true);
}

/**
 * Escape-dismisses an open overlay. Give it the overlay's element and, for a
 * surface a button opens, that button: focus returns there on Escape.
 *
 * Only Escape lives here. Keeping Tab inside a dialog is `useFocusTrap`, the
 * menu keys are `useMenuNavigation`, and a dialog wants all of it together —
 * `useModal`.
 */
export function useDismissable({
  open,
  onDismiss,
  surfaceRef,
  triggerRef,
  dismissOnFocusLeave = false
}: {
  open: boolean;
  onDismiss: () => void;
  /** The overlay itself. It owns Escape while it holds focus. */
  surfaceRef: RefObject<HTMLElement | null>;
  /** The control that opened the overlay; focus returns here on Escape. */
  triggerRef?: RefObject<HTMLElement | null>;
  /**
   * For a NON-modal popover that sits right after its trigger in the DOM
   * (the zoom popover, the storage popover): Tab or Shift+Tab out past
   * either end closes it, rather than leaving it open over whatever focus
   * moved on to. Moving back onto the trigger keeps it open. Only a move to a
   * real element counts — a click on the popover's own padding, or the
   * window losing focus, reports no `relatedTarget` and must not close it.
   * A modal traps instead and never needs this.
   */
  dismissOnFocusLeave?: boolean;
}): void {
  // Held in a ref so a caller passing a fresh closure each render never
  // re-registers — re-registering would reorder the stack.
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (!open) return;
    const layer: Layer = { triggerRef, surfaceRef, onDismiss: onDismissRef };
    openOverlays.push(layer);
    return () => {
      const at = openOverlays.indexOf(layer);
      if (at !== -1) openOverlays.splice(at, 1);
    };
  }, [open, surfaceRef, triggerRef]);

  useEffect(() => {
    if (!open || !dismissOnFocusLeave) return;
    const surface = surfaceRef.current;
    if (surface === null) return;
    const trigger = triggerRef?.current ?? null;
    const within = (node: Node): boolean =>
      surface.contains(node) || trigger?.contains(node) === true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The trigger is watched too: Shift+Tab from the popover's first control
    // lands on it (allowed), and the NEXT Shift+Tab leaves from there.
    const onFocusOut = (e: FocusEvent): void => {
      const next = e.relatedTarget;
      if (!(next instanceof Node) || within(next)) return;
      // Not now. During focusout the old element has blurred and the new one
      // is not focused yet, so `activeElement` is <body>; closing here would
      // unmount the popover mid-move, and a focus return that sees <body>
      // (useFocusReturn) pulls focus back to the trigger — measured in
      // Chromium, Tab past the zoom popover's last button landed on the zoom
      // button instead of the next toolbar control. Close once it has landed.
      clearTimeout(timer);
      timer = setTimeout(() => {
        const active = document.activeElement;
        if (active === null || !within(active)) onDismissRef.current();
      }, 0);
    };
    surface.addEventListener("focusout", onFocusOut);
    trigger?.addEventListener("focusout", onFocusOut);
    return () => {
      clearTimeout(timer);
      surface.removeEventListener("focusout", onFocusOut);
      trigger?.removeEventListener("focusout", onFocusOut);
    };
  }, [open, dismissOnFocusLeave, surfaceRef, triggerRef]);
}
