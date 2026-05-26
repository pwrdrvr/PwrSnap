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

/** Pure SVG glyph: a rounded square with three vertical columns.
 *  The "active" column for the kind is filled when `open`; the other
 *  two columns are always shown as outlines so the icon remains
 *  recognizable in either state. */
function LayoutGlyph({
  kind,
  open
}: {
  kind: "primary" | "secondary";
  open: boolean;
}): ReactElement {
  // Layout (viewBox 24x24):
  //   • Outer frame:       (2,2) → (22,22), rx=4
  //   • Left column fill:  (4,4)  → (9,20)
  //   • Right column fill: (15,4) → (20,20)
  // Each column is ~5 units wide; center stays bordered as the
  // "main pane" affordance.
  const fillLeft = kind === "primary" && open;
  const fillRight = kind === "secondary" && open;
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
      {/* Vertical separators marking the column boundaries. */}
      <path d="M9 4v16" />
      <path d="M15 4v16" />
      {fillLeft && (
        <rect
          x="3.5"
          y="4.5"
          width="5"
          height="15"
          rx="1.5"
          fill="currentColor"
          stroke="none"
        />
      )}
      {fillRight && (
        <rect
          x="15.5"
          y="4.5"
          width="5"
          height="15"
          rx="1.5"
          fill="currentColor"
          stroke="none"
        />
      )}
    </svg>
  );
}
