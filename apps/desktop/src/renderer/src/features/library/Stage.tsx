// Stage — shared canvas + edit toolbar surface for Focus and Reel modes.
//
// Both modes render as plain in-flow divs that occupy `.psl__main`'s
// grid cell (col 2, row 2 of the parent `.psl` grid). They sit
// alongside the topbar / left sidebar / status bar / DetailRail —
// preserving the app chrome instead of taking over the viewport.
//
// Focus mode (dismissible=true): plain div with class `psl__focus`,
// adds the × close button + "back to grid esc" hint inside the
// stage area. Esc dismissal is owned by Library's window keydown
// handler (single source of truth — see Stage.tsx pre-Phase D
// history for why we don't observe a dialog `close` event).
//
// Reel mode (dismissible=false): plain div with class
// `psl__reel-mode`, adds the filmstrip above the stage via the
// `aboveStageSlot` prop. No × button — the user exits Reel via
// the segmented control.
//
// We previously rendered Focus inside a native <dialog> with
// showModal() to get free focus management + Esc + inert-behind +
// ::backdrop styling. The tradeoff didn't pay off: showModal()
// puts content in the browser's top-layer, which means the dialog
// covers the entire viewport (titlebar + sidebar + status bar all
// hidden behind the backdrop), and the Library-level DetailRail
// is also hidden. The user experience the design called for is
// "Focus replaces the grid in the content area," not "Focus takes
// over the whole window." A plain div in the content area gives
// us exactly the right framing without fighting the top-layer.
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
//   Phase C.1 (Stage), C.11 (focus management — Library window keydown).

import { useState, type ReactElement } from "react";
import type { BlurStyle, CaptureRecord } from "@pwrsnap/shared";
import { Editor, type ZoomApi } from "../editor/Editor";
import type { Tool } from "../editor/editor-tools";
import { AppTag } from "../shared/AppIcons";
import { captureSrcUrl } from "../../lib/pwrsnap";
import { DetailRail } from "./DetailRail";
import { EditToolbar } from "./EditToolbar";
import { mapBundleIdToAppId } from "./adapter";
import type { LibraryAction, LibraryView } from "./library-view";

export type StageProps = {
  /** Current library view state — Stage renders for `kind: "focus"` or
   *  `kind: "reel"`. The discriminated union ensures `selectedRecordId`
   *  is non-null when this component mounts. */
  readonly view: Extract<LibraryView, { kind: "focus" | "reel" }>;
  /** The CaptureRecord matching `view.selectedRecordId`. Caller has
   *  already resolved this from the records list. */
  readonly record: CaptureRecord;
  /** When true (Focus mode): shows the × close button + "back to
   *  grid esc" hint, dispatches CLOSE_FOCUS on × click. Esc is
   *  handled at the Library level. When false (Reel mode): no ×
   *  button — the user exits Reel via the segmented control. */
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
  /** Lifted blur-style state. Same shape as tool — Library owns it,
   *  the Editor uses it when committing a new blur overlay and the
   *  EditToolbar's BlurMenu reads + writes it. */
  readonly blurStyle: BlurStyle;
  readonly onBlurStyleChange: (style: BlurStyle) => void;
  /** Optional content to render above the stage — used by Reel mode
   *  to host the filmstrip. Focus passes nothing (no filmstrip). */
  readonly aboveStageSlot?: ReactElement;
};

export function Stage(props: StageProps): ReactElement {
  return props.dismissible ? <FocusStage {...props} /> : <ReelStage {...props} />;
}

/** Focus mode — plain in-flow div in the Library's content area.
 *  Adds the × close button + Esc hint; Esc handling itself lives
 *  in Library's window keydown listener so there's exactly one
 *  authoritative dismissal path. */
function FocusStage(props: StageProps): ReactElement {
  const onClose = (): void => {
    props.dispatch({ type: "CLOSE_FOCUS" });
  };

  return (
    <div className="psl__focus" aria-label="Capture editor">
      <div className="psl__stage-wrap">
        <StageBody {...props} onClose={onClose} />
      </div>
    </div>
  );
}

/** Reel mode — plain in-flow content. No × button. */
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
  blurStyle,
  onBlurStyleChange,
  onClose
}: StageProps & { onClose: () => void }): ReactElement {
  const captureId = record.id;
  void view; // currently unused; kept in props for future variant logic

  // Zoom state for the floating EditToolbar's indicator. Editor's
  // useZoomPan owns the truth; it reports changes via the
  // `onZoomChange` callback. We keep a snapshot in local state so
  // the EditToolbar re-renders when zoom changes. Cleared to null
  // when the Editor unmounts (e.g. navigating between captures).
  const [zoom, setZoom] = useState<ZoomApi>(null);

  const sourceName = record.source_app_name ?? "Unknown app";
  const appId = mapBundleIdToAppId(record.source_app_bundle_id);
  const captured = new Date(record.captured_at);
  const capturedDate = captured.toLocaleString(undefined, {
    month: "short",
    day: "numeric"
  });
  const capturedTime = captured.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit"
  });

  return (
    <>
      <div className="psl__stage-meta">
        <AppTag app={appId} name={sourceName} size="sm" bundleId={record.source_app_bundle_id ?? undefined} />
        <span>
          · {capturedDate} {capturedTime}
        </span>
        <span>
          · {record.width_px}×{record.height_px}
        </span>
        {/* Position counter lives inline at the end of the breadcrumb so
            it can't collide with the X / "back to grid" affordances on
            the right edge. Used to be absolute-positioned at right:60,
            which overlapped the close-hint at right:56. */}
        <span className="psl__stage-pos">
          <b>{posLabel.idx}</b> / {posLabel.total}
        </span>
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

      {/* Stage area — a RECTANGULAR viewport for the canvas-grows
          zoom model. Sized to fill stage-wrap minus a 32px reserve
          for nav-button clearance. The canvas inside is sized by
          useZoomPan: at fit it matches the image aspect (with
          letterbox/pillarbox inside this rectangular viewport); at
          zoom>1 it grows past the viewport and the wrap shows
          scrollbars. Aspect-ratio used to be set here (matching the
          image, for a "framed photo" look) but that prevented the
          canvas from extending into the full stage area when
          zoomed — the visible image stayed clipped to the
          aspect-ratio shape no matter how zoomed in. The visual
          frame is now on the canvas itself (border + box-shadow),
          so the framed-photo look is preserved at fit, and the
          frame grows with the canvas under zoom. Aspect-ratio for
          video captures is still set inline below so the <video>
          element gets a sensible default size. */}
      <div className="psl__stage-img">
        {record.kind === "video" ? (
          // Video captures render as a native <video> player. The
          // overlay editor is image-only (annotation tools operate
          // on PNG/WebP renders) so we don't mount <Editor> here —
          // the GIF/MP4 sub-range editor lives in the float-over
          // and a richer video editor lands in a follow-up.
          <video
            src={captureSrcUrl(record.id)}
            controls
            playsInline
            preload="metadata"
            style={{
              width: "100%",
              height: "100%",
              objectFit: "contain",
              background: "#000",
              display: "block"
            }}
          />
        ) : (
          <Editor
            captureId={captureId}
            chrome="chromeless"
            tool={tool}
            onToolChange={onToolChange}
            blurStyle={blurStyle}
            onZoomChange={setZoom}
          />
        )}
      </div>

      {record.kind !== "video" && (
        <EditToolbar
          tool={tool}
          onChange={onToolChange}
          captureId={record.id}
          sourceWidth={record.width_px}
          sourceHeight={record.height_px}
          zoom={zoom}
          blurStyle={blurStyle}
          onBlurStyleChange={onBlurStyleChange}
        />
      )}
    </>
  );
}

// Re-export DetailRail so Library.tsx can import both from a single
// "stage" entry point if it wants — convenience, not load-bearing.
export { DetailRail };
