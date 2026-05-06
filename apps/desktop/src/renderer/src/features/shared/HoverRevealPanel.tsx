// Hover-reveal side panel — PwrAgnt's ThreadContextPanel pattern,
// extracted as a reusable shell. Side rail that can be pinned (takes
// a layout column) or auto-hide (collapsed to a 48px spine; mouseenter
// expands it over the canvas).
//
// Originally lived inside Library.tsx (commit b9296ea), then was
// extracted in Phase B of the library three-state plan
// (docs/plans/2026-05-05-001-feat-library-three-state-view-model-plan.md)
// because the Library's new design doesn't need the pin/auto-hide
// toggle — the rail is always visible in Focus / Reel and absent in
// Grid. The pattern is house style though, so it lives here for
// future surfaces (sizzle composer, Phase 4 status panel, future
// inspector pane).
//
// Visual states (carried via class on the root <aside>):
//   • is-pinned   — rail occupies its grid column, always visible
//   • is-collapsed — only the 48px spine sticks out; panel slid out
//   • is-open     — auto-hide mode, but currently hovered/focused
//                   so the panel is visible (hover-reveal)
//
// The component is controlled on `pinned`. Internal `revealed` state
// is non-controlled — the parent doesn't usually care whether the
// hover-reveal is currently open or not.

import { useCallback, useRef, useState, type ReactElement, type ReactNode } from "react";

const HIDE_DEBOUNCE_MS = 200;

export type HoverRevealPanelProps = {
  /** Whether the panel is pinned (always visible, takes layout
   *  column). When false, the panel collapses to a 48px spine and
   *  auto-shows on hover/focus. */
  readonly pinned: boolean;
  /** Called when the user clicks the spine while pinned (request to
   *  unpin) or — by convention — when an in-content button asks to
   *  toggle. Parent owns the source of truth. */
  readonly onPinnedChange: (pinned: boolean) => void;
  /** Accessibility label for the rail's outer aside element. */
  readonly ariaLabel?: string;
  /** Panel content — typically a header with a Pin/Unpin button +
   *  body. Parent renders the in-panel pin/unpin control if it
   *  wants one; the spine button is owned by this component. */
  readonly children: ReactNode;
};

export function HoverRevealPanel({
  pinned,
  onPinnedChange,
  ariaLabel,
  children
}: HoverRevealPanelProps): ReactElement {
  const [revealed, setRevealed] = useState(false);
  const open = pinned || revealed;
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Debounced reveal/hide prevents flicker from CSS transform
  // transitions spawning spurious mouseenter→mouseleave sequences
  // (the rail visibly moves under the cursor as it expands).
  const revealRail = useCallback(() => {
    if (hideTimerRef.current !== undefined) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = undefined;
    }
    setRevealed(true);
  }, []);
  const hideRail = useCallback(() => {
    if (hideTimerRef.current !== undefined) {
      clearTimeout(hideTimerRef.current);
    }
    hideTimerRef.current = setTimeout(() => {
      setRevealed(false);
      hideTimerRef.current = undefined;
    }, HIDE_DEBOUNCE_MS);
  }, []);

  // Spine button: when pinned, click unpins. When auto-hide, click
  // reveals (also keyboard-accessible — clicking the spine is the
  // only way for keyboard users to open the panel since they can't
  // mouseover).
  const onSpineClick = useCallback(() => {
    if (pinned) {
      onPinnedChange(false);
      if (hideTimerRef.current !== undefined) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = undefined;
      }
      setRevealed(false);
      return;
    }
    revealRail();
  }, [pinned, onPinnedChange, revealRail]);

  return (
    <aside
      className={
        "hover-reveal-panel" +
        (pinned ? " is-pinned" : open ? " is-open" : " is-collapsed")
      }
      aria-label={ariaLabel}
      onMouseEnter={() => {
        if (!pinned) revealRail();
      }}
      onMouseLeave={() => {
        if (!pinned) hideRail();
      }}
      onFocusCapture={() => {
        if (!pinned) revealRail();
      }}
      onBlurCapture={(event) => {
        if (!pinned && !event.currentTarget.contains(event.relatedTarget as Node | null)) {
          hideRail();
        }
      }}
    >
      {/* Spine — only visible when collapsed. 48px wide vertical
          strip on the panel's outer edge. The hamburger button is
          a mouse-target hint; the entire rail also reveals on
          mouseenter, so users rarely click it. */}
      <div className="hover-reveal-panel__spine">
        <button
          type="button"
          className={"hover-reveal-panel__menu-button" + (open ? " is-active" : "")}
          aria-label={pinned ? "Unpin panel" : "Open panel"}
          onClick={onSpineClick}
        >
          <span className="hover-reveal-panel__menu-glyph" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </button>
      </div>

      <div className="hover-reveal-panel__panel">{children}</div>
    </aside>
  );
}
