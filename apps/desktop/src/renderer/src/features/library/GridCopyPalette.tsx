// Floating copy palette for Library Grid when the right inspector is
// closed. Selecting a tile must not open the sidebar (that reflows the
// virtualized grid under the cursor); this overlay is the replacement
// for the DetailRail L/M/H footer in that state.
//
// Visual + interaction language matches the existing floating chrome:
//   • EditToolbar — drag grip, stage-relative position, double-click
//     reset, clamp-on-resize.
//   • Float-over / DetailRail — the same CopyButton cards, video
//     export grid, and clipboard-copy helpers. No second copy path.
//
// ---- Anchor modes -------------------------------------------------
//
// `follow` (the default) re-anchors the palette to the SELECTED TILE on
// selection change, grid scroll, and resize — popover-style, below the
// tile with above/right/left flips when that would clip `.psl__main`.
// Placement math lives in ./grid-copy-palette-anchor.ts so the flip
// order is testable without a DOM.
//
// `pinned` keeps whatever spot the user dragged the palette to. Drag
// flips the mode implicitly; the 📌 button on the rail flips it back
// (and re-anchors immediately). Only the MODE persists — the dragged
// position stays module-scoped like EditToolbar's, because a saved
// viewport coordinate is wrong at the next launch's window size.
// Coordinate space is `.psl__main`-relative so a spot survives a
// sidebar / window resize within the session.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactElement
} from "react";
import {
  EVENT_CHANNELS,
  exportStrategyFromSettings,
  resolveExportLadder,
  rungForPreset
} from "@pwrsnap/shared";
import type {
  CaptureRecord,
  ExportStrategy,
  GridCopyPaletteAnchor,
  Settings,
  SettingsChangedEvent
} from "@pwrsnap/shared";
import {
  CopyButton,
  estimateMetricForRung,
  presetMetrics,
  rungTag,
  type CopyPreset
} from "../shared/CopyButton";
import { usePresetRenderMetrics } from "../shared/usePresetRenderMetrics";
import { VideoExportPresetsPanel } from "../shared/VideoExportPresetsPanel";
import { dispatch, startCaptureDrag, subscribe } from "../../lib/pwrsnap";
import { copyImagePreset, copyImagePresetPath } from "../../lib/clipboard-copy";
import { resolveFollowAnchor } from "./grid-copy-palette-anchor";

const COPY_PRESETS = ["low", "med", "high"] as const;
const COPY_LABELS: Record<(typeof COPY_PRESETS)[number], string> = {
  low: "Low",
  med: "Med",
  high: "High"
};

const DRAG_MARGIN_PX = 8;

let savedPosition: { x: number; y: number } | null = null;

/** Test-only: clear the session-scoped palette position between cases. */
export function resetGridCopyPalettePositionForTests(): void {
  savedPosition = null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Read the persisted anchor mode out of a Settings snapshot, tolerating
 *  a partially-shaped object (older on-disk files, test fixtures). */
function anchorFromSettings(settings: Settings | undefined): GridCopyPaletteAnchor {
  return settings?.library?.gridCopyPalette?.anchor === "pinned"
    ? "pinned"
    : "follow";
}

export type GridCopyPaletteProps = {
  readonly record: CaptureRecord;
  readonly copyPulses?: Readonly<Record<CopyPreset, number>>;
};

export function GridCopyPalette({
  record,
  copyPulses
}: GridCopyPaletteProps): ReactElement {
  // Two independent positions, selected by `anchor`. Keeping them apart
  // means flipping follow → pinned restores the user's last dragged
  // spot instead of stranding the palette wherever it last followed to.
  const [pinnedPosition, setPinnedPosition] = useState<{
    x: number;
    y: number;
  } | null>(savedPosition);
  const [followPosition, setFollowPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [anchor, setAnchor] = useState<GridCopyPaletteAnchor>("follow");
  const [exportStrategy, setExportStrategy] = useState<ExportStrategy>("legacy");
  const paletteRef = useRef<HTMLDivElement | null>(null);
  // Bumped on every local settings write so a slower in-flight
  // `settings:read` can't resolve over the user's fresh choice.
  const writeSeq = useRef(0);
  // One anchor flip per drag — a burst of pointermoves inside a single
  // React batch would otherwise fire several identical settings writes.
  const flippedThisDrag = useRef(false);
  const dragStart = useRef<{
    pointerX: number;
    pointerY: number;
    toolbarLeft: number;
    toolbarTop: number;
    stageRect: DOMRect | null;
  } | null>(null);

  const renderMetrics = usePresetRenderMetrics(
    record.kind === "image" ? record.id : null,
    record.kind === "image" ? record.edits_version : null
  );

  useEffect(() => {
    let cancelled = false;
    const seqAtRead = writeSeq.current;
    void dispatch("settings:read", {}).then((result) => {
      if (cancelled || !result.ok) return;
      // A drag (or 📌 click) between dispatch and resolve wins.
      if (writeSeq.current !== seqAtRead) return;
      const settings = result.value as Settings | undefined;
      setExportStrategy(exportStrategyFromSettings(settings));
      setAnchor(anchorFromSettings(settings));
    });
    const off = subscribe(EVENT_CHANNELS.settingsChanged, (payload) => {
      const evt = payload as SettingsChangedEvent;
      setExportStrategy(exportStrategyFromSettings(evt.settings));
      setAnchor(anchorFromSettings(evt.settings));
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const writeAnchor = useCallback((next: GridCopyPaletteAnchor): void => {
    writeSeq.current += 1;
    setAnchor(next);
    void dispatch("settings:write", {
      library: { gridCopyPalette: { anchor: next } }
    });
  }, []);

  useEffect(() => {
    savedPosition = pinnedPosition;
  }, [pinnedPosition]);

  const isFollow = anchor === "follow";
  const position = isFollow ? followPosition : pinnedPosition;
  const isPositioned = position !== null;

  // ---- follow mode: re-anchor to the selected tile -------------------
  // Runs on selection change (record.id), mode flip, grid scroll (capture
  // phase catches the scroll container inside `.psl__main`), and any
  // stage/palette resize. Cheap: one querySelector + three gBCRs.
  useLayoutEffect(() => {
    if (!isFollow) return;
    const palette = paletteRef.current;
    if (palette === null) return;
    const stageEl = getStageEl(palette);
    if (stageEl === null) return;
    const reanchor = (): void => {
      const tile = findTileEl(stageEl, record.id);
      if (tile === null) {
        // Tile scrolled out of the DOM (virtualized) or not rendered yet
        // — fall back to the CSS default (bottom-center) rather than
        // freezing at a stale spot that no longer means anything.
        setFollowPosition(null);
        return;
      }
      const next = resolveFollowAnchor({
        stage: stageEl.getBoundingClientRect(),
        tile: tile.getBoundingClientRect(),
        palette: palette.getBoundingClientRect()
      });
      if (next === null) return;
      setFollowPosition((prev) =>
        prev !== null && prev.x === next.x && prev.y === next.y
          ? prev
          : { x: next.x, y: next.y }
      );
    };
    reanchor();
    const ro = new ResizeObserver(reanchor);
    ro.observe(stageEl);
    ro.observe(palette);
    stageEl.addEventListener("scroll", reanchor, true);
    return () => {
      ro.disconnect();
      stageEl.removeEventListener("scroll", reanchor, true);
    };
  }, [isFollow, record.id]);

  // ---- pinned mode: keep the dragged spot inside the stage -----------
  // Follow mode does its own clamping inside resolveFollowAnchor, so
  // this only guards user-dragged positions against a shrinking window.
  const needsReclamp = !isFollow && pinnedPosition !== null;
  useLayoutEffect(() => {
    if (!needsReclamp) return;
    const palette = paletteRef.current;
    if (palette === null) return;
    const stageEl = getStageEl(palette);
    if (stageEl === null) return;
    const reclamp = (): void => {
      const sr = stageEl.getBoundingClientRect();
      const tr = palette.getBoundingClientRect();
      const maxX = Math.max(DRAG_MARGIN_PX, sr.width - tr.width - DRAG_MARGIN_PX);
      const maxY = Math.max(DRAG_MARGIN_PX, sr.height - tr.height - DRAG_MARGIN_PX);
      setPinnedPosition((prev) => {
        if (prev === null) return prev;
        const cx = clamp(prev.x, DRAG_MARGIN_PX, maxX);
        const cy = clamp(prev.y, DRAG_MARGIN_PX, maxY);
        if (cx === prev.x && cy === prev.y) return prev;
        return { x: cx, y: cy };
      });
    };
    reclamp();
    const ro = new ResizeObserver(reclamp);
    ro.observe(stageEl);
    ro.observe(palette);
    return () => {
      ro.disconnect();
    };
  }, [needsReclamp]);

  function onGripPointerDown(event: PointerEvent<HTMLButtonElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const palette = paletteRef.current;
    if (palette === null) return;
    const rect = palette.getBoundingClientRect();
    const stageEl = getStageEl(palette);
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    flippedThisDrag.current = false;
    dragStart.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      toolbarLeft: rect.left,
      toolbarTop: rect.top,
      stageRect: stageEl?.getBoundingClientRect() ?? null
    };
  }

  function onGripPointerMove(event: PointerEvent<HTMLButtonElement>): void {
    if (dragStart.current === null) return;
    // Moving the palette by hand IS the "stay put" gesture — flip the
    // persisted mode on the first move of the drag so the new spot
    // survives the next selection change.
    if (!flippedThisDrag.current && anchor === "follow") {
      flippedThisDrag.current = true;
      writeAnchor("pinned");
    }
    const dx = event.clientX - dragStart.current.pointerX;
    const dy = event.clientY - dragStart.current.pointerY;
    const palette = paletteRef.current;
    if (palette === null) return;
    const rect = palette.getBoundingClientRect();
    const { stageRect } = dragStart.current;
    const boundsLeft = stageRect?.left ?? 0;
    const boundsTop = stageRect?.top ?? 0;
    const boundsRight = stageRect?.right ?? window.innerWidth;
    const boundsBottom = stageRect?.bottom ?? window.innerHeight;
    const minViewportX = boundsLeft + DRAG_MARGIN_PX;
    const maxViewportX = boundsRight - rect.width - DRAG_MARGIN_PX;
    const minViewportY = boundsTop + DRAG_MARGIN_PX;
    const maxViewportY = boundsBottom - rect.height - DRAG_MARGIN_PX;
    const targetX = dragStart.current.toolbarLeft + dx;
    const targetY = dragStart.current.toolbarTop + dy;
    const clampedViewportX = clamp(
      targetX,
      minViewportX,
      Math.max(minViewportX, maxViewportX)
    );
    const clampedViewportY = clamp(
      targetY,
      minViewportY,
      Math.max(minViewportY, maxViewportY)
    );
    setPinnedPosition({
      x: clampedViewportX - boundsLeft,
      y: clampedViewportY - boundsTop
    });
  }

  function onGripPointerUp(event: PointerEvent<HTMLButtonElement>): void {
    if (dragStart.current === null) return;
    (event.target as HTMLElement).releasePointerCapture(event.pointerId);
    dragStart.current = null;
  }

  function onGripDoubleClick(): void {
    // Full reset: drop the dragged spot AND go back to the default
    // follow-the-selection behavior, matching EditToolbar's
    // "double-click the grip to undo my placement" muscle memory.
    setPinnedPosition(null);
    if (anchor !== "follow") writeAnchor("follow");
  }

  const style: CSSProperties =
    position === null
      ? {}
      : {
          left: position.x,
          top: position.y,
          bottom: "auto",
          transform: "none"
        };

  const videoMeta =
    record.kind === "video" && record.video !== null && record.video !== undefined
      ? record.video
      : null;
  const isVideo = videoMeta !== null;
  const hasExactRenderMetrics = renderMetrics.high?.exact === true;
  const exportLadder =
    isVideo || exportStrategy === "legacy"
      ? null
      : resolveExportLadder(
          {
            widthPx: record.width_px,
            heightPx: record.height_px,
            devicePixelRatio: record.device_pixel_ratio
          },
          exportStrategy
        );

  return (
    <div
      ref={paletteRef}
      className={
        "psl__grid-copy-palette" + (isPositioned ? " is-positioned" : "")
      }
      role="toolbar"
      aria-label="Copy selected capture"
      data-testid="psl-grid-copy-palette"
      data-capture-id={record.id}
      data-anchor={anchor}
      style={style}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="psl__grid-copy-palette-rail">
        <button
          type="button"
          className="psl__et-grip"
          aria-label="Drag copy palette (double-click to reset)"
          title="Drag to move · double-click to reset"
          data-testid="psl-grid-copy-palette-grip"
          onPointerDown={onGripPointerDown}
          onPointerMove={onGripPointerMove}
          onPointerUp={onGripPointerUp}
          onDoubleClick={onGripDoubleClick}
        >
          <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
            <circle cx="2.5" cy="2.5" r="1.1" />
            <circle cx="7.5" cy="2.5" r="1.1" />
            <circle cx="2.5" cy="7" r="1.1" />
            <circle cx="7.5" cy="7" r="1.1" />
            <circle cx="2.5" cy="11.5" r="1.1" />
            <circle cx="7.5" cy="11.5" r="1.1" />
          </svg>
        </button>
        <button
          type="button"
          className={
            "psl__grid-copy-palette-anchor" + (isFollow ? " is-following" : "")
          }
          aria-label={isFollow ? "Follow selection" : "Stay put"}
          aria-pressed={isFollow}
          title={
            isFollow
              ? "Following the selection · click to stay put"
              : "Staying put · click to follow the selection"
          }
          data-testid="psl-grid-copy-palette-anchor-toggle"
          onClick={() => writeAnchor(isFollow ? "pinned" : "follow")}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 17v5" />
            <path d="M9 10.76V6a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4.76a2 2 0 0 0 .59 1.42l1 1A1 1 0 0 1 15.88 15H8.12a1 1 0 0 1-.71-1.71l1-1A2 2 0 0 0 9 10.76Z" />
          </svg>
        </button>
      </div>
      <span className="psl__et-sep" aria-hidden="true" />
      <div className="psl__grid-copy-palette-body">
        <div className="psl__copy-eyebrow">
          <span>{isVideo ? "Export" : "Copy to clipboard"}</span>
          <span className="psl__copy-eyebrow-line" />
          {isVideo ? null : (
            <span className="psl__copy-eyebrow-meta">
              {hasExactRenderMetrics ? "actual files" : "rendering files"}
            </span>
          )}
        </div>
        {isVideo ? (
          <div data-testid="psl-grid-copy-palette-video">
            <VideoExportPresetsPanel captureId={record.id} />
          </div>
        ) : (
          <div className="psl__copy-row">
            {COPY_PRESETS.map((p) => {
              const rung =
                exportLadder === null ? undefined : rungForPreset(exportLadder, p);
              const estimate =
                rung === undefined
                  ? presetMetrics(p, record.width_px, record.height_px, record.byte_size)
                  : estimateMetricForRung(rung, record.width_px, record.byte_size);
              const m = renderMetrics[p] ?? estimate;
              return (
                <CopyButton
                  key={p}
                  preset={p}
                  label={COPY_LABELS[p]}
                  dim={m.dim}
                  bytes={m.bytes}
                  tag={rung === undefined ? undefined : rungTag(rung)}
                  onCopy={(preset) => copyImagePreset(record.id, preset)}
                  onCopyPath={(preset) => copyImagePresetPath(record.id, preset)}
                  onDrag={(preset) => startCaptureDrag(record.id, preset)}
                  copyPulse={copyPulses?.[p] ?? 0}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function getStageEl(palette: HTMLElement): HTMLElement | null {
  return palette.closest<HTMLElement>(".psl__main") ?? null;
}

/**
 * Locate the grid cell for `captureId` inside the stage. Cells carry
 * `data-cell-id` (see Library.tsx's CellRow), which is the cheapest
 * stable handle — no ref plumbing through the virtualizer, and it
 * naturally returns null for a cell that's been unmounted by
 * virtualization.
 */
function findTileEl(stage: HTMLElement, captureId: string): HTMLElement | null {
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(captureId)
      : captureId.replace(/["\\]/g, "\\$&");
  return stage.querySelector<HTMLElement>(`.psl__cell[data-cell-id="${escaped}"]`);
}
