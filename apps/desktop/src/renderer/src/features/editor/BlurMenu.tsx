// Toolbar button + popover for the Blur tool. Replaces the plain
// Blur tool button in the floating EditToolbar (Library mode). Two
// behaviors fused into one button:
//
//   • Click → switch the active tool to "blur" (so the user can
//     immediately drag a region).
//   • Click → toggle the popover so the user can pick a style
//     (gaussian / pixelate / redact). Selecting closes the popover.
//
// Picking a style updates the lifted blurStyle state in Library; the
// Editor commits new blur overlays with that style at drag-release.
// Existing overlays keep the style they were committed with.
//
// Architecture mirrors ZoomMenu: own .css with neutral `ed-blur-*`
// classes so both Library (loaded css) and standalone editor windows
// pick up the styling through the component import.

import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import type { BlurStyle } from "@pwrsnap/shared";
import type { Tool } from "./editor-tools";
import "./BlurMenu.css";

// Per-style icon components. Kept as small components (not static
// JSX in BLUR_STYLES) because the gaussian icon needs a SVG
// <radialGradient> with a unique `id` — duplicate ids in the DOM
// when the menu is open (button + row both rendering the gaussian
// glyph) is invalid SVG, and the browser picks one fill at random
// for any `url(#…)` reference. useId() makes each render unique.

function GaussianIcon(): ReactElement {
  const gradId = useId();
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <defs>
        <radialGradient id={gradId} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.95" />
          <stop offset="60%" stopColor="currentColor" stopOpacity="0.55" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x="1" y="1" width="14" height="14" rx="2.5" fill={`url(#${gradId})`} />
    </svg>
  );
}

function PixelateIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
      <rect x="1" y="1" width="4" height="4" />
      <rect x="6" y="1" width="4" height="4" opacity="0.55" />
      <rect x="11" y="1" width="4" height="4" />
      <rect x="1" y="6" width="4" height="4" opacity="0.55" />
      <rect x="6" y="6" width="4" height="4" />
      <rect x="11" y="6" width="4" height="4" opacity="0.55" />
      <rect x="1" y="11" width="4" height="4" />
      <rect x="6" y="11" width="4" height="4" opacity="0.55" />
      <rect x="11" y="11" width="4" height="4" />
    </svg>
  );
}

function RedactIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
      <rect x="1" y="5" width="14" height="6" rx="1" />
    </svg>
  );
}

type BlurStyleDef = {
  id: BlurStyle;
  label: string;
  hint: string;
  /** Render fn so each call site (button glyph + every menu row) gets
   *  a fresh React tree — useId() inside the gaussian icon then
   *  scopes its SVG gradient id per render. */
  Icon: () => ReactElement;
};

const BLUR_STYLES: ReadonlyArray<BlurStyleDef> = [
  {
    id: "gaussian",
    label: "Soft blur",
    hint: "Gaussian smear — good for hiding text while keeping the shape",
    Icon: GaussianIcon
  },
  {
    id: "pixelate",
    label: "Pixelate",
    hint: "Chunky mosaic — the classic censored look",
    Icon: PixelateIcon
  },
  {
    id: "redact",
    label: "Redact",
    hint: "Solid black bar — privacy with zero info leak",
    Icon: RedactIcon
  }
];

const BLUR_TOOL_ID: Tool = "blur";

export function BlurMenu({
  tool,
  onChange,
  blurStyle,
  onBlurStyleChange
}: {
  tool: Tool;
  onChange: (tool: Tool) => void;
  blurStyle: BlurStyle;
  onBlurStyleChange: (style: BlurStyle) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Escape — same shape as ZoomMenu.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent | TouchEvent): void {
      const root = rootRef.current;
      if (root === null) return;
      if (e.target instanceof Node && root.contains(e.target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const isActive = tool === BLUR_TOOL_ID;
  const selected = BLUR_STYLES.find((s) => s.id === blurStyle) ?? BLUR_STYLES[0]!;
  const SelectedIcon = selected.Icon;

  return (
    <div className="ed-blur" ref={rootRef}>
      <button
        type="button"
        className={
          "ed-blur-btn" + (isActive ? " is-active" : "") + (open ? " is-open" : "")
        }
        aria-haspopup="menu"
        aria-expanded={open}
        title="Blur"
        onClick={() => {
          // Two behaviors, gated on whether Blur was already the
          // active tool:
          //   - First click (tool was something else) → activate Blur
          //     only. No menu pop — matches Arrow / Rect / Highlight /
          //     Text behavior where the first click is just tool
          //     selection. Lets the user start drawing immediately
          //     with whatever style they had staged.
          //   - Subsequent click on the same button (tool is already
          //     Blur) → toggle the style menu. Same "click the active
          //     tool twice to configure it" pattern that the unified
          //     ToolStylePopover uses via its caret. Outside-click
          //     closes without changing tool.
          //
          // Earlier shape opened the menu on EVERY click — that's a
          // UX inconsistency the user flagged in 3.4 smoke testing
          // ("Arrow and Text don't open the menu when you click the
          // button the first time. Blur does.").
          const wasActive = isActive;
          onChange(BLUR_TOOL_ID);
          if (wasActive) {
            setOpen((o) => !o);
          }
        }}
      >
        {/* Current style's icon as the button glyph so the user can
            tell at a glance which style is staged. */}
        <span className="ed-blur-btn-icon" aria-hidden="true">
          <SelectedIcon />
        </span>
        <span>Blur</span>
        <span className="ed-blur-btn-key">B</span>
      </button>
      {open && (
        <div className="ed-blur-menu" role="menu">
          {BLUR_STYLES.map((s) => {
            const RowIcon = s.Icon;
            return (
              <button
                key={s.id}
                type="button"
                role="menuitemradio"
                aria-checked={blurStyle === s.id}
                className={"ed-blur-row" + (blurStyle === s.id ? " is-selected" : "")}
                onClick={() => {
                  onBlurStyleChange(s.id);
                  setOpen(false);
                }}
              >
                <Check show={blurStyle === s.id} />
                <span className="ed-blur-row-icon" aria-hidden="true">
                  <RowIcon />
                </span>
                <span className="ed-blur-row-body">
                  <span className="ed-blur-row-label">{s.label}</span>
                  <span className="ed-blur-row-hint">{s.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Check({ show }: { show: boolean }): ReactElement {
  return (
    <span className="ed-blur-check" aria-hidden="true">
      {show ? (
        <svg
          width="10"
          height="8"
          viewBox="0 0 10 8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m1 4 3 3 5-6" />
        </svg>
      ) : null}
    </span>
  );
}
