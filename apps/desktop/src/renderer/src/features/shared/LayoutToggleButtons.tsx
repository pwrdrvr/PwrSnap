// LayoutToggleButtons — VS Code-style title-bar layout chips.
//
// Two buttons that toggle the primary (left) and secondary (right)
// side bars of a window. Same visual language as VS Code's title-bar
// layout controls:
//
//   • Three columns drawn inside the icon: outer-left, center,
//     outer-right.
//   • When the bar is OPEN, its column is filled with the active
//     accent fill.
//   • When the bar is CLOSED, its column is just an outline.
//
// Keyboard shortcuts:
//   • ⌘B / ⌃B — toggle primary (left)
//   • ⌘⌥B / ⌃⌥B — toggle secondary (right)
//
// Both shortcuts respect the same "in-editable-element bail" rule the
// editor's keyboard handler uses — typing in a search box or textarea
// must not steal the chord.
//
// The component itself is presentational. The parent owns the
// pin/open state and the handlers; the buttons just paint the chosen
// state and dispatch callbacks. This keeps the surface portable
// (Library top bar today; potentially the Editor's titlebar tomorrow).

import { useEffect, type ReactElement } from "react";

export interface LayoutToggleButtonsProps {
  /** Whether the primary (left) bar is currently open. */
  readonly primaryOpen: boolean;
  /** Whether the secondary (right) bar is currently open. */
  readonly secondaryOpen: boolean;
  /** Fires on click OR keyboard shortcut (⌘B). */
  readonly onTogglePrimary: () => void;
  /** Fires on click OR keyboard shortcut (⌘⌥B). */
  readonly onToggleSecondary: () => void;
  /** Optional className for the outer wrapper. */
  readonly className?: string;
  /** Optional test-id prefix. Defaults to `layout-toggle`. The buttons
   *  render as `${prefix}-primary` and `${prefix}-secondary`. */
  readonly testIdPrefix?: string;
  /** When true, the window-level keydown listener is NOT installed —
   *  for callers that own keyboard handling at a higher level. */
  readonly disableHotkeys?: boolean;
}

function isPrimaryAccel(event: KeyboardEvent): boolean {
  if (typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform)) {
    return event.metaKey === true;
  }
  return event.ctrlKey === true;
}

function isEditableTarget(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (target === null) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable === true
  );
}

export function LayoutToggleButtons({
  primaryOpen,
  secondaryOpen,
  onTogglePrimary,
  onToggleSecondary,
  className,
  testIdPrefix = "layout-toggle",
  disableHotkeys = false
}: LayoutToggleButtonsProps): ReactElement {
  useEffect(() => {
    if (disableHotkeys) return;
    const handler = (event: KeyboardEvent): void => {
      if (isEditableTarget(event)) return;
      if (!isPrimaryAccel(event)) return;
      // Both shortcuts use `b` (case-insensitive); the modifier
      // distinguishes which bar.
      if (event.key !== "b" && event.key !== "B") return;
      event.preventDefault();
      if (event.altKey) {
        onToggleSecondary();
      } else {
        onTogglePrimary();
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
    };
  }, [disableHotkeys, onTogglePrimary, onToggleSecondary]);

  const rootClass =
    "lyt-toggle" +
    (className !== undefined && className !== "" ? ` ${className}` : "");

  return (
    <div className={rootClass} role="group" aria-label="Window layout">
      <LayoutChip
        kind="primary"
        open={primaryOpen}
        onClick={onTogglePrimary}
        testId={`${testIdPrefix}-primary`}
      />
      <LayoutChip
        kind="secondary"
        open={secondaryOpen}
        onClick={onToggleSecondary}
        testId={`${testIdPrefix}-secondary`}
      />
    </div>
  );
}

interface LayoutChipProps {
  kind: "primary" | "secondary";
  open: boolean;
  onClick: () => void;
  testId: string;
}

function LayoutChip({ kind, open, onClick, testId }: LayoutChipProps): ReactElement {
  const label =
    kind === "primary"
      ? open
        ? "Hide primary side bar"
        : "Show primary side bar"
      : open
        ? "Hide secondary side bar"
        : "Show secondary side bar";
  // VS Code uses the modifier in tooltips; we match.
  const chord = kind === "primary" ? "⌘B" : "⌘⌥B";
  return (
    <button
      type="button"
      className={
        "lyt-toggle__chip" +
        ` is-${kind}` +
        (open ? " is-open" : " is-closed")
      }
      aria-label={label}
      aria-pressed={open}
      title={`${label}  (${chord})`}
      data-testid={testId}
      data-open={open ? "true" : "false"}
      onClick={onClick}
    >
      <LayoutGlyph kind={kind} open={open} />
    </button>
  );
}

/** Pure SVG glyph: a rounded square with ONE off-center vertical
 *  divider. The primary chip draws its divider on the LEFT (carving
 *  off a thin left-side strip — the "primary side bar" — from the
 *  main content area); the secondary chip mirrors it on the RIGHT.
 *  When the bar is open, the thin strip fills with `currentColor`
 *  so the icon reads as "this side has a side bar AND it's showing
 *  right now"; when closed, only the outline remains.
 *
 *  Why asymmetric instead of the prior 3-column glyph: with three
 *  equal columns the left and right chips were visually
 *  indistinguishable at a glance — both icons rendered the same
 *  rounded square with two interior verticals, and only the fill
 *  position changed. Splitting the icon ~20/80 makes "primary" and
 *  "secondary" identifiable from the divider position alone, even
 *  in the closed state. Same pattern Apple and VS Code use for
 *  their side bar chips.
 */
function LayoutGlyph({
  kind,
  open
}: {
  kind: "primary" | "secondary";
  open: boolean;
}): ReactElement {
  // Layout (viewBox 24x24):
  //   • Outer frame:      (2.5, 3.5) → (21.5, 20.5), rx=3
  //   • Inner usable area: 19 × 17 (between 2.5..21.5 / 3.5..20.5)
  //   • Side-bar strip:    ~28% of inner width → 5.3 units. We use
  //                        5.5 for crisp pixel alignment at 14×14.
  //   • Primary divider:   x = 8 (carves left strip 2.5..8)
  //   • Secondary divider: x = 16 (carves right strip 16..21.5)
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2.5" y="3.5" width="19" height="17" rx="3" />
      {kind === "primary" ? (
        <>
          <path d="M8 4v16" />
          {open && (
            <rect
              x="3"
              y="4"
              width="5"
              height="16"
              rx="1.5"
              fill="currentColor"
              stroke="none"
            />
          )}
        </>
      ) : (
        <>
          <path d="M16 4v16" />
          {open && (
            <rect
              x="16"
              y="4"
              width="5"
              height="16"
              rx="1.5"
              fill="currentColor"
              stroke="none"
            />
          )}
        </>
      )}
    </svg>
  );
}
