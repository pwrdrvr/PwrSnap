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
// Position is module-scoped (survives remounts within a session, resets
// on launch) just like EditToolbar. Coordinate space is `.psl__main`-
// relative so a saved spot survives sidebar / window resize.

import {
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

export type GridCopyPaletteProps = {
  readonly record: CaptureRecord;
  readonly copyPulses?: Readonly<Record<CopyPreset, number>>;
};

export function GridCopyPalette({
  record,
  copyPulses
}: GridCopyPaletteProps): ReactElement {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    savedPosition
  );
  const [exportStrategy, setExportStrategy] = useState<ExportStrategy>("legacy");
  const paletteRef = useRef<HTMLDivElement | null>(null);
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
    const load = (): void => {
      void dispatch("settings:read", {}).then((result) => {
        if (cancelled || !result.ok) return;
        setExportStrategy(exportStrategyFromSettings(result.value as Settings | undefined));
      });
    };
    load();
    const off = subscribe(EVENT_CHANNELS.settingsChanged, (payload) => {
      const evt = payload as SettingsChangedEvent;
      setExportStrategy(exportStrategyFromSettings(evt.settings));
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  useEffect(() => {
    savedPosition = position;
  }, [position]);

  const isPositioned = position !== null;
  useLayoutEffect(() => {
    if (!isPositioned) return;
    const palette = paletteRef.current;
    if (palette === null) return;
    const stageEl = getStageEl(palette);
    if (stageEl === null) return;
    const reclamp = (): void => {
      const sr = stageEl.getBoundingClientRect();
      const tr = palette.getBoundingClientRect();
      const maxX = Math.max(DRAG_MARGIN_PX, sr.width - tr.width - DRAG_MARGIN_PX);
      const maxY = Math.max(DRAG_MARGIN_PX, sr.height - tr.height - DRAG_MARGIN_PX);
      setPosition((prev) => {
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
  }, [isPositioned]);

  function onGripPointerDown(event: PointerEvent<HTMLButtonElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const palette = paletteRef.current;
    if (palette === null) return;
    const rect = palette.getBoundingClientRect();
    const stageEl = getStageEl(palette);
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
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
    setPosition({
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
    setPosition(null);
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
      style={style}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
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
