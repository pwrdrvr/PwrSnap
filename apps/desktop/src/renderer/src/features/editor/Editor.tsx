// Phase 2 Editor — full tool palette.
//
// Tools (Slice B):
//   • Arrow      — drag from→to. Smart geometry shared with bake.
//   • Rect       — drag a rectangle. Stroked outline + white halo.
//   • Highlight  — drag a rectangle. Semi-transparent yellow fill.
//   • Blur       — drag a rectangle. Mask-style blur per region in bake.
//   • Text       — click to anchor; inline input; Enter commits.
//
// Coordinate system: every overlay's geometry is normalized to
// [0, 1]^2 fractions of the source image's W×H — independent of
// canvas display size. The same overlay record renders identically
// in the editor's live SVG and in the sharp bake (compose.ts).
//
// Smart-arrow geometry (computeArrowGeometry) is the shared math
// between live render and bake. Rect/highlight/blur are simpler:
// just a rect with normalized coords; the bake produces an SVG
// buffer at source-pixel resolution.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent
} from "react";
import type { CaptureRecord, Overlay, OverlayRow } from "@pwrsnap/shared";
import { computeArrowGeometry } from "@pwrsnap/shared";
import { dispatch, subscribe, captureSrcUrl } from "../../lib/pwrsnap";
import { TOOLS, type Tool } from "./editor-tools";
import "./editor.css";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; record: CaptureRecord; overlays: OverlayRow[] }
  | { kind: "error"; message: string };

type DraftArrow = {
  kind: "arrow";
  fromXn: number;
  fromYn: number;
  toXn: number;
  toYn: number;
};

type DraftRect = {
  /** Same shape for rect / highlight / blur — they all drag a box.
   *  The `tool` discriminator below tells the renderer which look
   *  to apply during drag. */
  kind: "rect-drag";
  tool: "rect" | "highlight" | "blur";
  startXn: number;
  startYn: number;
  curXn: number;
  curYn: number;
};

type DraftText = {
  kind: "text";
  /** Anchor point (top-left of the text box). */
  xn: number;
  yn: number;
  /** Live-typed body. Persisted on commit (Enter / blur). */
  body: string;
};

type Draft = DraftArrow | DraftRect | DraftText;

const MIN_DRAG_LENGTH = 0.005; // 0.5% of canvas — below = treat as click

/** Three structural shapes for the editor:
 *
 *   • "full"       — standalone editor window: titlebar + bottom
 *                    toolbar. Default when no chrome prop is passed.
 *   • "embedded"   — inline-in-Library mode (Phase 2 Slice C / Phase
 *                    A transitional): no titlebar, but keeps the
 *                    bottom toolbar. This branch was dropped in
 *                    Phase B and may be removed entirely in a
 *                    future cleanup.
 *   • "chromeless" — Library Focus + Reel modes: no titlebar, no
 *                    toolbar. The canvas + draft input only. The
 *                    floating EditToolbar lives at the Library level
 *                    and shares tool state via the controlled
 *                    `tool` / `onToolChange` props. */
export type EditorChrome = "full" | "embedded" | "chromeless";

export function Editor({
  captureId,
  chrome = "full",
  tool: toolProp,
  onToolChange
}: {
  captureId: string;
  /** Chrome shape — see `EditorChrome` above. Defaults to `"full"`
   *  (standalone editor window). */
  chrome?: EditorChrome;
  /** Optional controlled tool state. If both `tool` and `onToolChange`
   *  are passed, Editor is fully controlled — Library owns the tool
   *  state and drives the floating EditToolbar. If neither is passed,
   *  Editor falls back to internal `useState` (standalone-window
   *  path). Mixed (one without the other) is not supported and will
   *  fall back to internal state. */
  tool?: Tool;
  onToolChange?: (tool: Tool) => void;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  // Controlled-or-uncontrolled tool state. When the parent passes
  // both `tool` and `onToolChange`, we mirror their value as the
  // single source of truth. Otherwise we fall back to internal
  // useState (the standalone-window invariant).
  const isControlled = toolProp !== undefined && onToolChange !== undefined;
  const [internalTool, setInternalTool] = useState<Tool>("pointer");
  const tool = isControlled ? toolProp : internalTool;
  const setTool = useCallback(
    (next: Tool) => {
      if (isControlled) onToolChange(next);
      else setInternalTool(next);
    },
    [isControlled, onToolChange]
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const textInputRef = useRef<HTMLInputElement | null>(null);

  // refetch accepts a "cancelled" predicate so the caller can opt-out
  // of post-await setState if the component has moved on. Critical for
  // the rapid mode-flip cases the Library plan introduces (Grid →
  // Focus[A] → Esc → Focus[B]): without this guard, A's library:byId
  // can resolve AFTER B has mounted and stomp B's state with A's
  // record. Plan reference: docs/plans/2026-05-05-001-feat-library-
  // three-state-view-model-plan.md, Phase A.7.
  const refetch = useCallback(
    async (isCancelled: () => boolean = () => false) => {
      const recordResult = await dispatch("library:byId", { id: captureId });
      if (isCancelled()) return;
      if (!recordResult.ok) {
        setState({ kind: "error", message: recordResult.error.message });
        return;
      }
      if (recordResult.value === null) {
        setState({ kind: "error", message: `capture not found: ${captureId}` });
        return;
      }
      const overlaysResult = await dispatch("overlays:list", { captureId });
      if (isCancelled()) return;
      const overlays = overlaysResult.ok ? overlaysResult.value : [];
      setState({ kind: "loaded", record: recordResult.value, overlays });
    },
    [captureId]
  );

  useEffect(() => {
    let cancelled = false;
    void refetch(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [refetch]);

  // Re-fetch when overlays change for this capture.
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = subscribe("events:overlays:changed", (payload) => {
      const p = payload as { captureId?: string };
      if (p.captureId !== undefined && p.captureId !== captureId) return;
      void refetch(() => cancelled);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [captureId, refetch]);

  // Auto-focus the text input when entering text-draft state.
  useEffect(() => {
    if (draft?.kind === "text") {
      textInputRef.current?.focus();
    }
  }, [draft]);

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
    if (event.button !== 0) return;
    // Pointer tool is no-op on drag — lets the user click on the
    // canvas without accidentally drawing. They have to explicitly
    // select a drawing tool first.
    if (tool === "pointer") return;
    // If we're mid-text and the user clicks elsewhere, commit/cancel
    // the text first (the input's blur handler will fire).
    if (draft?.kind === "text") return;

    const start = clientToNormalized(event.clientX, event.clientY);
    if (start === null) return;
    event.preventDefault();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);

    if (tool === "arrow") {
      setDraft({
        kind: "arrow",
        fromXn: start.xn,
        fromYn: start.yn,
        toXn: start.xn,
        toYn: start.yn
      });
      return;
    }
    if (tool === "rect" || tool === "highlight" || tool === "blur") {
      setDraft({
        kind: "rect-drag",
        tool,
        startXn: start.xn,
        startYn: start.yn,
        curXn: start.xn,
        curYn: start.yn
      });
      return;
    }
    if (tool === "text") {
      // Click-to-place anchors a text input at the cursor. The input
      // captures keystrokes; Enter commits.
      setDraft({ kind: "text", xn: start.xn, yn: start.yn, body: "" });
      return;
    }
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    if (draft === null) return;
    if (draft.kind === "text") return;
    const cur = clientToNormalized(event.clientX, event.clientY);
    if (cur === null) return;
    if (draft.kind === "arrow") {
      setDraft({ ...draft, toXn: cur.xn, toYn: cur.yn });
      return;
    }
    if (draft.kind === "rect-drag") {
      setDraft({ ...draft, curXn: cur.xn, curYn: cur.yn });
      return;
    }
  }

  async function onPointerUp(event: React.PointerEvent<HTMLDivElement>): Promise<void> {
    if (draft === null) return;
    if (draft.kind === "text") return;
    (event.target as HTMLElement).releasePointerCapture(event.pointerId);

    if (draft.kind === "arrow") {
      const dx = draft.toXn - draft.fromXn;
      const dy = draft.toYn - draft.fromYn;
      if (Math.hypot(dx, dy) < MIN_DRAG_LENGTH) {
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
      await persistOverlay(overlay);
      return;
    }

    if (draft.kind === "rect-drag") {
      const rect = rectFromDrag(draft);
      if (rect === null) {
        setDraft(null);
        return;
      }
      const overlay: Overlay =
        draft.tool === "rect"
          ? { kind: "rect", rect, color: "auto" }
          : draft.tool === "highlight"
          ? { kind: "highlight", rect }
          : { kind: "blur", rect };
      setDraft(null);
      await persistOverlay(overlay);
      return;
    }
  }

  async function persistOverlay(overlay: Overlay): Promise<void> {
    const result = await dispatch("overlays:upsert", { captureId, overlay });
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.error("overlays:upsert failed", result.error);
    }
    // events:overlays:changed broadcast triggers refetch.
  }

  async function commitText(): Promise<void> {
    if (draft?.kind !== "text") return;
    const body = draft.body.trim();
    if (body.length === 0) {
      setDraft(null);
      return;
    }
    const overlay: Overlay = {
      kind: "text",
      point: { x: draft.xn, y: draft.yn },
      body,
      size: "small",
      color: "auto"
    };
    setDraft(null);
    await persistOverlay(overlay);
  }

  // Keyboard shortcuts: tool selection + Esc cancels drag.
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape" && draft !== null) {
        event.preventDefault();
        setDraft(null);
        return;
      }
      // Don't interpret as a tool shortcut when text input has focus.
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      const upper = event.key.toUpperCase();
      const matched = TOOLS.find((t) => t.key === upper);
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
    <div
      className={
        "editor-root" +
        (chrome === "embedded" ? " is-embedded" : "") +
        (chrome === "chromeless" ? " is-chromeless" : "")
      }
    >
      {chrome === "full" && (
        <header className="editor-titlebar">
          <span className="editor-title">
            PwrSnap Editor · {record.source_app_name ?? "Capture"} ·{" "}
            <span className="editor-title-meta">
              {record.width_px}×{record.height_px}
            </span>
          </span>
        </header>
      )}

      <div className="editor-canvas-wrap">
        <div
          ref={canvasRef}
          className="editor-canvas"
          style={{ aspectRatio: `${record.width_px} / ${record.height_px}` }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          data-tool={tool}
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
          {draft?.kind === "text" && (
            <TextDraftInput
              draft={draft}
              inputRef={textInputRef}
              onChange={(body) => setDraft({ ...draft, body })}
              onCommit={() => void commitText()}
              onCancel={() => setDraft(null)}
            />
          )}
        </div>
      </div>

      {chrome !== "chromeless" && (
        <EditorToolbar
          tool={tool}
          onChange={setTool}
          appliedCount={overlays.length}
          onClearLast={async () => {
            const last = overlays[overlays.length - 1];
            if (last === undefined) return;
            await dispatch("overlays:delete", { id: last.id });
          }}
        />
      )}
    </div>
  );
}

/**
 * Convert the rect-drag draft into a normalized {x, y, w, h}. Returns
 * null when the drag is below the minimum-length threshold (treats
 * a stray click as a no-op rather than producing an invisible rect).
 */
function rectFromDrag(d: DraftRect): { x: number; y: number; w: number; h: number } | null {
  const x = Math.min(d.startXn, d.curXn);
  const y = Math.min(d.startYn, d.curYn);
  const w = Math.abs(d.curXn - d.startXn);
  const h = Math.abs(d.curYn - d.startYn);
  if (w < MIN_DRAG_LENGTH || h < MIN_DRAG_LENGTH) return null;
  // Clamp to [0,1] in case the cursor went out of bounds.
  return {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
    w: Math.max(0, Math.min(1 - x, w)),
    h: Math.max(0, Math.min(1 - y, h))
  };
}

// EditorToolbar: bottom-row toolbar attached to Editor's own chrome
// (full + embedded modes). The new <EditToolbar> at
// features/library/EditToolbar.tsx is a SEPARATE component used by
// Library's Stage component (chromeless Editor + floating bottom-
// center toolbar, Phase C). Renamed from `Toolbar` to avoid the
// name collision flagged by pattern-recognition-specialist.
function EditorToolbar({
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
            className={tool === t.id ? "is-active" : ""}
            onClick={() => onChange(t.id)}
            title={`${t.label} (${t.key})`}
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
  draft: Draft | null;
  imageWidthPx: number;
  imageHeightPx: number;
}) {
  const viewBox = "0 0 1 1";
  const arrows = useMemo(
    () =>
      overlays.flatMap((row) => (row.data.kind === "arrow" ? [{ row, data: row.data }] : [])),
    [overlays]
  );
  const rects = useMemo(
    () =>
      overlays.flatMap((row) => (row.data.kind === "rect" ? [{ row, data: row.data }] : [])),
    [overlays]
  );
  const highlights = useMemo(
    () =>
      overlays.flatMap((row) =>
        row.data.kind === "highlight" ? [{ row, data: row.data }] : []
      ),
    [overlays]
  );
  const blurs = useMemo(
    () =>
      overlays.flatMap((row) => (row.data.kind === "blur" ? [{ row, data: row.data }] : [])),
    [overlays]
  );
  const texts = useMemo(
    () =>
      overlays.flatMap((row) => (row.data.kind === "text" ? [{ row, data: row.data }] : [])),
    [overlays]
  );

  // Live-rect for rect/highlight/blur drags, computed once so all
  // three branches can share.
  const liveRect =
    draft !== null && draft.kind === "rect-drag" ? rectFromDrag(draft) : null;

  return (
    <svg className="editor-svg" viewBox={viewBox} preserveAspectRatio="none">
      {/* Highlights painted first so they sit beneath rects/arrows. */}
      {highlights.map(({ row, data }) => (
        <HighlightGlyph key={row.id} rect={data.rect} />
      ))}
      {blurs.map(({ row, data }) => (
        <BlurGlyph key={row.id} rect={data.rect} />
      ))}
      {rects.map(({ row, data }) => (
        <RectGlyph
          key={row.id}
          rect={data.rect}
          imageWidthPx={imageWidthPx}
          imageHeightPx={imageHeightPx}
        />
      ))}
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
      {texts.map(({ row, data }) => (
        <TextGlyph
          key={row.id}
          point={data.point}
          body={data.body}
          size={data.size}
          imageWidthPx={imageWidthPx}
          imageHeightPx={imageHeightPx}
        />
      ))}

      {/* Drafts (live-drag preview) rendered last so they're on top. */}
      {draft?.kind === "arrow" && (
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
      {draft?.kind === "rect-drag" && liveRect !== null && (
        <>
          {draft.tool === "highlight" && <HighlightGlyph rect={liveRect} isDraft />}
          {draft.tool === "blur" && <BlurGlyph rect={liveRect} isDraft />}
          {draft.tool === "rect" && (
            <RectGlyph
              rect={liveRect}
              imageWidthPx={imageWidthPx}
              imageHeightPx={imageHeightPx}
              isDraft
            />
          )}
        </>
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
  const geom = computeArrowGeometry({
    from: { x: fromXn, y: fromYn },
    to: { x: toXn, y: toYn },
    imageWidthPx,
    imageHeightPx
  });
  const headPolygon = `${geom.to.x},${geom.to.y} ${geom.baseLeft.x},${geom.baseLeft.y} ${geom.baseRight.x},${geom.baseRight.y}`;
  const stroke = geom.strokeFraction;
  const outline = Math.max(stroke * 0.25, 0.0015);
  const accent = isDraft ? "var(--accent-strong, #ffa33d)" : "var(--accent, #ff8a1f)";
  return (
    <g strokeLinecap="round" strokeLinejoin="round">
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

function RectGlyph({
  rect,
  imageWidthPx,
  imageHeightPx,
  isDraft = false
}: {
  rect: { x: number; y: number; w: number; h: number };
  imageWidthPx: number;
  imageHeightPx: number;
  isDraft?: boolean;
}) {
  // Stroke width scaled by image short-side, like the arrow's. We
  // compute via computeArrowGeometry across the diagonal so the
  // stroke matches the arrow's visual weight on the same image.
  const shortSide = Math.min(imageWidthPx, imageHeightPx);
  const strokeFraction = Math.min(0.012, Math.max(0.003, 8 / shortSide));
  const outline = Math.max(strokeFraction * 0.25, 0.0015);
  const accent = isDraft ? "var(--accent-strong, #ffa33d)" : "var(--accent, #ff8a1f)";
  return (
    <g>
      <rect
        x={rect.x}
        y={rect.y}
        width={rect.w}
        height={rect.h}
        fill="none"
        stroke="white"
        strokeWidth={strokeFraction + outline * 2}
        strokeLinejoin="round"
      />
      <rect
        x={rect.x}
        y={rect.y}
        width={rect.w}
        height={rect.h}
        fill="none"
        stroke={accent}
        strokeWidth={strokeFraction}
        strokeLinejoin="round"
      />
    </g>
  );
}

function HighlightGlyph({
  rect,
  isDraft = false
}: {
  rect: { x: number; y: number; w: number; h: number };
  isDraft?: boolean;
}) {
  // Yellow translucent fill — the marker-pen look. Slightly more
  // opaque on draft so the user sees the drag clearly.
  return (
    <rect
      x={rect.x}
      y={rect.y}
      width={rect.w}
      height={rect.h}
      fill={isDraft ? "rgba(255, 220, 80, 0.45)" : "rgba(255, 220, 80, 0.32)"}
      stroke="none"
    />
  );
}

function BlurGlyph({
  rect,
  isDraft = false
}: {
  rect: { x: number; y: number; w: number; h: number };
  isDraft?: boolean;
}) {
  // Live preview: a translucent gray block with a "frosted" pattern.
  // The actual blur is applied in the bake — the live render just
  // signals "this region will be blurred when copied/exported".
  return (
    <g>
      <rect
        x={rect.x}
        y={rect.y}
        width={rect.w}
        height={rect.h}
        fill={isDraft ? "rgba(40, 40, 50, 0.55)" : "rgba(40, 40, 50, 0.45)"}
        stroke="rgba(255,255,255,0.25)"
        strokeWidth={0.0015}
        strokeDasharray="0.005 0.005"
      />
    </g>
  );
}

function TextGlyph({
  point,
  body,
  size,
  imageWidthPx,
  imageHeightPx
}: {
  point: { x: number; y: number };
  body: string;
  size: "small" | "large";
  imageWidthPx: number;
  imageHeightPx: number;
}) {
  // Font size derived from image short-side, matching the bake.
  const shortSide = Math.min(imageWidthPx, imageHeightPx);
  const sizePx = size === "large" ? shortSide / 30 : shortSide / 60;
  const fontSize = sizePx / shortSide;
  const accent = "var(--accent, #ff8a1f)";
  return (
    <g>
      <text
        x={point.x}
        y={point.y}
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        fontSize={fontSize}
        fontWeight={600}
        fill="white"
        stroke="rgba(0,0,0,0.6)"
        strokeWidth={fontSize * 0.08}
        paintOrder="stroke"
        dominantBaseline="hanging"
      >
        {body}
      </text>
      <text
        x={point.x}
        y={point.y}
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        fontSize={fontSize}
        fontWeight={600}
        fill={accent}
        dominantBaseline="hanging"
      >
        {body}
      </text>
    </g>
  );
}

function TextDraftInput({
  draft,
  inputRef,
  onChange,
  onCommit,
  onCancel
}: {
  draft: DraftText;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onChange: (body: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  // Inline input positioned at the click point. It overlays the
  // SVG text glyph (which is invisible until commit). On Enter or
  // blur, the parent commits via persist; on Escape, cancel.
  const style: CSSProperties = {
    position: "absolute",
    left: `${draft.xn * 100}%`,
    top: `${draft.yn * 100}%`,
    transform: "translateY(-2px)",
    background: "color-mix(in srgb, var(--bg-app) 92%, transparent)",
    color: "var(--accent-bright, #ffa33d)",
    border: "1px solid var(--accent, #ff8a1f)",
    borderRadius: 4,
    padding: "2px 6px",
    font: "600 13px var(--font-sans, system-ui)",
    outline: "none",
    minWidth: 80
  };
  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    onCommit();
  }
  return (
    <form style={style} onSubmit={onSubmit}>
      <input
        ref={inputRef}
        type="text"
        value={draft.body}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder="Type to annotate…"
        style={{
          background: "transparent",
          color: "inherit",
          border: "none",
          outline: "none",
          font: "inherit",
          minWidth: 80
        }}
      />
    </form>
  );
}
