// The app's hover tooltip: fast, and the only one an icon-only control gets.
//
// For a control drawn as an icon, the tooltip is the only label a sighted
// user gets, and the native `title` tooltip was too slow to be that. In
// Electron on macOS it waits out the system delay and restarts it on every
// pointer move, so a button often took ~3s of holding still to say
// anything. This shows after DELAY_MS, and once one is up, moving to the
// next control swaps it immediately (the way native menus and toolbars
// behave), so scanning along a row of icons reads each in turn.
//
// One instance per window: `App` mounts it once, and its delegated listeners
// sit on `document`, so every surface in the window (and everything portaled
// to <body>) is covered with no wiring. A control opts in with
//
//   data-tip         the first line (what the control does)
//   data-tip-keys    optional key chip beside it ("2", "Esc")
//   data-tip-detail  optional further lines, separated by "\n"
//
// and must NOT also carry `title`, nor sit inside an element that does, or
// the slow native tooltip shows as well. `__tests__/fast-tooltip-contract.test.ts`
// enforces both.
//
// The tooltip is a DESCRIPTION, never the name: the control still needs an
// `aria-label` or visible text. While it is up it is added to the anchor's
// `aria-describedby`, unless all it would say is the name again.
//
// It never takes a key: any keydown hides it (an Escape an overlay claimed,
// on its keyup) and the key carries on to whoever owns it. Those listeners
// are on `document` capture, NOT `window` capture: the focus hooks' Escape
// listener must stay the first window-capture keydown listener
// (lib/AGENTS.md, "Escape: one owner").
//
// Where the native tooltip is still the right one, see lib/AGENTS.md
// ("Hover tooltips").

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement
} from "react";
import { createPortal } from "react-dom";

const DELAY_MS = 350;
/** After a tooltip hides, the next one within this window shows at once. */
const WARM_MS = 400;
/** Space between the anchor and the tooltip. Must stay larger than
 *  RING_REACH_PX, so a tooltip shown on keyboard focus never covers the
 *  focus ring it is describing. */
export const GAP_PX = 8;
/** How far a focus indicator reaches outside its control: the global ring
 *  is 2px drawn 1px out, and the media halo is a 4px box-shadow (root
 *  AGENTS.md, "Focus rings"). */
export const RING_REACH_PX = 4;
const EDGE_PX = 8;

const TOOLTIP_ID = "ps-fast-tip";
const TIP_SELECTOR = '[data-tip]:not([data-tip=""])';

type Tip = {
  readonly anchor: HTMLElement;
  readonly title: string;
  readonly keys: string | null;
  readonly detail: readonly string[];
};

function readTip(anchor: HTMLElement): Tip {
  const keys = anchor.dataset.tipKeys;
  return {
    anchor,
    title: anchor.dataset.tip ?? "",
    keys: keys === undefined || keys === "" ? null : keys,
    detail: (anchor.dataset.tipDetail ?? "").split("\n").filter((line) => line !== "")
  };
}

function isFocusVisible(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return false;
  }
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Would describing the anchor with this tip only repeat its name? Then a
 *  screen reader would read the name twice, so the tip is not linked. */
function tipRepeatsName(tip: Tip): boolean {
  if (tip.keys !== null || tip.detail.length > 0) return false;
  const name = tip.anchor.getAttribute("aria-label") ?? tip.anchor.textContent ?? "";
  return normalize(name) === normalize(tip.title);
}

/** Where the tooltip goes: above the anchor, else below, else whichever
 *  side has more room, centred and clamped to the viewport sideways.
 *  Never clamped vertically: pushed back over the anchor, it would cover
 *  the focus ring of the control it describes. Running off the window's
 *  edge is the lesser failure. */
export function placeTooltip(
  anchor: { top: number; bottom: number; left: number; width: number },
  tip: { width: number; height: number },
  viewport: { width: number; height: number }
): { left: number; top: number } {
  const roomAbove = anchor.top - GAP_PX - EDGE_PX;
  const roomBelow = viewport.height - anchor.bottom - GAP_PX - EDGE_PX;
  const below =
    roomAbove < tip.height && (roomBelow >= tip.height || roomBelow > roomAbove);
  const top = below ? anchor.bottom + GAP_PX : anchor.top - GAP_PX - tip.height;
  const left = Math.min(
    Math.max(anchor.left + anchor.width / 2 - tip.width / 2, EDGE_PX),
    Math.max(EDGE_PX, viewport.width - tip.width - EDGE_PX)
  );
  return { left, top };
}

let installed = 0;

/** Mount once per window (`App` does). Returns the portaled tooltip. */
export function useFastTooltip(): ReactElement | null {
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    installed += 1;
    if (installed > 1) {
      // Two instances would both answer every hover with a tooltip of the
      // same id. The first one already covers the whole window.
      console.error("useFastTooltip: mounted twice in one window; App owns it");
      return () => {
        installed -= 1;
      };
    }
    let timer: number | undefined;
    let current: HTMLElement | null = null;
    let warmUntil = 0;
    // An anchor that leaves the document (a re-render replaced it, its row
    // was deleted) takes its tooltip with it. Nothing else would tell us:
    // the pointer never "left" an element that is simply gone. Watched
    // only while a tooltip is up, and through `hide`, so `current` and the
    // rendered tip can never disagree.
    let removal: MutationObserver | null = null;

    const tipTarget = (target: EventTarget | null): HTMLElement | null => {
      if (!(target instanceof Element)) return null;
      return target.closest<HTMLElement>(TIP_SELECTOR);
    };
    const show = (el: HTMLElement): void => {
      window.clearTimeout(timer);
      current = el;
      removal?.disconnect();
      removal = new MutationObserver(() => {
        if (!el.isConnected) hide(false);
      });
      removal.observe(document.body, { childList: true, subtree: true });
      setTip(readTip(el));
    };
    const hide = (warm: boolean): void => {
      window.clearTimeout(timer);
      removal?.disconnect();
      removal = null;
      warmUntil = warm && current !== null ? performance.now() + WARM_MS : 0;
      current = null;
      setTip(null);
    };
    const arm = (el: HTMLElement): void => {
      if (current !== null || performance.now() < warmUntil) {
        show(el);
        return;
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(() => show(el), DELAY_MS);
    };

    const onPointerOver = (event: PointerEvent): void => {
      const el = tipTarget(event.target);
      if (el === null || el === current) return;
      arm(el);
    };
    const onPointerOut = (event: PointerEvent): void => {
      const leaving = tipTarget(event.target);
      if (leaving === null) return;
      // Moving onto another tipped control is the pointerover's to handle,
      // and moving within this one changes nothing.
      if (tipTarget(event.relatedTarget) !== null) return;
      hide(true);
    };
    const onFocusIn = (event: FocusEvent): void => {
      const el = tipTarget(event.target);
      // Keyboard focus only; a click focuses the button too, and a
      // tooltip popping up under the click is noise.
      if (el !== null && event.target instanceof Element && isFocusVisible(event.target)) {
        show(el);
      }
    };
    const onFocusOut = (event: FocusEvent): void => {
      if (current !== null && event.target instanceof Node && current.contains(event.target)) {
        hide(false);
      }
    };
    const onPress = (): void => hide(false);
    // An Escape an overlay claimed never reaches `keydown` here:
    // useDismissable stops it at window capture. Its keyup is not claimed.
    // Escape only: a Tab's keyup lands after the focus it moved has shown
    // the next control's tooltip.
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === "Escape") hide(false);
    };

    document.addEventListener("pointerover", onPointerOver);
    document.addEventListener("pointerout", onPointerOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("pointerdown", onPress, true);
    // Document, not window: see the header.
    document.addEventListener("keydown", onPress, true);
    document.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onPress);
    return () => {
      installed -= 1;
      window.clearTimeout(timer);
      removal?.disconnect();
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointerout", onPointerOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("pointerdown", onPress, true);
      document.removeEventListener("keydown", onPress, true);
      document.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onPress);
    };
  }, []);

  // The tooltip describes the anchor while it is up. Added to whatever
  // description the anchor already carries, and on hide only our own
  // token comes out: React may have changed the rest meanwhile (an export
  // card gains and drops its progress id), and restoring a snapshot would
  // write back a value React believes is gone.
  useEffect(() => {
    if (tip === null || tipRepeatsName(tip)) return;
    const { anchor } = tip;
    const tokens = (): string[] =>
      (anchor.getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .filter((t) => t !== "" && t !== TOOLTIP_ID);
    anchor.setAttribute("aria-describedby", [...tokens(), TOOLTIP_ID].join(" "));
    return () => {
      const rest = tokens();
      if (rest.length === 0) anchor.removeAttribute("aria-describedby");
      else anchor.setAttribute("aria-describedby", rest.join(" "));
    };
  }, [tip]);

  if (tip === null) return null;
  return createPortal(<FastTooltip tip={tip} />, document.body);
}

function FastTooltip({ tip }: { tip: Tip }): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const measure = (): void => {
      const el = ref.current;
      if (el === null) return;
      // Screen placement, so the post-transform rect is the right one,
      // re-read every time rather than cached (root AGENTS.md, "Never mix
      // a post-transform rect with a layout measure").
      const next = placeTooltip(
        tip.anchor.getBoundingClientRect(),
        { width: el.offsetWidth, height: el.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight }
      );
      setPos((prev) =>
        prev !== null && prev.left === next.left && prev.top === next.top ? prev : next
      );
    };
    measure();
    // Follow the anchor rather than hide: a control that takes keyboard
    // focus inside a scroller is scrolled into view right after it is
    // focused, and hiding on that scroll would hide every such tooltip.
    document.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      document.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [tip]);

  return (
    <div
      ref={ref}
      id={TOOLTIP_ID}
      role="tooltip"
      className="ps-tip"
      data-testid="fast-tooltip"
      style={
        pos === null
          ? { left: 0, top: 0, visibility: "hidden" }
          : { left: `${pos.left}px`, top: `${pos.top}px` }
      }
    >
      <div className="ps-tip__title">
        <span>{tip.title}</span>
        {tip.keys !== null && <kbd className="ps-tip__key">{tip.keys}</kbd>}
      </div>
      {tip.detail.map((line) => (
        <div key={line} className="ps-tip__line">
          {line}
        </div>
      ))}
    </div>
  );
}

/** The window's one tooltip host. Rendered by `App`. */
export function FastTooltipHost(): ReactElement | null {
  return useFastTooltip();
}
