// Small inline confirmation popover anchored next to its trigger button.
//
// Why this exists
// ───────────────
// Soft-deleting a capture (Move to Trash) used to fire immediately on a
// single click — easy to do by accident, and in Focus mode the editor kept
// showing the (now-deleted) image, so repeated clicks silently trashed
// neighbors. This component gates every trash affordance behind a confirm
// step that pops up RIGHT NEXT TO the button (minimal mouse/eye travel),
// rather than a centered modal or a native `window.confirm` dialog.
//
// Anchoring: we render the popover into a portal on `document.body` and
// position it with `position: fixed` against the trigger's measured rect.
// A portal + fixed positioning is deliberate — the library grid cells and
// the detail rail both live inside `overflow: hidden` chains, which would
// clip an in-flow popover (see the popover-sizing notes in CLAUDE.md). The
// trigger element is captured from the click event (`currentTarget`), so
// callers only wire an `onClick` — no ref threading.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import "./DeleteConfirm.css";

/** Where the popover sits relative to its trigger. `left` suits the trash
 *  icons pinned to the right edge of grid cells; `top` suits the detail
 *  rail's bottom action row. */
export type DeleteConfirmPlacement = "left" | "top";

export type DeleteConfirmTriggerProps = {
  onClick: (event: ReactMouseEvent) => void;
  "aria-expanded": boolean;
  "aria-haspopup": "dialog";
};

export type DeleteConfirmProps = {
  /** Headline question, e.g. "Move to Trash?". */
  readonly message: string;
  /** Optional second line, e.g. "You can undo this.". */
  readonly detail?: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly placement?: DeleteConfirmPlacement;
  /** Run when the user confirms. The popover closes first, then this fires. */
  readonly onConfirm: () => void;
  /** Render the trigger button. Spread the supplied props onto it; the
   *  `onClick` opens the popover and stops propagation so the click never
   *  also selects/opens the underlying cell. */
  readonly children: (trigger: DeleteConfirmTriggerProps) => ReactNode;
};

const GAP = 8;
const MARGIN = 8;

type Coords = { left: number; top: number };

export function DeleteConfirm({
  message,
  detail,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  placement = "left",
  onConfirm,
  children
}: DeleteConfirmProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<Coords | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setCoords(null);
    anchorRef.current = null;
  }, []);

  const handleTriggerClick = useCallback(
    (event: ReactMouseEvent) => {
      // Stop the grid cell / rail row from also handling the click (which
      // would open Focus on the very capture we're about to trash).
      event.preventDefault();
      event.stopPropagation();
      anchorRef.current = event.currentTarget as HTMLElement;
      setOpen((prev) => !prev);
    },
    []
  );

  // Position against the anchor once the popover has measurable dimensions.
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const pop = popoverRef.current;
    if (anchor === null || pop === null) return;
    const a = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left: number;
    let top: number;
    if (placement === "top") {
      left = a.left + a.width / 2 - w / 2;
      top = a.top - GAP - h;
      if (top < MARGIN) top = a.bottom + GAP; // flip below if no room above
    } else {
      left = a.left - GAP - w;
      top = a.top + a.height / 2 - h / 2;
      if (left < MARGIN) left = a.right + GAP; // flip right if no room left
    }
    left = Math.max(MARGIN, Math.min(left, vw - w - MARGIN));
    top = Math.max(MARGIN, Math.min(top, vh - h - MARGIN));
    setCoords({ left, top });
  }, [open, placement, message, detail]);

  // Focus the confirm button when the popover opens (keyboard-friendly,
  // and an Enter immediately confirms).
  useEffect(() => {
    if (open && coords !== null) confirmBtnRef.current?.focus();
  }, [open, coords]);

  // Dismiss on outside pointer-down, Escape, scroll, or window resize. The
  // opening click already passed (listener attaches after open), so it does
  // not self-close.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target !== null && popoverRef.current?.contains(target) === true) return;
      close();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    const onScrollOrResize = (): void => close();
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open, close]);

  const confirm = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      close();
      onConfirm();
    },
    [close, onConfirm]
  );

  const cancel = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      close();
    },
    [close]
  );

  return (
    <>
      {children({
        onClick: handleTriggerClick,
        "aria-expanded": open,
        "aria-haspopup": "dialog"
      })}
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            className={`ps-confirm ps-confirm--${placement}`}
            role="dialog"
            aria-label={message}
            style={{
              left: coords?.left ?? 0,
              top: coords?.top ?? 0,
              visibility: coords === null ? "hidden" : "visible"
            }}
            // Inside-popover clicks must not bubble to the cell/rail behind.
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ps-confirm__msg">{message}</div>
            {detail !== undefined && <div className="ps-confirm__detail">{detail}</div>}
            <div className="ps-confirm__actions">
              <button type="button" className="ps-confirm__btn" onClick={cancel}>
                {cancelLabel}
              </button>
              <button
                ref={confirmBtnRef}
                type="button"
                className="ps-confirm__btn is-danger"
                onClick={confirm}
              >
                {confirmLabel}
              </button>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
