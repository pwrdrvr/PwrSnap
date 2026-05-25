// Unified tool style popover. One outer shell, kind-conditional body
// per active tool (arrow / text / rect / blur / highlight). Replaces
// what would otherwise be 5 sibling popover components — keeps the
// shell (anchor positioning, click-outside, escape, coachmark)
// implementation in one place so any future popover-grade fix lands
// for every tool simultaneously.
//
// Anchor positioning is a simple "right of anchor, 8px gap" computed
// from getBoundingClientRect of the anchor + the popover's own
// measured size. No Floating UI dependency; the anchor + popover live
// in the same renderer window so a recalc on each open is cheap.
//
// Outer `inline-block` measurer (per AGENTS.md "Tray + float-over
// popover sizing" doc): the styled `.pse-popover` carries
// overflow: hidden for border-radius painting; measuring it directly
// would feedback-loop through the clip. The wrapper is a pure layout
// element whose height is content-determined; we observe its rect for
// any ResizeObserver consumer (none today inside the popover, but
// future tunings — e.g. a content-height-driven shadow band — can
// safely subscribe).
//
// Stoplight coachmark: gated by `settings.editor.coachmarks.
// stoplightSeen`. First popover open shows a 3s strip at the top;
// dismissal dispatches `settings:write` to flip the flag true. After
// that, never shown again. The component reads the flag via
// useSettings (same hook the parent toolbar uses) so cross-instance
// state stays consistent.

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type RefObject
} from "react";
import type {
  ArrowEndStyle,
  ArrowStemStyle,
  ArrowToolStyle,
  BlurEffectMode,
  BlurToolStyle,
  ColorToken,
  HighlightBlendMode,
  HighlightToolStyle,
  RectToolStyle,
  TextFontWeight,
  TextToolStyle,
  ToolColor,
  ToolSizePreset
} from "@pwrsnap/shared";
import { COLOR_TOKENS } from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";
import { useSettings } from "../settings/useSettings";

// ---- Public types ---------------------------------------------------

/** The five tool kinds that have a persistent style block. Pointer +
 *  crop are excluded — the parent toolbar simply doesn't mount the
 *  popover for those. */
export type StyledToolKind = "arrow" | "text" | "rect" | "blur" | "highlight";

export type ToolStylePopoverStyle =
  | ArrowToolStyle
  | TextToolStyle
  | RectToolStyle
  | BlurToolStyle
  | HighlightToolStyle;

export interface ToolStylePopoverProps {
  /** Anchor element to position alongside (typically the toolbar's
   *  tool button). Position is right-of-anchor with 8px gap; if the
   *  popover would overflow the viewport's right edge, it flips to
   *  the left. Vertical anchor: top of popover aligned with top of
   *  anchor. */
  anchorRef: RefObject<HTMLElement | null>;
  /** Which tool's style to render. The parent owns the resolution
   *  from `activeStyle.tool`; pointer / crop are filtered out
   *  upstream. */
  tool: StyledToolKind;
  /** Current style block for that tool, typed against the tool kind.
   *  Discriminant matching is the caller's job; this component
   *  narrows internally via a runtime switch on `tool`. */
  style: ToolStylePopoverStyle;
  /** Called on click-outside, Escape, or any caller-driven dismiss
   *  reason. Parent toolbar hides the popover. */
  onClose(): void;
  /** Style change callback. The parent wires this through to
   *  `setStyleField(tool, field, value)` on `useEditorToolState`. */
  onStyleFieldChange<F extends string, V>(field: F, value: V): void;
  /** Phase 3.5 — when set, the popover edits the SELECTED OVERLAY's
   *  style instead of the active tool's defaults. A header strip
   *  appears at the top reading "Editing this <tool>" with an × to
   *  clear the selection. The style picker still reads from the
   *  `style` prop (caller passes the selected overlay's data) and
   *  writes through `onStyleFieldChange` — the caller routes the
   *  field/value pair into `dispatchEdit({kind: "updateOverlay"})`
   *  in selected-overlay mode. */
  selectedOverlayLabel?: string;
  /** Click handler for the header × button. Caller clears the
   *  selection. Required when `selectedOverlayLabel` is set. */
  onClearSelection?: () => void;
}

// ---- Constants ------------------------------------------------------

const POPOVER_OFFSET_PX = 8;
const POPOVER_WIDTH_PX = 280;
const COACHMARK_AUTO_DISMISS_MS = 3000;

const COLOR_LABELS: Record<ColorToken, string> = {
  red: "Red",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  gray: "Gray",
  black: "Black",
  white: "White",
  accent: "Brand accent"
};

const SIZE_PRESETS: ReadonlyArray<{ id: ToolSizePreset; label: string }> = [
  { id: "auto", label: "Auto" },
  { id: "small", label: "S" },
  { id: "medium", label: "M" },
  { id: "large", label: "L" }
];

const END_STYLES: ReadonlyArray<{
  id: ArrowEndStyle;
  label: string;
  Icon: () => ReactElement;
}> = [
  { id: "filled-triangle", label: "Filled triangle", Icon: FilledTriangleIcon },
  { id: "open-triangle", label: "Open triangle", Icon: OpenTriangleIcon },
  { id: "line", label: "Line", Icon: LineIcon },
  { id: "dot", label: "Dot", Icon: DotIcon }
];

const STEM_STYLES: ReadonlyArray<{
  id: ArrowStemStyle;
  label: string;
  dash: string;
}> = [
  { id: "solid", label: "Solid", dash: "0" },
  { id: "dashed", label: "Dashed", dash: "5,3" },
  { id: "dotted", label: "Dotted", dash: "1,3" }
];

const TEXT_WEIGHTS: ReadonlyArray<{ id: TextFontWeight; label: string }> = [
  { id: "regular", label: "Regular" },
  { id: "bold", label: "Bold" }
];

/** Blur mode picker — full rich-card shape (icon + label + hint copy)
 *  rather than a compact segmented control. Brought back from the pre-
 *  fold BlurMenu after the unified-popover refactor flattened it into
 *  a plain segmented row and "felt worse." Each entry pairs a per-mode
 *  glyph component with its label and a short hint describing what the
 *  blur actually does. Selected state mirrors the swatch / icon-row
 *  `.is-on` idiom used elsewhere in the popover (accent border +
 *  accent-soft background). */
const BLUR_MODES: ReadonlyArray<{
  id: BlurEffectMode;
  label: string;
  hint: string;
  Icon: FC;
}> = [
  {
    id: "gaussian",
    label: "Gaussian",
    hint: "Soft Gaussian smear",
    Icon: GaussianBlurIcon
  },
  {
    id: "pixelate",
    label: "Pixelate",
    hint: "Chunky mosaic blocks",
    Icon: PixelateIcon
  },
  {
    id: "redact",
    label: "Redact",
    hint: "Solid black for privacy",
    Icon: RedactIcon
  }
];

const BLEND_MODES: ReadonlyArray<{ id: HighlightBlendMode; label: string }> = [
  { id: "multiply", label: "Multiply" },
  { id: "screen", label: "Screen" },
  { id: "overlay", label: "Overlay" }
];

// ---- Helpers --------------------------------------------------------

/**
 * Compute the popover's `{top, left}` against the viewport. Two-pass:
 *
 *  Pass 1 — `popoverHeight = null`. We don't know the popover's own
 *  measured height yet, so we lay out at the anchor's top in viewport
 *  space (matches the legacy single-pass behavior) AND with a
 *  right-of-anchor horizontal preference.
 *
 *  Pass 2 — `popoverHeight = <measured>`. After the popover renders
 *  once, the layout effect measures its inline-block wrapper and calls
 *  back through here. We now have enough to flip-up when the natural
 *  position would overflow the bottom edge (the regression that bug #1
 *  triggers on the chromeless Library Focus floating bottom toolbar:
 *  anchor near the bottom of the viewport + tall popover = the lower
 *  half is clipped under the window edge).
 *
 *  Vertical flip rules:
 *    • If `top + popoverHeight > viewport.innerHeight - 8`, flip ABOVE
 *      the anchor: `top = anchor.top - popoverHeight - 8`.
 *    • If flipping above ALSO overflows the top, clamp to viewport with
 *      an 8px gutter. (Visual fallback; the alternative would be to
 *      compress the popover, but the body is content-sized via the
 *      inline-block wrapper and a vertical clip would lose options.)
 *
 *  Horizontal flip is unchanged from the legacy single-pass: prefer
 *  right-of-anchor, fall back to left-of-anchor when overflow.
 */
function computeAnchorPosition(
  anchor: HTMLElement,
  popoverWidth: number,
  popoverHeight: number | null
): CSSProperties {
  const rect = anchor.getBoundingClientRect();
  let left = rect.right + POPOVER_OFFSET_PX;
  const viewportWidth =
    typeof window === "undefined" ? popoverWidth : window.innerWidth;
  const viewportHeight =
    typeof window === "undefined"
      ? popoverHeight ?? 0
      : window.innerHeight;
  if (left + popoverWidth > viewportWidth - 8) {
    // Flip to left side of anchor.
    left = Math.max(8, rect.left - POPOVER_OFFSET_PX - popoverWidth);
  }
  let top = rect.top;
  if (popoverHeight !== null) {
    if (top + popoverHeight > viewportHeight - 8) {
      // Flip ABOVE the anchor — typical case for the chromeless Library
      // Focus floating bottom toolbar.
      const flippedTop = rect.top - POPOVER_OFFSET_PX - popoverHeight;
      if (flippedTop >= 8) {
        top = flippedTop;
      } else {
        // Doesn't fit above either. Pick whichever side has more space
        // and clamp to the viewport with an 8px gutter.
        const spaceBelow = viewportHeight - rect.bottom;
        const spaceAbove = rect.top;
        if (spaceAbove > spaceBelow) {
          top = 8;
        } else {
          top = Math.max(8, viewportHeight - 8 - popoverHeight);
        }
      }
    }
  }
  return {
    position: "fixed",
    top: `${top}px`,
    left: `${left}px`,
    width: `${popoverWidth}px`,
    zIndex: 1000
  };
}

function styleHasColor(
  style: ToolStylePopoverStyle
): style is ArrowToolStyle | TextToolStyle | RectToolStyle | HighlightToolStyle {
  return (style as { color?: unknown }).color !== undefined;
}

// ---- Component ------------------------------------------------------

export function ToolStylePopover(props: ToolStylePopoverProps): ReactElement | null {
  const {
    anchorRef,
    tool,
    style,
    onClose,
    onStyleFieldChange,
    selectedOverlayLabel,
    onClearSelection
  } = props;
  const isSelectedMode = selectedOverlayLabel !== undefined;

  const settingsValue = useSettings();
  const stoplightSeen =
    settingsValue.settings === null
      ? true
      : settingsValue.settings.editor.coachmarks.stoplightSeen;

  // Popover root for click-outside detection. The styled inner box is
  // also under this ref so any click within the popover is recognized
  // as inside.
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Outer inline-block measurer ref — measured for the two-pass
  // viewport-edge-aware positioning (see `computeAnchorPosition`).
  // Per AGENTS.md "Tray + float-over popover sizing", we measure the
  // outer inline-block wrapper rather than the styled inner box (which
  // carries `overflow: hidden`) to avoid the clip-loop feedback bug.
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<CSSProperties>({});
  // Coachmark visibility — shown only when settings says so AND only
  // on this open's lifecycle (set during mount effect; cleared at
  // 3s via auto-dismiss timer).
  const [coachmarkVisible, setCoachmarkVisible] = useState<boolean>(false);

  // Position the popover on mount + when anchor moves (e.g. window
  // resize). Two-pass:
  //
  //   Pass 1 runs synchronously here with `popoverHeight = null` —
  //   places the popover at the legacy "right-of-anchor, top aligned"
  //   position so the user sees something on the next commit. Anything
  //   that overflows the viewport edges is invisible momentarily.
  //
  //   Pass 2 runs once the popover has rendered: we measure its
  //   inline-block wrapper (height = natural content), recompute, and
  //   if the position changed (vertical flip-up, horizontal flip-left)
  //   we setState again. The ResizeObserver covers the rare case of
  //   the popover's content changing height while open (e.g. blur
  //   radius "Custom…" expands the numeric input row); a single
  //   recompute on every wrapper-height change keeps the flip honest.
  //
  // Most callers re-mount the popover when the active tool changes,
  // so the pass-1 measurement captures the new tool's content at
  // open.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (anchor === null) return;
    const recompute = (popoverHeight: number | null): void => {
      setPosition(computeAnchorPosition(anchor, POPOVER_WIDTH_PX, popoverHeight));
    };
    // Pass 1 — no height yet.
    recompute(null);
    const measure = (): void => {
      const el = measureRef.current;
      if (el === null) return;
      const h = el.getBoundingClientRect().height;
      if (h > 0) {
        recompute(Math.ceil(h));
      }
    };
    // Pass 2 — measure after first paint. requestAnimationFrame
    // gives the renderer one paint cycle to lay out the body before
    // we read getBoundingClientRect — otherwise we'd read 0 in some
    // synchronous renders before layout has flushed.
    const raf = requestAnimationFrame(measure);
    // Re-measure on content changes (rare; covers the blur "Custom…"
    // expansion + the coachmark dismissing at 3s). Guard for jsdom test
    // environments that don't ship a ResizeObserver — measurement
    // there happens via the explicit `resize` event handler below.
    const ro =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (ro !== null && measureRef.current !== null) ro.observe(measureRef.current);
    const onResize = (): void => measure();
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [anchorRef]);

  // Click-outside + Escape → onClose. Pointerdown rather than click so
  // dismissal feels instant (matches every other popover in the app).
  useEffect(() => {
    const onPointerDown = (e: MouseEvent): void => {
      const root = rootRef.current;
      const anchor = anchorRef.current;
      if (root === null) return;
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (root.contains(target)) return;
      // Clicks on the anchor itself are "the user wants to toggle"
      // and the parent toolbar handles that — but ALSO treat it as
      // outside-click so we close. The parent's onClose handler can
      // distinguish via state if needed.
      if (anchor !== null && anchor.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchorRef, onClose]);

  // Coachmark lifecycle. Visible only if the user has never dismissed
  // it. Auto-dismiss after 3s; dismissal writes the flag back to
  // settings so future popover opens skip the strip.
  useEffect(() => {
    if (stoplightSeen) {
      setCoachmarkVisible(false);
      return;
    }
    setCoachmarkVisible(true);
    const t = setTimeout(() => {
      setCoachmarkVisible(false);
      // Fire-and-forget; useSettings will refresh via the settings-
      // changed broadcast, which is what gates a future re-show.
      void dispatch("settings:write", {
        editor: { coachmarks: { stoplightSeen: true } }
      });
    }, COACHMARK_AUTO_DISMISS_MS);
    return () => {
      clearTimeout(t);
    };
  }, [stoplightSeen]);

  // Body — branch on tool. Delegated to <ToolStyleBody>, which is the
  // ONE source of truth for the per-tool control layouts so the
  // popover (anchored over the canvas) and the right-sidebar
  // `ToolConfigPanel` (Phase 1, task #7) render identical controls.
  // The popover wraps it in the dialog frame + coachmark; the panel
  // renders it bare.
  const body = (
    <ToolStyleBody
      tool={tool}
      style={style}
      onStyleFieldChange={onStyleFieldChange}
    />
  );

  return (
    <div
      ref={rootRef}
      className="pse-popover-root"
      style={position}
      data-tool={tool}
      data-testid="tool-style-popover"
      role="dialog"
      aria-label={`${tool} style options`}
    >
      {/* Outer inline-block measurer per AGENTS.md "Tray + float-over
          popover sizing — outer inline-block measurer". The styled
          `.pse-popover` carries `overflow: hidden`; measuring it
          directly would clip-loop. The wrapper has no overflow
          rules; gBCR returns content-determined height for any
          future ResizeObserver consumer. */}
      <div
        ref={measureRef}
        className="pse-popover-measure"
        style={{ display: "inline-block", width: "100%" }}
      >
        <div className="pse-popover">
          {isSelectedMode && (
            <div
              className="pse-popover-selected-header"
              data-testid="popover-selected-header"
            >
              <span>Editing this {selectedOverlayLabel}</span>
              <button
                type="button"
                className="pse-popover-clear-selection"
                data-testid="popover-clear-selection"
                aria-label="Clear selection"
                onClick={() => onClearSelection?.()}
              >
                ×
              </button>
            </div>
          )}
          {coachmarkVisible && (
            // Coachmark element. Two data-testids: `coachmark-strip`
            // is the original, used by unit tests under
            // `__tests__/ToolStylePopover.test.tsx`. `stoplight-
            // coachmark` was added per the v2 editor refresh task
            // #11 E2E specs so the E2E layer can use a more
            // descriptive selector without touching the existing
            // unit-test selectors. data-testid carries the first;
            // the second is exposed via `data-stoplight-coachmark`
            // so a `[data-stoplight-coachmark]` selector resolves.
            <div
              className="pse-popover-coachmark"
              data-testid="coachmark-strip"
              data-stoplight-coachmark="true"
            >
              <span aria-hidden="true">💡</span>
              <span>
                Stoplight palette: red = bad, green = good, blue = context. Same
                colors across all tools.
              </span>
            </div>
          )}
          <div className="pse-popover-body">{body}</div>
        </div>
      </div>
    </div>
  );
}

// ---- Shared body switch --------------------------------------------

export interface ToolStyleBodyProps {
  /** Discriminant — pairs with `style`. */
  tool: StyledToolKind;
  /** Tool-specific style block. Caller is responsible for pairing
   *  the right shape with `tool`; mismatch is a call-site bug. */
  style: ToolStylePopoverStyle;
  /** Fired when the user mutates any control. Mirrors the popover's
   *  signature so the same handler wires both surfaces. */
  onStyleFieldChange: ToolStylePopoverProps["onStyleFieldChange"];
}

/**
 * Single source of truth for the per-tool style control layouts.
 * Used by `ToolStylePopover` (wrapped in the dialog frame + coachmark
 * + click-outside / Escape shell) and by the right-sidebar
 * `ToolConfigPanel` (rendered bare inside the panel body). Any
 * future control / preset / swatch change lands here exactly once
 * and both surfaces pick it up.
 *
 * Narrows the `tool` discriminant at runtime; the call site is
 * responsible for pairing the right `style` shape with the tool kind
 * — the cast here is sound because the parent owns the union.
 */
export function ToolStyleBody({
  tool,
  style,
  onStyleFieldChange
}: ToolStyleBodyProps): ReactElement {
  switch (tool) {
    case "arrow":
      return (
        <ArrowBody
          style={style as ArrowToolStyle}
          onStyleFieldChange={onStyleFieldChange}
        />
      );
    case "text":
      return (
        <TextBody
          style={style as TextToolStyle}
          onStyleFieldChange={onStyleFieldChange}
        />
      );
    case "rect":
      return (
        <RectBody
          style={style as RectToolStyle}
          onStyleFieldChange={onStyleFieldChange}
        />
      );
    case "blur":
      return (
        <BlurBody
          style={style as BlurToolStyle}
          onStyleFieldChange={onStyleFieldChange}
        />
      );
    case "highlight":
      return (
        <HighlightBody
          style={style as HighlightToolStyle}
          onStyleFieldChange={onStyleFieldChange}
        />
      );
  }
}

// ---- Body components ------------------------------------------------

interface ArrowBodyProps {
  style: ArrowToolStyle;
  onStyleFieldChange: ToolStylePopoverProps["onStyleFieldChange"];
}

function ArrowBody({ style, onStyleFieldChange }: ArrowBodyProps): ReactElement {
  return (
    <>
      <ColorRow
        value={style.color}
        onChange={(c) => onStyleFieldChange("color", c)}
      />
      <Segmented
        label="Thickness"
        testid="arrow-thickness"
        options={SIZE_PRESETS}
        value={style.thickness}
        onChange={(v) => onStyleFieldChange("thickness", v)}
      />
      <FieldGroup label="End style" testid="arrow-end-style">
        <div className="pse-icon-row" role="radiogroup" aria-label="End style">
          {END_STYLES.map((opt) => {
            const Icon = opt.Icon;
            const active = style.endStyle === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={opt.label}
                className={"pse-icon-btn" + (active ? " is-on" : "")}
                onClick={() => onStyleFieldChange("endStyle", opt.id)}
              >
                <Icon />
              </button>
            );
          })}
        </div>
      </FieldGroup>
      <FieldGroup label="Stem style" testid="arrow-stem-style">
        <div className="pse-icon-row" role="radiogroup" aria-label="Stem style">
          {STEM_STYLES.map((opt) => {
            const active = style.stemStyle === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={opt.label}
                className={"pse-icon-btn pse-stem-btn" + (active ? " is-on" : "")}
                onClick={() => onStyleFieldChange("stemStyle", opt.id)}
              >
                <svg width="36" height="10" viewBox="0 0 36 10" aria-hidden="true">
                  <line
                    x1="2"
                    y1="5"
                    x2="34"
                    y2="5"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeDasharray={opt.dash}
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            );
          })}
        </div>
      </FieldGroup>
      <FieldGroup label="" testid="arrow-double-ended">
        <label className="pse-checkbox">
          <input
            type="checkbox"
            checked={style.doubleEnded}
            onChange={(e) => onStyleFieldChange("doubleEnded", e.target.checked)}
          />
          <span>Double-ended</span>
        </label>
      </FieldGroup>
    </>
  );
}

interface TextBodyProps {
  style: TextToolStyle;
  onStyleFieldChange: ToolStylePopoverProps["onStyleFieldChange"];
}

function TextBody({ style, onStyleFieldChange }: TextBodyProps): ReactElement {
  return (
    <>
      <ColorRow
        value={style.color}
        onChange={(c) => onStyleFieldChange("color", c)}
      />
      <Segmented
        label="Font size"
        testid="text-font-size"
        options={SIZE_PRESETS}
        value={style.fontSize}
        onChange={(v) => onStyleFieldChange("fontSize", v)}
      />
      <Segmented
        label="Weight"
        testid="text-weight"
        options={TEXT_WEIGHTS}
        value={style.weight}
        onChange={(v) => onStyleFieldChange("weight", v)}
      />
    </>
  );
}

interface RectBodyProps {
  style: RectToolStyle;
  onStyleFieldChange: ToolStylePopoverProps["onStyleFieldChange"];
}

function RectBody({ style, onStyleFieldChange }: RectBodyProps): ReactElement {
  return (
    <>
      <ColorRow
        value={style.color}
        onChange={(c) => onStyleFieldChange("color", c)}
      />
      <Segmented
        label="Thickness"
        testid="rect-thickness"
        options={SIZE_PRESETS}
        value={style.thickness}
        onChange={(v) => onStyleFieldChange("thickness", v)}
      />
      <FieldGroup label="" testid="rect-filled">
        <label className="pse-checkbox">
          <input
            type="checkbox"
            checked={style.filled}
            onChange={(e) => onStyleFieldChange("filled", e.target.checked)}
          />
          <span>Filled</span>
        </label>
      </FieldGroup>
    </>
  );
}

interface BlurBodyProps {
  style: BlurToolStyle;
  onStyleFieldChange: ToolStylePopoverProps["onStyleFieldChange"];
}

function BlurBody({ style, onStyleFieldChange }: BlurBodyProps): ReactElement {
  const isCustom = style.radius.mode === "px";
  const customValue = style.radius.mode === "px" ? style.radius.value : 0;
  return (
    <>
      {/* Mode picker — rich rows (icon + label + hint), one per mode.
          Brought back from the pre-fold BlurMenu after the unified
          popover initially collapsed it into a flat segmented control.
          Each row is a `role="radio"` button so screen readers + the
          test suite can target the same control surface as the other
          icon-radio groups. */}
      <FieldGroup label="Mode" testid="blur-mode">
        <div
          className="pse-mode-rows"
          role="radiogroup"
          aria-label="Blur mode"
        >
          {BLUR_MODES.map((opt) => {
            const Icon = opt.Icon;
            const active = opt.id === style.mode;
            return (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={opt.label}
                data-testid={`blur-mode-${opt.id}`}
                className={"pse-mode-row" + (active ? " is-on" : "")}
                onClick={() => onStyleFieldChange("mode", opt.id)}
              >
                <span className="pse-mode-row-icon" aria-hidden="true">
                  <Icon />
                </span>
                <span className="pse-mode-row-body">
                  <span className="pse-mode-row-label">{opt.label}</span>
                  <span className="pse-mode-row-hint">{opt.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      </FieldGroup>
      <FieldGroup label="Radius" testid="blur-radius">
        <div className="pse-seg" role="radiogroup" aria-label="Radius mode">
          <button
            type="button"
            role="radio"
            aria-checked={style.radius.mode === "auto"}
            className={"pse-seg-btn" + (style.radius.mode === "auto" ? " is-on" : "")}
            onClick={() => onStyleFieldChange("radius", { mode: "auto" })}
          >
            Auto
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={isCustom}
            className={"pse-seg-btn" + (isCustom ? " is-on" : "")}
            onClick={() =>
              onStyleFieldChange("radius", {
                mode: "px",
                value: customValue === 0 ? 8 : customValue
              })
            }
          >
            Custom…
          </button>
        </div>
        {isCustom && (
          <div className="pse-numeric-row">
            <input
              type="number"
              min={1}
              max={64}
              step={1}
              value={customValue}
              data-testid="blur-radius-custom-input"
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === "") return;
                const parsed = Number.parseInt(raw, 10);
                if (Number.isFinite(parsed)) {
                  onStyleFieldChange("radius", { mode: "px", value: parsed });
                }
              }}
              aria-label="Blur radius in pixels"
            />
            <span className="pse-numeric-unit">px</span>
          </div>
        )}
      </FieldGroup>
    </>
  );
}

interface HighlightBodyProps {
  style: HighlightToolStyle;
  onStyleFieldChange: ToolStylePopoverProps["onStyleFieldChange"];
}

function HighlightBody({
  style,
  onStyleFieldChange
}: HighlightBodyProps): ReactElement {
  const pct = Math.round(style.opacity * 100);
  return (
    <>
      <ColorRow
        value={style.color}
        onChange={(c) => onStyleFieldChange("color", c)}
      />
      <FieldGroup label="Opacity" testid="highlight-opacity">
        <div className="pse-slider-row">
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={style.opacity}
            data-testid="highlight-opacity-input"
            onChange={(e) => {
              const v = Number.parseFloat(e.target.value);
              if (Number.isFinite(v)) {
                onStyleFieldChange("opacity", v);
              }
            }}
            aria-label="Highlight opacity"
          />
          <span className="pse-slider-val" data-testid="highlight-opacity-display">
            {pct}%
          </span>
        </div>
      </FieldGroup>
      <Segmented
        label="Blend"
        testid="highlight-blend"
        options={BLEND_MODES}
        value={style.blend}
        onChange={(v) => onStyleFieldChange("blend", v)}
      />
    </>
  );
}

// ---- Shared building blocks ----------------------------------------

interface FieldGroupProps {
  label: string;
  testid: string;
  children: React.ReactNode;
}

function FieldGroup({ label, testid, children }: FieldGroupProps): ReactElement {
  return (
    <div className="pse-field-group" data-testid={testid}>
      {label !== "" && <div className="pse-field-label">{label}</div>}
      {children}
    </div>
  );
}

interface SegmentedProps<T extends string> {
  label: string;
  testid: string;
  options: ReadonlyArray<{ id: T; label: string }>;
  value: T | number;
  onChange(value: T): void;
}

function Segmented<T extends string>({
  label,
  testid,
  options,
  value,
  onChange
}: SegmentedProps<T>): ReactElement {
  return (
    <FieldGroup label={label} testid={testid}>
      <div className="pse-seg" role="radiogroup" aria-label={label}>
        {options.map((opt) => {
          const active = opt.id === value;
          return (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={opt.label}
              className={"pse-seg-btn" + (active ? " is-on" : "")}
              onClick={() => onChange(opt.id)}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </FieldGroup>
  );
}

interface ColorRowProps {
  value: ToolColor;
  onChange(color: ToolColor): void;
}

function ColorRow({ value, onChange }: ColorRowProps): ReactElement {
  const groupId = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const swatchRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const active = document.activeElement;
      const idx = swatchRefs.current.findIndex((b) => b === active);
      if (idx === -1) return;
      e.preventDefault();
      const delta = e.key === "ArrowRight" ? 1 : -1;
      const next = (idx + delta + COLOR_TOKENS.length) % COLOR_TOKENS.length;
      const target = swatchRefs.current[next];
      if (target) target.focus();
    },
    []
  );

  const openCustomDialog = useCallback((): void => {
    const dlg = dialogRef.current;
    if (dlg === null) return;
    // Using `showModal()` so the OS color-picker focus shift does NOT
    // close our enclosing popover — see plan §"native <input type=
    // 'color'> in a hidden <dialog>" footgun.
    if (typeof dlg.showModal === "function") {
      try {
        dlg.showModal();
      } catch {
        // Some test envs report the dialog as already-open; fall back
        // to the non-modal show.
        dlg.show?.();
      }
    } else {
      dlg.show?.();
    }
  }, []);

  return (
    <FieldGroup label="Color" testid="color-row">
      <div
        className="pse-color-row"
        role="radiogroup"
        aria-label="Color"
        aria-labelledby={groupId}
        onKeyDown={onKeyDown}
      >
        {COLOR_TOKENS.map((token, idx) => {
          const active = token === value;
          return (
            <button
              key={token}
              ref={(el) => {
                swatchRefs.current[idx] = el;
              }}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={COLOR_LABELS[token]}
              className={"pse-sw" + (active ? " is-on" : "")}
              data-color={token}
              data-testid={`swatch-${token}`}
              tabIndex={active ? 0 : -1}
              onClick={() => onChange(token)}
              style={{ background: `var(--swatch-${token})` }}
            />
          );
        })}
        <button
          type="button"
          className="pse-custom-btn"
          data-testid="color-custom"
          onClick={openCustomDialog}
        >
          Custom…
        </button>
        <dialog ref={dialogRef} className="pse-color-dialog">
          <form
            method="dialog"
            onSubmit={(e) => {
              // Native dialog will close on submit; nothing to do.
              e.stopPropagation();
            }}
          >
            <input
              type="color"
              data-testid="color-custom-input"
              defaultValue={
                typeof value === "string" && value.startsWith("#")
                  ? value
                  : "#ff8a1f"
              }
              onChange={(e) => {
                onChange(e.target.value);
              }}
            />
            <menu>
              <button type="submit" value="close">
                Done
              </button>
            </menu>
          </form>
        </dialog>
      </div>
    </FieldGroup>
  );
}

// ---- Icons ----------------------------------------------------------

function FilledTriangleIcon(): ReactElement {
  return (
    <svg width="20" height="14" viewBox="0 0 20 14" aria-hidden="true">
      <line x1="1" y1="7" x2="11" y2="7" stroke="currentColor" strokeWidth="2" />
      <polygon points="11,2 19,7 11,12" fill="currentColor" />
    </svg>
  );
}

function OpenTriangleIcon(): ReactElement {
  return (
    <svg width="20" height="14" viewBox="0 0 20 14" aria-hidden="true">
      <line x1="1" y1="7" x2="11" y2="7" stroke="currentColor" strokeWidth="2" />
      <polygon
        points="11,2 19,7 11,12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function LineIcon(): ReactElement {
  return (
    <svg width="20" height="14" viewBox="0 0 20 14" aria-hidden="true">
      <line x1="1" y1="7" x2="19" y2="7" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function DotIcon(): ReactElement {
  return (
    <svg width="20" height="14" viewBox="0 0 20 14" aria-hidden="true">
      <line x1="1" y1="7" x2="15" y2="7" stroke="currentColor" strokeWidth="2" />
      <circle cx="17" cy="7" r="2.5" fill="currentColor" />
    </svg>
  );
}

// ---- Blur mode icons ------------------------------------------------
//
// One glyph per BlurEffectMode. Kept as inline SVG (rather than the
// Unicode glyphs from the brief) so the icons scale with currentColor
// + look crisp at retina without depending on the renderer's font
// fallback chain. Each component is self-contained and uses unique
// gradient ids via `useId()` where needed (gaussian) so multiple
// instances rendered in the same DOM don't share a `url(#…)` ref.

function GaussianBlurIcon(): ReactElement {
  const gradId = useId();
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <defs>
        <radialGradient id={gradId} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.95" />
          <stop offset="60%" stopColor="currentColor" stopOpacity="0.5" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x="1" y="1" width="18" height="18" rx="3" fill={`url(#${gradId})`} />
    </svg>
  );
}

function PixelateIcon(): ReactElement {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="currentColor" aria-hidden="true">
      <rect x="1" y="1" width="5" height="5" />
      <rect x="7.5" y="1" width="5" height="5" opacity="0.55" />
      <rect x="14" y="1" width="5" height="5" />
      <rect x="1" y="7.5" width="5" height="5" opacity="0.55" />
      <rect x="7.5" y="7.5" width="5" height="5" />
      <rect x="14" y="7.5" width="5" height="5" opacity="0.55" />
      <rect x="1" y="14" width="5" height="5" />
      <rect x="7.5" y="14" width="5" height="5" opacity="0.55" />
      <rect x="14" y="14" width="5" height="5" />
    </svg>
  );
}

function RedactIcon(): ReactElement {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="currentColor" aria-hidden="true">
      <rect x="1" y="6" width="18" height="8" rx="1.5" />
    </svg>
  );
}

// Re-export so a test or a panel can use the same type without
// reaching back into the popover module.
export type { ArrowToolStyle, TextToolStyle, RectToolStyle, BlurToolStyle, HighlightToolStyle };
// Suppress unused-symbol churn for the type-narrow helper retained
// for future "polymorphic body" tunings.
void styleHasColor;
