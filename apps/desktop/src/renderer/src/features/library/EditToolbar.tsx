// Floating bottom-center edit toolbar for the Library's Stage
// component (Focus + Reel modes). Shares tool state with the
// chromeless Editor via lifted React state — Library's Library.tsx
// owns `tool` + `setTool` and passes them to both <Stage> (which
// forwards to <Editor chrome="chromeless" tool onToolChange />) and
// to this component.
//
// v1 editor polish (this round) adds:
//   • Drag handle on the left edge of the toolbar. Click-drag the
//     grip to reposition the floating toolbar. Position persists for
//     the current app instance (module-level state) — resets to the
//     default bottom-center on next app launch. Double-click the
//     grip to snap back to default mid-session.
//   • Reset button at the right end. Two-click confirm pattern (the
//     button morphs to "Confirm?" for ~3s on first click; second
//     click within the window wipes every overlay on the capture).
//     Reveal-in-Finder is intentionally NOT in this toolbar — it's
//     a file-management action, not an editing tool, and DetailRail's
//     "File" button already covers it.
//
// ⌘Z / ⌘⇧Z undo+redo bindings are wired by the chromeless Editor's
// useUndoRedo hook (window-level keydown listener) — no visible
// buttons in this floating toolbar yet because the undo state lives
// inside Editor and exposing it here would need a Library-level lift.

import { Fragment, useEffect, useRef, useState, type ReactElement } from "react";
import { TOOLS, type Tool } from "../editor/editor-tools";
import type { ZoomApi } from "../editor/Editor";
import { ZoomMenu } from "../editor/ZoomMenu";
import { dispatch, subscribe } from "../../lib/pwrsnap";

const RESET_CONFIRM_WINDOW_MS = 3_000;

export type EditToolbarProps = {
  readonly tool: Tool;
  readonly onChange: (next: Tool) => void;
  /** Required for the Reset button. Optional in the type so Stage
   *  can still render the toolbar before a record selects (rare;
   *  Reset is disabled when undefined). */
  readonly captureId?: string;
  /** Editor's current zoom snapshot — `null` until the Editor mounts
   *  and reports its first scale, or after unmount. When null the
   *  zoom indicator is hidden (no useful state to show). */
  readonly zoom?: ZoomApi;
};

/** Module-level position store. Lives across mounts (Stage may
 *  unmount the toolbar when the user toggles into Reel/Grid view),
 *  but resets each app launch because the module is fresh. `null`
 *  means "use the default CSS bottom-center position." */
let savedPosition: { x: number; y: number } | null = null;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function EditToolbar({
  tool,
  onChange,
  captureId,
  zoom
}: EditToolbarProps): ReactElement {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(savedPosition);
  // Two-click confirm state for Reset. `null` = idle; non-null =
  // armed timestamp. Auto-disarms after RESET_CONFIRM_WINDOW_MS so a
  // stale armed state doesn't bite the user later.
  const [resetArmedAt, setResetArmedAt] = useState<number | null>(null);
  useEffect(() => {
    if (resetArmedAt === null) return;
    const t = setTimeout(() => setResetArmedAt(null), RESET_CONFIRM_WINDOW_MS);
    return () => clearTimeout(t);
  }, [resetArmedAt]);
  // Disarm when the user switches captures — an armed state on
  // capture A would otherwise confirm against capture B on next click.
  useEffect(() => {
    setResetArmedAt(null);
  }, [captureId]);

  // Self-track the overlay count via overlays:list + the existing
  // events:overlays:changed broadcast. Editor fetches the same data
  // separately for rendering; both paths converge on the same view.
  const [overlayCount, setOverlayCount] = useState(0);
  useEffect(() => {
    if (captureId === undefined) {
      setOverlayCount(0);
      return undefined;
    }
    let cancelled = false;
    const refetch = async (): Promise<void> => {
      const result = await dispatch("overlays:list", { captureId });
      if (cancelled || !result.ok) return;
      setOverlayCount(result.value.length);
    };
    void refetch();
    const unsubscribe = subscribe("events:overlays:changed", (payload) => {
      const p = payload as { captureId?: string };
      if (p.captureId !== undefined && p.captureId !== captureId) return;
      void refetch();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [captureId]);
  // Persist to module-level on every change so a remount picks up
  // the same position.
  useEffect(() => {
    savedPosition = position;
  }, [position]);

  // Drag tracking. We compute the new position from clientX/clientY +
  // the original offset of the toolbar at drag-start, so the grip
  // stays under the cursor regardless of where the user clicked
  // within it.
  const dragStart = useRef<{
    pointerX: number;
    pointerY: number;
    toolbarLeft: number;
    toolbarTop: number;
  } | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);

  function onGripPointerDown(event: React.PointerEvent<HTMLButtonElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const toolbar = toolbarRef.current;
    if (toolbar === null) return;
    const rect = toolbar.getBoundingClientRect();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    dragStart.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      toolbarLeft: rect.left,
      toolbarTop: rect.top
    };
  }
  function onGripPointerMove(event: React.PointerEvent<HTMLButtonElement>): void {
    if (dragStart.current === null) return;
    const dx = event.clientX - dragStart.current.pointerX;
    const dy = event.clientY - dragStart.current.pointerY;
    const toolbar = toolbarRef.current;
    if (toolbar === null) return;
    // Clamp so at least HOLD_MARGIN_PX of the toolbar (containing the
    // grip) stays visible on every edge. Otherwise the user could
    // drag it entirely off-screen and have to know "double-click the
    // grip to reset" — but they can't see the grip to do that.
    const rect = toolbar.getBoundingClientRect();
    const HOLD_MARGIN_PX = 32;
    const minX = HOLD_MARGIN_PX - rect.width;
    const maxX = window.innerWidth - HOLD_MARGIN_PX;
    const minY = 0;
    const maxY = window.innerHeight - HOLD_MARGIN_PX;
    setPosition({
      x: clamp(dragStart.current.toolbarLeft + dx, minX, maxX),
      y: clamp(dragStart.current.toolbarTop + dy, minY, maxY)
    });
  }
  function onGripPointerUp(event: React.PointerEvent<HTMLButtonElement>): void {
    if (dragStart.current === null) return;
    (event.target as HTMLElement).releasePointerCapture(event.pointerId);
    dragStart.current = null;
  }
  function onGripDoubleClick(): void {
    setPosition(null);
  }

  // When a custom position is in effect, switch from `position:
  // absolute` (default, positioned-ancestor-relative) to `position:
  // fixed` (viewport-relative). The drag math uses
  // `getBoundingClientRect()` which produces viewport-relative coords;
  // applying those as `left`/`top` under `position: absolute` would
  // double-offset the toolbar by the Stage wrapper's distance from
  // the viewport (the sidebar width + any topbar height), making the
  // toolbar jump away from the cursor at drag-start. Fixed positioning
  // matches the coordinate space and keeps the grip directly under
  // the pointer.
  const style: React.CSSProperties =
    position === null
      ? {}
      : {
          position: "fixed",
          left: position.x,
          top: position.y,
          bottom: "auto",
          transform: "none"
        };

  return (
    <div
      ref={toolbarRef}
      className={"psl__edit-toolbar" + (position === null ? "" : " is-positioned")}
      role="toolbar"
      aria-label="Annotation tools"
      style={style}
      // Stop pointer-down from bubbling to the canvas behind. Without
      // this, clicking a tool button inside the canvas's pointer-down
      // area would also fire the canvas's drag-to-draw handler — the
      // "I clicked Rect and accidentally drew on the canvas" bug
      // class julik flagged. mousedown (not click) because the canvas
      // listens for pointerdown for drag-start. Plan §5
      // (in-canvas-toolbar pattern).
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="psl__et-grip"
        aria-label="Drag toolbar (double-click to reset)"
        title="Drag to move · double-click to reset"
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
      {TOOLS.map((t, i) => (
        <Fragment key={t.id}>
          {/* Vertical separator after the first tool (Pointer) —
              divides the "select / inspect" tool from the "draw"
              tools. Mirrors the design's separator placement; the
              design also has a separator before color swatches +
              magic wand + undo, but those clusters aren't rendered
              in this phase. */}
          {i === 1 && <span className="psl__et-sep" aria-hidden="true" />}
          <button
            type="button"
            className={"psl__et-btn" + (tool === t.id ? " is-active" : "")}
            onClick={() => onChange(t.id)}
            title={`${t.label} (${t.key})`}
          >
            {t.icon}
            <span>{t.label}</span>
            <span className="psl__et-btn-key">{t.key}</span>
          </button>
        </Fragment>
      ))}
      <span className="psl__et-sep" aria-hidden="true" />
      <ResetButton
        captureId={captureId}
        overlayCount={overlayCount}
        armed={resetArmedAt !== null}
        onArm={() => setResetArmedAt(Date.now())}
        onConfirm={async () => {
          if (captureId === undefined) return;
          setResetArmedAt(null);
          const list = await dispatch("overlays:list", { captureId });
          if (!list.ok) return;
          // Sequentially — the overlays handler updates app_stats /
          // edits_version per row + broadcasts. Parallel deletes would
          // race those side-effects.
          for (const row of list.value) {
            // eslint-disable-next-line no-await-in-loop
            await dispatch("overlays:delete", { id: row.id });
          }
        }}
      />
      {zoom !== null && zoom !== undefined && (
        <>
          <span className="psl__et-sep" aria-hidden="true" />
          <ZoomMenu zoom={zoom} />
        </>
      )}
    </div>
  );
}

function ResetButton({
  captureId,
  overlayCount,
  armed,
  onArm,
  onConfirm
}: {
  captureId: string | undefined;
  overlayCount: number;
  armed: boolean;
  onArm: () => void;
  onConfirm: () => void;
}): ReactElement {
  const disabled = captureId === undefined || overlayCount === 0;
  return (
    <button
      type="button"
      className={"psl__et-btn psl__et-btn--reset" + (armed ? " is-armed" : "")}
      title={
        armed
          ? "Click again to confirm — removes every overlay"
          : "Reset to original (remove all overlays)"
      }
      disabled={disabled}
      onClick={() => {
        if (armed) onConfirm();
        else onArm();
      }}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        {/* Counter-clockwise arrow circling back — "undo all the way" */}
        <path d="M3 12a9 9 0 1 0 3-6.7" />
        <path d="M3 4v5h5" />
      </svg>
      <span>
        {armed ? `Confirm? · ${overlayCount}` : "Reset"}
      </span>
    </button>
  );
}
