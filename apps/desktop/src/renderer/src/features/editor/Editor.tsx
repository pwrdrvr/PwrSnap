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
          <OverlaySvg overlays={overlays} draft={draft} />
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
  draft
}: {
  overlays: OverlayRow[];
  draft: DraftArrow | null;
}) {
  // Render in normalized coords against a 0..1 viewBox, so the SVG
  // scales with the canvas without recomputing pixel positions.
  // Stroke widths use a scale-invariant trick: strokeWidth as a
  // fraction of the viewBox (0.005 ≈ 0.5%) reads visually consistent
  // across canvas sizes.
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
        />
      ))}
      {draft !== null && (
        <ArrowGlyph
          fromXn={draft.fromXn}
          fromYn={draft.fromYn}
          toXn={draft.toXn}
          toYn={draft.toYn}
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
  isDraft = false
}: {
  fromXn: number;
  fromYn: number;
  toXn: number;
  toYn: number;
  isDraft?: boolean;
}) {
  // Compute a tiny triangle head at `to`, pointing along the line.
  const dx = toXn - fromXn;
  const dy = toYn - fromYn;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const headLen = 0.025;
  const headW = 0.014;
  // Two perpendiculars at the base of the head.
  const baseX = toXn - ux * headLen;
  const baseY = toYn - uy * headLen;
  const px = -uy * headW;
  const py = ux * headW;
  const headPath = `M ${toXn} ${toYn} L ${baseX + px} ${baseY + py} L ${baseX - px} ${baseY - py} Z`;
  const lineEndX = baseX;
  const lineEndY = baseY;
  return (
    <g
      stroke={isDraft ? "var(--accent-strong, #ff8c4a)" : "var(--accent, #e8743a)"}
      strokeWidth={0.007}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill={isDraft ? "var(--accent-strong, #ff8c4a)" : "var(--accent, #e8743a)"}
    >
      <line x1={fromXn} y1={fromYn} x2={lineEndX} y2={lineEndY} />
      <path d={headPath} />
    </g>
  );
}
