// Phase 2 Editor — starter scope.
//
// Renders a captured image full-canvas with a floating toolbar.
// Currently supports a single tool: arrow (drag-from-to). Drawing
// fires `overlays:upsert` on pointerup; the live overlay list is
// kept in sync via the `events:overlays:changed` broadcast so
// future bake / multi-window edits stay consistent.
//
// Coordinate system: every overlay's geometry is normalized to
// [0, 1]^2 fractions of the source image's W×H — independent of
// canvas display size. So zooming the editor or switching to a
// different cache resolution doesn't move overlays around.
//
// What this commit DOESN'T do (deferred to Phase 2 main):
//   - Render-bake (the cache files still serve un-annotated source).
//   - Tool palette beyond arrow (rect, text, blur, highlight, crop,
//     step). The toolbar UI shows these as disabled chips so the
//     shape is visible.
//   - Smart-arrow geometry (auto-curving, color, stroke from short-
//     edge). For Phase 2 starter the arrow is a straight line +
//     triangle head, fixed orange.
//   - Selection / move / resize. Each draw is append-only.
//   - Undo/redo. Append-only is sufficient for the starter — undo
//     becomes a stack of overlays:delete calls in Phase 2 main.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CaptureRecord, Overlay, OverlayRow } from "@pwrsnap/shared";
import { computeArrowGeometry } from "@pwrsnap/shared";
import { dispatch, subscribe, captureSrcUrl } from "../../lib/pwrsnap";
import "./editor.css";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; record: CaptureRecord; overlays: OverlayRow[] }
  | { kind: "error"; message: string };

type Tool = "arrow" | "rect" | "text" | "blur" | "highlight";

type DraftArrow = {
  kind: "arrow";
  fromXn: number; // normalized 0..1
  fromYn: number;
  toXn: number;
  toYn: number;
};

const TOOLS: { id: Tool; label: string; key: string; enabled: boolean }[] = [
  { id: "arrow", label: "Arrow", key: "A", enabled: true },
  { id: "rect", label: "Rect", key: "R", enabled: false },
  { id: "text", label: "Text", key: "T", enabled: false },
  { id: "highlight", label: "Highlight", key: "H", enabled: false },
  { id: "blur", label: "Blur", key: "B", enabled: false }
];

export function Editor({ captureId }: { captureId: string }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [tool, setTool] = useState<Tool>("arrow");
  const [draft, setDraft] = useState<DraftArrow | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  const refetch = useCallback(async () => {
    const recordResult = await dispatch("library:byId", { id: captureId });
    if (!recordResult.ok) {
      setState({ kind: "error", message: recordResult.error.message });
      return;
    }
    if (recordResult.value === null) {
      setState({ kind: "error", message: `capture not found: ${captureId}` });
      return;
    }
    const overlaysResult = await dispatch("overlays:list", { captureId });
    const overlays = overlaysResult.ok ? overlaysResult.value : [];
    setState({ kind: "loaded", record: recordResult.value, overlays });
  }, [captureId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Re-fetch overlays when main broadcasts a change for our capture.
  useEffect(() => {
    const unsubscribe = subscribe("events:overlays:changed", (payload) => {
      const p = payload as { captureId?: string };
      if (p.captureId !== undefined && p.captureId !== captureId) return;
      void refetch();
    });
    return unsubscribe;
  }, [captureId, refetch]);

  function clientToNormalized(
    clientX: number,
    clientY: number
  ): { xn: number; yn: number } | null {
    const canvas = canvasRef.current;
    if (canvas === null) return null;
    const rect = canvas.getBoundingClientRect();
    const xn = (clientX - rect.left) / rect.width;
    const yn = (clientY - rect.top) / rect.height;
    if (xn < 0 || xn > 1 || yn < 0 || yn > 1) return null;
    return { xn, yn };
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    if (tool !== "arrow") return;
    if (event.button !== 0) return;
    const start = clientToNormalized(event.clientX, event.clientY);
    if (start === null) return;
    event.preventDefault();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    setDraft({
      kind: "arrow",
      fromXn: start.xn,
      fromYn: start.yn,
      toXn: start.xn,
      toYn: start.yn
    });
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    if (draft === null) return;
    const cur = clientToNormalized(event.clientX, event.clientY);
    if (cur === null) return;
    setDraft({ ...draft, toXn: cur.xn, toYn: cur.yn });
  }

  async function onPointerUp(event: React.PointerEvent<HTMLDivElement>): Promise<void> {
    if (draft === null) return;
    (event.target as HTMLElement).releasePointerCapture(event.pointerId);

    // Discard zero-length drags (a stray click). 0.5% of the canvas
    // diagonal is roughly the smallest "intentional" arrow.
    const dx = draft.toXn - draft.fromXn;
    const dy = draft.toYn - draft.fromYn;
    if (Math.hypot(dx, dy) < 0.005) {
      setDraft(null);
      return;
    }

    const overlay: Overlay = {
      kind: "arrow",
      from: { x: draft.fromXn, y: draft.fromYn },
      to: { x: draft.toXn, y: draft.toYn },
      color: "auto"
    };
    setDraft(null);
    const result = await dispatch("overlays:upsert", { captureId, overlay });
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.error("overlays:upsert failed", result.error);
    }
    // The overlaysChanged broadcast will trigger refetch.
  }

  // Keyboard shortcuts: tool selection + Esc cancels drag.
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape" && draft !== null) {
        event.preventDefault();
        setDraft(null);
        return;
      }
      const upper = event.key.toUpperCase();
      const matched = TOOLS.find((t) => t.key === upper && t.enabled);
      if (matched !== undefined) {
        event.preventDefault();
        setTool(matched.id);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft]);

  if (state.kind === "loading") {
    return <div className="editor-loading">Loading capture…</div>;
  }
  if (state.kind === "error") {
    return <div className="editor-error">{state.message}</div>;
  }

  const { record, overlays } = state;
  return (
    <div className="editor-root">
      <header className="editor-titlebar">
        <span className="editor-title">
          PwrSnap Editor · {record.source_app_name ?? "Capture"} ·{" "}
          <span className="editor-title-meta">
            {record.width_px}×{record.height_px}
          </span>
        </span>
      </header>

      <div className="editor-canvas-wrap">
        <div
          ref={canvasRef}
          className="editor-canvas"
          style={{ aspectRatio: `${record.width_px} / ${record.height_px}` }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <img
            src={captureSrcUrl(record.id)}
            alt={record.source_app_name ?? "Capture"}
            draggable={false}
            className="editor-image"
          />
          <OverlaySvg
            overlays={overlays}
            draft={draft}
            imageWidthPx={record.width_px}
            imageHeightPx={record.height_px}
          />
        </div>
      </div>

      <Toolbar
        tool={tool}
        onChange={setTool}
        appliedCount={overlays.length}
        onClearLast={async () => {
          const last = overlays[overlays.length - 1];
          if (last === undefined) return;
          await dispatch("overlays:delete", { id: last.id });
        }}
      />
    </div>
  );
}

function Toolbar({
  tool,
  onChange,
  appliedCount,
  onClearLast
}: {
  tool: Tool;
  onChange: (t: Tool) => void;
  appliedCount: number;
  onClearLast: () => Promise<void>;
}) {
  return (
    <div className="editor-toolbar" role="toolbar" aria-label="Annotation tools">
      <div className="editor-toolbar-tools">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            disabled={!t.enabled}
            className={tool === t.id ? "is-active" : ""}
            onClick={() => onChange(t.id)}
            title={t.enabled ? `${t.label} (${t.key})` : `${t.label} (Phase 2 main)`}
          >
            <span className="editor-tool-key">{t.key}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>
      <div className="editor-toolbar-meta">
        <span>{appliedCount} overlay{appliedCount === 1 ? "" : "s"}</span>
        <button type="button" disabled={appliedCount === 0} onClick={() => void onClearLast()}>
          Undo last
        </button>
      </div>
    </div>
  );
}

function OverlaySvg({
  overlays,
  draft,
  imageWidthPx,
  imageHeightPx
}: {
  overlays: OverlayRow[];
  draft: DraftArrow | null;
  imageWidthPx: number;
  imageHeightPx: number;
}) {
  // Render in normalized coords against a 0..1 viewBox so the SVG
  // scales with the canvas without recomputing pixel positions.
  // The shared smart-arrow geometry expresses stroke as a fraction
  // of the image short-side, which translates directly to viewBox
  // units. So the live render in the editor looks visually
  // identical to the bake step in main — same function, same input.
  const viewBox = "0 0 1 1";
  const arrows = useMemo(
    () =>
      overlays.flatMap((row) => (row.data.kind === "arrow" ? [{ row, data: row.data }] : [])),
    [overlays]
  );
  return (
    <svg className="editor-svg" viewBox={viewBox} preserveAspectRatio="none">
      {arrows.map(({ row, data }) => (
        <ArrowGlyph
          key={row.id}
          fromXn={data.from.x}
          fromYn={data.from.y}
          toXn={data.to.x}
          toYn={data.to.y}
          imageWidthPx={imageWidthPx}
          imageHeightPx={imageHeightPx}
        />
      ))}
      {draft !== null && (
        <ArrowGlyph
          fromXn={draft.fromXn}
          fromYn={draft.fromYn}
          toXn={draft.toXn}
          toYn={draft.toYn}
          imageWidthPx={imageWidthPx}
          imageHeightPx={imageHeightPx}
          isDraft
        />
      )}
    </svg>
  );
}

function ArrowGlyph({
  fromXn,
  fromYn,
  toXn,
  toYn,
  imageWidthPx,
  imageHeightPx,
  isDraft = false
}: {
  fromXn: number;
  fromYn: number;
  toXn: number;
  toYn: number;
  imageWidthPx: number;
  imageHeightPx: number;
  isDraft?: boolean;
}) {
  // Smart-arrow geometry — same shared function the sharp bake uses.
  // strokeFraction is in image-short-side units; the viewBox is
  // 0..1 normalized coords, so we need to express stroke as a
  // fraction of viewBox-X (or Y, doesn't matter for stroke). We
  // pick `min(1/aspect, 1) * strokeFraction` so the visual stroke
  // width matches what the bake produces post-resize.
  const geom = computeArrowGeometry({
    from: { x: fromXn, y: fromYn },
    to: { x: toXn, y: toYn },
    imageWidthPx,
    imageHeightPx
  });

  const headPolygon = `${geom.to.x},${geom.to.y} ${geom.baseLeft.x},${geom.baseLeft.y} ${geom.baseRight.x},${geom.baseRight.y}`;
  // strokeFraction is "stroke / shortSide". The viewBox is
  // 0..1×0..1, so the visual stroke in viewBox units is
  // strokeFraction × (shortSide / max(width, height)). We can
  // approximate as just strokeFraction since for a square image
  // shortSide == width == height and for non-square the SVG's
  // preserveAspectRatio="none" makes the visual stroke slightly
  // anisotropic — acceptable for the live preview.
  const stroke = geom.strokeFraction;
  const outline = Math.max(stroke * 0.25, 0.0015);

  const accent = isDraft ? "var(--accent-strong, #ff8c4a)" : "var(--accent, #e8743a)";
  return (
    <g strokeLinecap="round" strokeLinejoin="round">
      {/* white halo for legibility on busy images, matches bake */}
      <line
        x1={geom.from.x}
        y1={geom.from.y}
        x2={geom.baseCenter.x}
        y2={geom.baseCenter.y}
        stroke="white"
        strokeWidth={stroke + outline * 2}
        fill="none"
      />
      <polygon
        points={headPolygon}
        fill="white"
        stroke="white"
        strokeWidth={outline * 2}
      />
      <line
        x1={geom.from.x}
        y1={geom.from.y}
        x2={geom.baseCenter.x}
        y2={geom.baseCenter.y}
        stroke={accent}
        strokeWidth={stroke}
        fill="none"
      />
      <polygon points={headPolygon} fill={accent} />
    </g>
  );
}
