// Stage — shared canvas + edit toolbar surface for Focus and Reel modes.
//
// Both modes render as plain in-flow divs that occupy `.psl__main`'s
// grid cell (col 2, row 2 of the parent `.psl` grid). They sit
// alongside the topbar / left sidebar / status bar / DetailRail —
// preserving the app chrome instead of taking over the viewport.
//
// Focus mode (dismissible=true): plain div with class `psl__focus`,
// with the × close button in the top-right — same circular treatment
// as the ←/→ nav buttons, so the three stage affordances read as one
// set. What it does NOT carry any more: the 10px "back to grid esc"
// hint (unreadable over arbitrary screenshot pixels — the × keeps the
// shortcut in its tooltip) and the breadcrumb (source app / date /
// dims), which the DetailRail header already shows 20px to the right.
// The "idx / total" position counter moved to the Library TITLE BAR
// (`.psl__count`), where it is computed from the same filtered set
// ←/→ walk. Esc dismissal is owned by Library's window keydown handler
// (single source of truth — see Stage.tsx pre-Phase D history for why
// we don't observe a dialog `close` event).
//
// Reel mode (dismissible=false): plain div with class
// `psl__reel-mode`, adds the filmstrip above the stage via the
// `aboveStageSlot` prop. No × button — the user exits Reel via the
// segmented control.
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
//   • Prev/Next nav buttons on left/right edges at a FIXED position —
//     50% of the stage pane — for images AND videos. For video that is
//     ~80px below the picture's center (the transport + trim timeline
//     are docked inside the pane), and that is deliberate: anchoring
//     the buttons to the media band was tried and reverted because a
//     mixed image/video set (the default) made ←/→ jump ~80px on every
//     other click. The one control you click repeatedly must not move
//     between items; a static offset beats a moving target.
//   • <Editor chrome="chromeless" tool onToolChange /> for the canvas
//   • <EditToolbar /> floating bottom-center (images only)
//
// The view-state contract this renders against lives on the
// `LibraryView` union in ./library-view.ts.

import { useState, type ReactElement } from "react";
import type { BlurStyle, CaptureRecord } from "@pwrsnap/shared";
import { Editor, type ZoomApi, type LayersPanelApi } from "../editor/Editor";
import type { Tool } from "../editor/editor-tools";
import type { UseEditorToolStateReturn } from "../editor/useEditorToolState";
import { captureSrcUrl } from "../../lib/pwrsnap";
import type { UseVideoTrimRange } from "../shared/useVideoTrimRange";
import { DetailRail } from "./DetailRail";
import { EditToolbar } from "./EditToolbar";
import { VideoStage } from "./VideoStage";
import type { LibraryAction, LibraryView } from "./library-view";

export type StageProps = {
  /** Current library view state — Stage renders for `kind: "focus"` or
   *  `kind: "reel"`. The discriminated union ensures `selectedRecordId`
   *  is non-null when this component mounts. */
  readonly view: Extract<LibraryView, { kind: "focus" | "reel" }>;
  /** The CaptureRecord matching `view.selectedRecordId`. Caller has
   *  already resolved this from the records list. */
  readonly record: CaptureRecord;
  /** When true (Focus mode): shows the × close button, which
   *  dispatches CLOSE_FOCUS. Esc is handled at the Library level.
   *  Also tells `<VideoStage>` whether to grab the keyboard on mount.
   *  When false (Reel mode): no × — the user exits Reel via the
   *  segmented control. */
  readonly dismissible: boolean;
  /** Library reducer dispatcher — Stage dispatches NAVIGATE for prev/
   *  next and CLOSE_FOCUS for dismissible mode. */
  readonly dispatch: (action: LibraryAction) => void;
  /** Neighbor record ids for ←/→ navigation, computed by Library
   *  against the current visible filter. Either may be null (no
   *  neighbor available — at edges or filter has only one record). */
  readonly prevRecordId: string | null;
  readonly nextRecordId: string | null;
  /** The window's ONE video trim-range instance, owned by Library and
   *  shared with the DetailRail's export cards. Threaded through to
   *  `<VideoStage>` so the timeline the user drags and the range the
   *  rail exports are the same object — never a stage-local copy
   *  racing the persisted `defaultRange`. Inert (`captureId: null`)
   *  when the selection isn't a video. */
  readonly videoTrim: UseVideoTrimRange;
  /** Lifted tool state for the chromeless Editor + the floating
   *  EditToolbar. Library owns the source of truth. */
  readonly tool: Tool;
  readonly onToolChange: (tool: Tool) => void;
  /** Phase 3.2 lift: the FULL hook return from `useEditorToolState`,
   *  instantiated once at the Library level. Stage threads it into
   *  both `<Editor>` (so persistOverlay reads the same activeStyle)
   *  AND `<EditToolbar>` (so popover picks land in the same hook).
   *  Without this single source of truth, style picks vanish on
   *  drag-commit because the popover and the editor write to two
   *  different hook instances. */
  readonly toolState: UseEditorToolStateReturn;
  /** Lifted blur-style state. Same shape as tool — Library owns it,
   *  the Editor uses it when committing a new blur overlay and the
   *  EditToolbar's ToolStylePopover writes through to it via the
   *  hook-mirror effect (post-BlurMenu-fold). */
  readonly blurStyle: BlurStyle;
  readonly onBlurStyleChange: (style: BlurStyle) => void;
  /** Layers-panel wiring — forwarded straight into the chromeless
   *  Editor. Library owns the mirrored selection + the published API
   *  (so the sibling DetailRail's Layers tab can drive the canvas);
   *  Stage is a pass-through, same as `onZoomChange`. */
  readonly onSelectionChange: (ids: readonly string[]) => void;
  readonly onLayersApi: (api: LayersPanelApi | null) => void;
  /** Optional content to render above the stage — used by Reel mode
   *  to host the filmstrip. Focus passes nothing (no filmstrip). */
  readonly aboveStageSlot?: ReactElement;
};

export function Stage(props: StageProps): ReactElement {
  return props.dismissible ? <FocusStage {...props} /> : <ReelStage {...props} />;
}

/** Focus mode — plain in-flow div in the Library's content area.
 *  Adds the × close button; Esc handling itself lives in Library's
 *  window keydown listener so there's exactly one authoritative
 *  dismissal path. */
function FocusStage(props: StageProps): ReactElement {
  return (
    <div
      className="psl__focus"
      aria-label="Capture editor"
      data-capture-id={props.record.id}
    >
      <div className="psl__stage-wrap">
        <StageBody {...props} />
      </div>
    </div>
  );
}

/** Reel mode — plain in-flow content. */
function ReelStage(props: StageProps): ReactElement {
  return (
    <div className="psl__reel-mode">
      {props.aboveStageSlot}
      <div className="psl__stage-wrap">
        <StageBody {...props} />
      </div>
    </div>
  );
}

/** Body rendered inside both Focus and Reel wrappers. Renders the
 *  canvas + toolbar + nav + (Focus only) the × close button. The DetailRail renders OUTSIDE Stage at
 *  the Library level — both Focus and Reel get the rail visible to
 *  the right of the stage. */
function StageBody({
  view,
  record,
  dismissible,
  dispatch,
  prevRecordId,
  nextRecordId,
  videoTrim,
  tool,
  onToolChange,
  toolState,
  blurStyle,
  onBlurStyleChange,
  onSelectionChange,
  onLayersApi
}: StageProps): ReactElement {
  const captureId = record.id;
  void view; // currently unused; kept in props for future variant logic

  // Zoom state for the floating EditToolbar's indicator. Editor's
  // useZoomPan owns the truth; it reports changes via the
  // `onZoomChange` callback. We keep a snapshot in local state so
  // the EditToolbar re-renders when zoom changes. Cleared to null
  // when the Editor unmounts (e.g. navigating between captures).
  const [zoom, setZoom] = useState<ZoomApi>(null);

  // × close, then ←/→ prev/next — all three are siblings of the canvas
  // inside the stage wrap. The nav pair sits at a fixed `top: 50%` for
  // every capture kind; see the header comment for why that is NOT
  // anchored to the video frame band.
  return (
    <>
      {dismissible && (
        <button
          type="button"
          className="psl__focus-close"
          // Stable hook for the E2E specs' closeEditorWindow() helper.
          data-testid="focus-back"
          title="Back to grid (Esc)"
          onClick={() => dispatch({ type: "CLOSE_FOCUS" })}
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
      <div className={`psl__stage-img${record.kind === "video" ? " is-video" : ""}`}>
        {record.kind === "video" ? (
          // Video captures render through VideoStage: chromeless
          // <video> + our transport + the filmstrip/waveform trim
          // timeline. The overlay editor is image-only (annotation
          // tools operate on PNG/WebP renders) so we don't mount
          // <Editor> here. Trim in/out persists to the record's
          // `defaultRange` and drives every export. Phase B editing
          // (speed / crop / split / cursor highlight) is a follow-up.
          record.video !== null && record.video !== undefined ? (
            <VideoStage
              record={record}
              video={record.video}
              trim={videoTrim}
              // Reel keeps ←/→ on prev/next-capture navigation until
              // the user clicks into the video; Focus grabs the
              // keyboard on mount. `dismissible` is the mode flag.
              reel={!dismissible}
            />
          ) : (
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
          )
        ) : (
          <Editor
            captureId={captureId}
            chrome="chromeless"
            tool={tool}
            onToolChange={onToolChange}
            toolState={toolState}
            blurStyle={blurStyle}
            onZoomChange={setZoom}
            onSelectionChange={onSelectionChange}
            onLayersApi={onLayersApi}
          />
        )}
      </div>

      {record.kind !== "video" && (
        <EditToolbar
          tool={tool}
          onChange={onToolChange}
          toolState={toolState}
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
