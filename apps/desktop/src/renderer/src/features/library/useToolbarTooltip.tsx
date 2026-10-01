// Hover tooltips for the edit toolbar and its property bar.
//
// The toolbar's buttons are icons, so the tooltip is how you learn what a
// slot does — and the native `title` tooltip was too slow to be that. In
// Electron on macOS it waited out the system delay and restarted it on
// every pointer move, so a slot often took ~3s of holding still to say
// anything. This shows after DELAY_MS, and once one is up, moving to the
// next button swaps it immediately (the way native menus and toolbars
// behave), so scanning along the bag reads each slot in turn.
//
// One delegated listener set on the dock root; a button opts in with
//
//   data-tip         the first line (the button's name)
//   data-tip-keys    optional key chip beside it ("2", "A")
//   data-tip-detail  optional further lines, separated by "\n"
//
// and must NOT also carry `title`, or the slow native tooltip shows too.
//
// It never takes a key: any keydown hides it and the key carries on to
// whoever owns it (1–9 arm a slot, Escape belongs to the editor).

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type RefObject
} from "react";
import { createPortal } from "react-dom";

const DELAY_MS = 350;
/** After a tooltip hides, the next one within this window shows at once. */
const WARM_MS = 400;
const GAP_PX = 8;
const EDGE_PX = 8;

type Tip = {
  readonly anchor: HTMLElement;
  readonly title: string;
  readonly keys: string | null;
  readonly detail: readonly string[];
};

const TOOLTIP_ID = "psl-toolbar-tip";

function readTip(anchor: HTMLElement): Tip {
  return {
    anchor,
    title: anchor.dataset.tip ?? "",
    keys: anchor.dataset.tipKeys ?? null,
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

export function useToolbarTooltip(rootRef: RefObject<HTMLElement | null>): ReactElement | null {
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    let timer: number | undefined;
    let current: HTMLElement | null = null;
    let warmUntil = 0;

    const tipTarget = (target: EventTarget | null): HTMLElement | null => {
      if (!(target instanceof Element)) return null;
      const el = target.closest<HTMLElement>("[data-tip]");
      return el !== null && root.contains(el) ? el : null;
    };
    const show = (el: HTMLElement): void => {
      window.clearTimeout(timer);
      current = el;
      setTip(readTip(el));
    };
    const hide = (warm: boolean): void => {
      window.clearTimeout(timer);
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
      // Moving onto another tipped button is the pointerover's to handle.
      if (tipTarget(event.relatedTarget) !== null) return;
      hide(true);
    };
    const onFocusIn = (event: FocusEvent): void => {
      const el = tipTarget(event.target);
      // Keyboard focus only; a click focuses the button too, and a
      // tooltip popping up under the click is noise.
      if (el !== null && isFocusVisible(el)) show(el);
    };
    const onFocusOut = (event: FocusEvent): void => {
      if (current !== null && event.target === current) hide(false);
    };
    const onPointerDown = (): void => hide(false);
    const onKeyDown = (): void => hide(false);

    root.addEventListener("pointerover", onPointerOver);
    root.addEventListener("pointerout", onPointerOut);
    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("focusout", onFocusOut);
    root.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onPointerDown);
    return () => {
      window.clearTimeout(timer);
      root.removeEventListener("pointerover", onPointerOver);
      root.removeEventListener("pointerout", onPointerOut);
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", onFocusOut);
      root.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onPointerDown);
    };
  }, [rootRef]);

  // The tooltip is the anchor's description while it is up.
  useEffect(() => {
    if (tip === null) return;
    const { anchor } = tip;
    anchor.setAttribute("aria-describedby", TOOLTIP_ID);
    return () => anchor.removeAttribute("aria-describedby");
  }, [tip]);

  // An anchor that leaves the document (a re-render replaced it) takes
  // its tooltip with it.
  useEffect(() => {
    if (tip !== null && !tip.anchor.isConnected) setTip(null);
  });

  if (tip === null) return null;
  return createPortal(<ToolbarTooltip tip={tip} />, document.body);
}

function ToolbarTooltip({ tip }: { tip: Tip }): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    // Screen placement, so the post-transform rect is the right one, read
    // at the moment of showing.
    const a = tip.anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const above = a.top - GAP_PX - h;
    const top = above >= EDGE_PX ? above : a.bottom + GAP_PX;
    const left = Math.min(
      Math.max(a.left + a.width / 2 - w / 2, EDGE_PX),
      Math.max(EDGE_PX, window.innerWidth - w - EDGE_PX)
    );
    setPos({ left, top });
  }, [tip]);

  return (
    <div
      ref={ref}
      id={TOOLTIP_ID}
      role="tooltip"
      className="psl-tip"
      data-testid="toolbar-tooltip"
      style={
        pos === null
          ? { left: 0, top: 0, visibility: "hidden" }
          : { left: `${pos.left}px`, top: `${pos.top}px` }
      }
    >
      <div className="psl-tip__title">
        <span>{tip.title}</span>
        {tip.keys !== null && <kbd className="psl-tip__key">{tip.keys}</kbd>}
      </div>
      {tip.detail.map((line) => (
        <div key={line} className="psl-tip__line">
          {line}
        </div>
      ))}
    </div>
  );
}
