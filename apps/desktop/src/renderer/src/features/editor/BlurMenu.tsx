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

import { useEffect, useRef, useState, type ReactElement } from "react";
import type { BlurStyle } from "@pwrsnap/shared";
import type { Tool } from "./editor-tools";
import "./BlurMenu.css";

type BlurStyleDef = {
  id: BlurStyle;
  label: string;
  hint: string;
  /** Inline icon — tiny SVG sized for the menu row. */
  icon: ReactElement;
};

const BLUR_STYLES: ReadonlyArray<BlurStyleDef> = [
  {
    id: "gaussian",
    label: "Soft blur",
    hint: "Gaussian smear — good for hiding text while keeping the shape",
    icon: (
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <defs>
          <radialGradient id="ed-blur-soft" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.95" />
            <stop offset="60%" stopColor="currentColor" stopOpacity="0.55" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect x="1" y="1" width="14" height="14" rx="2.5" fill="url(#ed-blur-soft)" />
      </svg>
    )
  },
  {
    id: "pixelate",
    label: "Pixelate",
    hint: "Chunky mosaic — the classic censored look",
    icon: (
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
    )
  },
  {
    id: "redact",
    label: "Redact",
    hint: "Solid black bar — privacy with zero info leak",
    icon: (
      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
        <rect x="1" y="5" width="14" height="6" rx="1" />
      </svg>
    )
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

  return (
    <div className="ed-blur" ref={rootRef}>
      <button
        type="button"
        className={
          "psl__et-btn ed-blur-btn" +
          (isActive ? " is-active" : "") +
          (open ? " is-open" : "")
        }
        aria-haspopup="menu"
        aria-expanded={open}
        title="Blur · click to pick a style"
        onClick={() => {
          // Always activate the Blur tool when this button is clicked.
          // Also toggle the menu so a single click both selects the
          // tool AND lets the user pick a style if they want a
          // different one. Outside-click closes without changing tool.
          onChange(BLUR_TOOL_ID);
          setOpen((o) => !o);
        }}
      >
        {/* Current style's icon as the button glyph so the user can
            tell at a glance which style is staged. */}
        <span className="ed-blur-btn-icon" aria-hidden="true">
          {selected.icon}
        </span>
        <span>Blur</span>
        <span className="psl__et-btn-key">B</span>
      </button>
      {open && (
        <div className="ed-blur-menu" role="menu">
          {BLUR_STYLES.map((s) => (
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
                {s.icon}
              </span>
              <span className="ed-blur-row-body">
                <span className="ed-blur-row-label">{s.label}</span>
                <span className="ed-blur-row-hint">{s.hint}</span>
              </span>
            </button>
          ))}
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
