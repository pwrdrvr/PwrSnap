// Keeps Tab inside an open modal (WCAG 2.1 SC 2.4.3) and hands focus back to
// whatever opened it.
//
// A dialog that says `aria-modal="true"` and does not trap is a modal in name
// only: Tab walks out into the page behind the scrim, where a keyboard user
// then operates controls they cannot see, with no way back. Measured in
// headless Chromium before this hook existed, AiConsentDialog did not even
// take focus on open, and HotkeyResetModal and DeleteConfirm let the second
// or third Tab out. ChatApprovalModal trapped, with a hand-rolled listener
// that wrapped past its own scrollable command detail.
//
// Ported from PwrGit's `useFocusTrap` (pwrdrvr/PwrGit#307), keeping the four
// fixes that PR found in it — each is called out where it lives.

import { useEffect, useRef, type RefObject } from "react";
import { depth } from "./useDismissable";
import { useFocusReturn } from "./useFocusReturn";

/**
 * Everything tabbable, in DOM order. `tabindex="-1"` is excluded later, not
 * here — it means "focusable, but not a tab stop", which is what roving menu
 * items use, and they must not be cycled by the trap.
 */
const TABBABLE =
  "a[href],area[href],button,input,select,textarea,summary,iframe,object,embed," +
  "[contenteditable],[tabindex]";

/**
 * Chromium answers this directly. jsdom does not implement `checkVisibility`,
 * and its `offsetParent` is always null (it does no layout), so the fallback
 * reads the cascade instead, which jsdom does model. Using `offsetParent`
 * would make the trap match nothing under test while working in the app.
 *
 * `visibilityProperty: true` is not optional: `checkVisibility()` ignores
 * `visibility` by default, so a `visibility: hidden` control would sit in the
 * cycle in the app while the jsdom fallback excluded it. DeleteConfirm renders
 * `visibility: hidden` for the frame before it is positioned.
 */
function visible(el: HTMLElement): boolean {
  if (typeof el.checkVisibility === "function") {
    return el.checkVisibility({ visibilityProperty: true });
  }
  for (let node: HTMLElement | null = el; node !== null; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

function isStop(el: HTMLElement): boolean {
  if (el.hasAttribute("disabled") || el.getAttribute("aria-hidden") === "true") return false;
  if (el.tabIndex < 0 || el.hidden) return false;
  return visible(el);
}

const SCROLLS = new Set(["auto", "scroll", "overlay"]);

/**
 * A scroller Chromium puts in the Tab order by itself, so the arrow keys can
 * scroll it: one that overflows and holds nothing focusable. Nothing in the
 * markup says so — it has no tabindex and its `tabIndex` reads -1 — so the
 * TABBABLE selector cannot see it.
 *
 * (PwrGit fix 2.) The trap decides where the cycle ends, so a trap blind to
 * these wraps straight past one before a dialog's first control or after its
 * last. ChatApprovalModal's command detail (`max-height: 240px`) and
 * HotkeyResetModal's change list are both this shape: a long command could
 * not be scrolled from the keyboard at all.
 *
 * jsdom does no layout, so `scrollHeight` is always 0 there and this never
 * matches under test unless the test supplies the geometry.
 */
function scrollsByKeyboard(el: HTMLElement): boolean {
  if (el.hasAttribute("tabindex")) return false; // judged as an ordinary stop
  const style = getComputedStyle(el);
  const overflowsY = SCROLLS.has(style.overflowY) && el.scrollHeight > el.clientHeight;
  const overflowsX = SCROLLS.has(style.overflowX) && el.scrollWidth > el.clientWidth;
  return overflowsY || overflowsX;
}

/**
 * The container's Tab stops, in document order.
 *
 * `scrollers: false` is for initial focus, which belongs on a control even
 * when a scroller comes first — opening the approval prompt should land on
 * Deny, not on the command text above it.
 */
function tabbable(root: HTMLElement | null, { scrollers = true } = {}): HTMLElement[] {
  if (root === null) return [];
  if (!scrollers) return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(isStop);
  const all = [...root.querySelectorAll<HTMLElement>("*")];
  const stops = new Set(all.filter((el) => el.matches(TABBABLE) && isStop(el)));
  // Innermost first, as Chromium decides it: a scroller holding a stop, even
  // another scroller, is not a stop itself.
  const holders = [...stops];
  for (let i = all.length - 1; i >= 0; i--) {
    const el = all[i]!;
    if (stops.has(el) || !scrollsByKeyboard(el) || !visible(el)) continue;
    if (holders.some((stop) => el.contains(stop))) continue;
    stops.add(el);
    holders.push(el);
  }
  return all.filter((el) => stops.has(el));
}

/**
 * Where a Tab that closed a menu leaves focus, decided after the menu's own
 * handler has run.
 *
 * In Chromium the menu has already closed by then — React flushes the close
 * in the microtask after the menu's listener — and handed focus back to its
 * trigger (useFocusReturn). APG says Tab from a menu closes it and moves ON,
 * so the step the browser would have taken from the trigger is taken here,
 * wrapped inside the container. Focus that did not come back inside, or is
 * still in a menu (a menu that did not close, or a test that dispatches
 * without letting React commit), goes to the near edge instead.
 */
function moveOn(root: HTMLElement, shift: boolean): void {
  const list = tabbable(root);
  if (list.length === 0) {
    root.focus();
    return;
  }
  const active = document.activeElement as HTMLElement | null;
  const back =
    active !== null && root.contains(active) && active.closest('[role="menu"]') === null;
  const at = back ? list.indexOf(active) : -1;
  if (at === -1) {
    (shift ? list[list.length - 1]! : list[0]!).focus();
    return;
  }
  list[(at + (shift ? -1 : 1) + list.length) % list.length]!.focus();
}

type Trap = { containerRef: RefObject<HTMLElement | null> };

/** Every trap currently open, in the order they opened. */
const openTraps: Trap[] = [];

/**
 * Which open trap answers this Tab — only ever one. (PwrGit fix 1.)
 *
 * Every trap listens on `window`, and a trap that sees focus outside its
 * container pulls it back in. With two open at once and no owner rule, the
 * lower one takes the upper one's Tab and drags focus behind it; give both
 * the pull and they fight over every keypress until focus sticks on an edge.
 *
 * The rule is `useDismissable`'s for Escape: the trap holding focus wins, the
 * deepest when nested containers both hold it, and focus in none of them —
 * pulled out programmatically, or lost to <body> — falls to the newest.
 */
function tabOwner(): Trap | undefined {
  const active = document.activeElement;
  let best: Trap | undefined;
  let bestDepth = -1;
  if (active !== null) {
    for (const trap of openTraps) {
      const root = trap.containerRef.current;
      if (root === null || !root.contains(active)) continue;
      const d = depth(root);
      // >= so a later-opened sibling at equal depth still wins.
      if (d >= bestDepth) {
        best = trap;
        bestDepth = d;
      }
    }
  }
  return best ?? openTraps[openTraps.length - 1];
}

/**
 * Keeps Tab inside `containerRef` while `open`, moves focus in on open, and
 * returns it to the opener on close.
 *
 * Escape is not here: it belongs to `useDismissable`, and a dialog wants both
 * — use `useModal`. Give the container `tabIndex={-1}` so a dialog with
 * nothing enabled (ChatApprovalModal while it submits) can still hold focus.
 */
export function useFocusTrap({
  open,
  containerRef,
  initialFocusRef,
  returnFocusRef,
  preventScroll = false
}: {
  open: boolean;
  containerRef: RefObject<HTMLElement | null>;
  /** Where focus lands on open. Defaults to the first tabbable control; an
   *  initial target that is disabled or hidden falls back the same way. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Where focus goes on close, when it is not simply the opener — see
   *  useFocusReturn. */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** Focus on open without scrolling. For a popover that closes on scroll
   *  (DeleteConfirm), where the scroll would dismiss it as it opened. */
  preventScroll?: boolean;
}): void {
  useFocusReturn({
    open,
    containerRef,
    ...(returnFocusRef === undefined ? {} : { returnFocusRef })
  });

  // Read by the key handler without re-subscribing it.
  const preventScrollRef = useRef(preventScroll);
  preventScrollRef.current = preventScroll;

  useEffect(() => {
    if (!open) return;
    const root = containerRef.current;
    if (root === null) return;
    // Something inside already took focus (autoFocus, or the component's own
    // layout effect): leave it there.
    if (root.contains(document.activeElement)) return;
    const preferred = initialFocusRef?.current ?? null;
    const target =
      preferred !== null && isStop(preferred)
        ? preferred
        : tabbable(root, { scrollers: false })[0];
    (target ?? root).focus({ preventScroll: preventScrollRef.current });
  }, [open, containerRef, initialFocusRef]);

  useEffect(() => {
    if (!open) return;
    const trap: Trap = { containerRef };
    openTraps.push(trap);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Tab" || e.defaultPrevented) return;
      if (tabOwner() !== trap) return;
      const root = containerRef.current;
      if (root === null) return;
      const active = document.activeElement;

      // (PwrGit fix 3.) A menu answers Tab itself: useMenuNavigation closes
      // it on Tab, but only while focus is still inside it, and this capture
      // listener runs first. Pulling focus here — to the far edge, or back
      // from a menu portalled out of the container — leaves the menu open
      // over a dialog whose keys it still owns. So claim the key, and decide
      // where focus goes only after the menu's own listener (a window bubble
      // listener, registered before this one-shot) has run and closed it.
      if (active?.closest('[role="menu"]') != null) {
        e.preventDefault();
        const shift = e.shiftKey;
        window.addEventListener(
          "keydown",
          (after) => {
            if (after !== e) return;
            moveOn(root, shift);
          },
          { once: true }
        );
        return;
      }

      const list = tabbable(root);
      if (list.length === 0) {
        // Nothing to cycle through: hold focus on the container itself.
        e.preventDefault();
        root.focus();
        return;
      }
      const first = list[0]!;
      const last = list[list.length - 1]!;
      // Focus outside the container entirely (moved programmatically, or the
      // browser reset it to <body>) is pulled back to the near edge.
      if (active === null || !root.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      // (PwrGit fix 4.) The container itself: ChatApprovalModal focuses it
      // while submitting, and a click on any dialog's blank area focuses its
      // tabIndex=-1 container. It is inside but on neither edge, so the
      // browser walked Shift+Tab backwards out of the dialog.
      if (active === root) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      const at = openTraps.indexOf(trap);
      if (at !== -1) openTraps.splice(at, 1);
    };
  }, [open, containerRef]);
}
