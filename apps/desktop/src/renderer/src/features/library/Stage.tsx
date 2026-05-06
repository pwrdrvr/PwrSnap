// Stage — shared canvas + edit toolbar surface for Focus and Reel modes.
//
// Focus mode (dismissible=true): renders inside a native <dialog>
// element with showModal() — gets free focus management, ESC handling,
// inert-behind, and ::backdrop styling. Electron 41 ships Chromium 146
// which fully supports <dialog> and the closedby="any" attribute. See
// AGENTS.md / framework-docs research in the plan for the rationale.
//
// Reel mode (dismissible=false): renders as a plain in-flow div in
// the Library's main pane. Reel is not modal — the user toggles
// between Reel and Grid via the segmented control.
//
// Both modes share:
//   • Top breadcrumb (capture metadata)
//   • Position counter ("5 / 32")
//   • Prev/Next nav buttons on left/right edges
//   • <Editor chrome="chromeless" tool onToolChange /> for the canvas
//   • <EditToolbar /> floating bottom-center
//
// Plan reference:
//   docs/plans/2026-05-05-001-feat-library-three-state-view-model-plan.md
//   Phase C.1 (Stage), C.10 (mousedown backdrop dismiss),
//   C.11 (focus management).

import { useEffect, useRef, type ReactElement } from "react";
import type { CaptureRecord } from "@pwrsnap/shared";
import { Editor, type Tool } from "../editor/Editor";
import { DetailRail } from "./DetailRail";
import { EditToolbar } from "./EditToolbar";
import type { LibraryAction, LibraryView } from "./library-view";

export type StageProps = {
  /** Current library view state — Stage renders for `kind: "focus"` or
   *  `kind: "reel"`. The discriminated union ensures `selectedRecordId`
   *  is non-null when this component mounts. */
  readonly view: Extract<LibraryView, { kind: "focus" | "reel" }>;
  /** The CaptureRecord matching `view.selectedRecordId`. Caller has
   *  already resolved this from the records list. */
  readonly record: CaptureRecord;
  /** When true (Focus mode): renders inside a native <dialog>, shows
   *  the × close button, dispatches CLOSE_FOCUS on backdrop click /
   *  Esc / × click. When false (Reel mode): renders as in-flow content,
   *  no × button — the user exits Reel via the segmented control. */
  readonly dismissible: boolean;
  /** Library reducer dispatcher — Stage dispatches NAVIGATE for prev/
   *  next and CLOSE_FOCUS for dismissible mode. */
  readonly dispatch: (action: LibraryAction) => void;
  /** Position counter for the top-right of the stage ("idx / total"). */
  readonly posLabel: { idx: number; total: number };
  /** Neighbor record ids for ←/→ navigation, computed by Library
   *  against the current visible filter. Either may be null (no
   *  neighbor available — at edges or filter has only one record). */
  readonly prevRecordId: string | null;
  readonly nextRecordId: string | null;
  /** Lifted tool state for the chromeless Editor + the floating
   *  EditToolbar. Library owns the source of truth. */
  readonly tool: Tool;
  readonly onToolChange: (tool: Tool) => void;
  /** Optional content to render above the stage — used by Reel mode
   *  to host the filmstrip. Focus passes nothing (no filmstrip). */
  readonly aboveStageSlot?: ReactElement;
  /** Optional DetailRail content to render inside the Focus dialog.
   *  Required because <dialog showModal()> renders in the top-layer
   *  and visually obscures everything underneath, including a rail
   *  rendered at the Library level. Reel mode does NOT use this —
   *  Reel is in-flow, so the Library-level rail is naturally
   *  visible to its right. */
  readonly detailRailSlot?: ReactElement;
};

export function Stage(props: StageProps): ReactElement {
  return props.dismissible ? <FocusStage {...props} /> : <ReelStage {...props} />;
}

/** Focus mode — wraps the stage in a native <dialog> for free focus
 *  management + ESC + inert-behind. */
function FocusStage(props: StageProps): ReactElement {
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Open the dialog on mount; close it (without state-dispatch
  // side effects) on unmount.
  //
  // We deliberately DO NOT attach a `close` event listener and do NOT
  // dispatch CLOSE_FOCUS from inside this effect. Reason: under React
  // 18 StrictMode (dev), the effect runs twice on mount with a
  // cleanup in between. The cleanup calls `dlg.close()` which queues
  // a `close` event asynchronously; by the time it fires, the
  // re-mounted effect has attached a NEW listener, which would catch
  // the stale event and dispatch CLOSE_FOCUS — closing the dialog
  // we JUST opened. User-visible symptom: cell click highlights but
  // Focus never appears to open.
  //
  // Instead: every user-interaction path that should close Focus
  // dispatches CLOSE_FOCUS explicitly:
  //   • Esc → Library's window keydown handler dispatches CLOSE_FOCUS
  //     (it then propagates here as a state change, unmounting Stage,
  //     whose cleanup calls dlg.close() for DOM teardown only)
  //   • × button → onClose handler below dispatches CLOSE_FOCUS
  //   • Backdrop mousedown → same
  //   • Browser's built-in Esc (which fires cancel→close on the
  //     dialog) is harmless because Library's keydown is the
  //     authoritative path; the redundant browser-close just becomes
  //     a no-op dlg.close() in cleanup.
  useEffect(() => {
    const dlg = dialogRef.current;
    if (dlg === null) return;
    if (!dlg.open) dlg.showModal();
    return () => {
      if (dlg.open) dlg.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onClose = (): void => {
    props.dispatch({ type: "CLOSE_FOCUS" });
  };

  return (
    <dialog
      ref={dialogRef}
      className="psl__focus"
      aria-label="Capture editor"
      // Backdrop dismiss on mousedown (NOT click). A user mid-rect-
      // drag who drags off the canvas onto the backdrop and releases
      // there would otherwise fire `click` on the backdrop and
      // dismiss mid-stroke (julik-frontend-races concern #10).
      // mousedown-with-target-check is the canonical fix.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <StageBody {...props} onClose={onClose} />
      {props.detailRailSlot}
    </dialog>
  );
}

/** Reel mode — plain in-flow content. No dialog, no × button, no
 *  backdrop dismiss. */
function ReelStage(props: StageProps): ReactElement {
  return (
    <div className="psl__reel-mode">
      {props.aboveStageSlot}
      <div className="psl__stage-wrap">
        <StageBody {...props} onClose={() => undefined} />
      </div>
    </div>
  );
}

/** Body rendered inside both Focus dialog and Reel wrapper.
 *  Renders the breadcrumb + canvas + toolbar + nav. The
 *  DetailRail renders OUTSIDE Stage at the Library level — both
 *  Focus and Reel get the rail visible to the right of the stage. */
function StageBody({
  view,
  record,
  dismissible,
  dispatch,
  posLabel,
  prevRecordId,
  nextRecordId,
  tool,
  onToolChange,
  onClose
}: StageProps & { onClose: () => void }): ReactElement {
  const captureId = record.id;
  void view; // currently unused; kept in props for future variant logic

  return (
    <>
      <div className="psl__stage-meta">
        <span className="ps-tag">{record.source_app_name ?? "Unknown app"}</span>
        <b>{record.source_app_name ?? "Capture"}</b>
        <span>
          · {record.width_px}×{record.height_px}
        </span>
      </div>
      <div className="psl__stage-pos">
        <b>{posLabel.idx}</b> / {posLabel.total}
      </div>

      {dismissible && (
        <>
          <button
            type="button"
            className="psl__focus-close"
            title="Back to grid (Esc)"
            onClick={onClose}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            >
              <path d="M5 5l14 14M19 5L5 19" />
            </svg>
          </button>
          <div className="psl__focus-close-hint">
            back to grid
            <span className="ps-kbd">esc</span>
          </div>
        </>
      )}

      <button
        type="button"
        className="psl__stage-nav is-prev"
        title="Previous (←)"
        disabled={prevRecordId === null}
        onClick={() => {
          if (prevRecordId !== null) dispatch({ type: "NAVIGATE", recordId: prevRecordId });
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="m15 6-6 6 6 6" />
        </svg>
      </button>
      <button
        type="button"
        className="psl__stage-nav is-next"
        title="Next (→)"
        disabled={nextRecordId === null}
        onClick={() => {
          if (nextRecordId !== null) dispatch({ type: "NAVIGATE", recordId: nextRecordId });
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
      </button>

      <div className="psl__stage-img">
        <Editor
          captureId={captureId}
          chrome="chromeless"
          tool={tool}
          onToolChange={onToolChange}
        />
      </div>

      <EditToolbar tool={tool} onChange={onToolChange} />
    </>
  );
}

// Re-export DetailRail so Library.tsx can import both from a single
// "stage" entry point if it wants — convenience, not load-bearing.
export { DetailRail };
