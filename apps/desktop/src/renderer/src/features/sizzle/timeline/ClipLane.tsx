// The clips lane: every clip a segment whose width is its on-screen
// duration. Detail follows the RENDERED width (density ladder, plan §4.5):
// thumbnail + label (+ fit chip) → thumbnail only → a bare tick. Anchored
// clips get the tangerine pin on their left edge, auto clips a hairline,
// and the transition INTO a clip hangs as a pip from the lane's top edge.
//
// Drag (plan §4.4): a grip on each boundary (the left edge of clip 1…N)
// retimes the clip it leads into; a grip on the final clip's right edge
// sets the only end a user can set; the clip body itself drags its start
// past a small threshold (a plain press still selects). While a drag is
// live the lane draws the DRAG-LOCAL windows the timeline hands it — the
// re-flow preview — and nothing is written until release.
//
// Posters are `cacheUrl()` images. Video captures get a neutral placeholder
// — there is no image poster route for videos, and mounting a `<video>`
// per clip (80 at the cap) is the regression this lane exists to avoid.

import type { PointerEvent as ReactPointerEvent, ReactElement } from "react";
import { sizzleTransitionType, type CaptureRecord } from "@pwrsnap/shared";
import { cacheUrl } from "../../../lib/pwrsnap";
import { formatSpan } from "../../shared/video-range";
import { CLIP_DETAIL_FIT_CHIP_PX, clipDetailForWidth } from "./density";
import type { DragKind } from "./retime";
import type { TimelineClip, TimelineModel } from "./timeline-model";

/** A live drag's view of one scene: scene-local clip starts (the re-flow
 *  preview), the final clip's end, and the edge being dragged. */
export type ClipDragView = {
  sceneId: string;
  index: number;
  kind: DragKind;
  starts: number[];
  endSec: number;
  sec: number;
};

export type BeginClipDrag = (
  clip: TimelineClip,
  kind: DragKind,
  event: ReactPointerEvent<HTMLElement>,
  /** True for a body press: the clip follows the hand (pointer offset kept)
   *  and only becomes a drag past a threshold; false for a grip. */
  grab: boolean
) => void;

export function ClipLane({
  model,
  x,
  captureMap,
  selectedClipId,
  onSelectClip,
  visible,
  drag = null,
  onBeginDrag
}: {
  model: TimelineModel;
  x: (sec: number) => number;
  captureMap: Map<string, CaptureRecord>;
  /** Project-axis window on screen; clips outside it are not mounted. Their
   *  geometry is unchanged — this only decides what the DOM carries, which
   *  matters at 80 clips and several screens of width. */
  visible: { startSec: number; endSec: number };
  selectedClipId: string | null;
  onSelectClip: (clip: TimelineClip) => void;
  drag?: ClipDragView | null | undefined;
  /** Absent = read-only lane (no grips, no body drag). */
  onBeginDrag?: BeginClipDrag | undefined;
}): ReactElement {
  return (
    <div className="szt__lane" data-testid="sizzle-timeline-clips">
      {model.scenes.flatMap((scene) => {
        const live = drag !== null && drag.sceneId === scene.sceneId ? drag : null;
        const last = scene.clips.length - 1;
        const onScreen = scene.clips.filter(
          (clip) => clip.endSec >= visible.startSec && clip.startSec <= visible.endSec
        );
        return onScreen.map((clip) => {
          // Drag-local windows while this scene is being dragged; the
          // model's otherwise.
          const startSec =
            live !== null ? scene.startSec + (live.starts[clip.index] ?? clip.localStartSec) : clip.startSec;
          const endSec =
            live !== null
              ? clip.index < last
                ? scene.startSec + (live.starts[clip.index + 1] ?? clip.localEndSec)
                : scene.startSec + live.endSec
              : clip.endSec;
          const durationSec = Math.max(0, endSec - startSec);
          const left = x(startSec);
          const width = Math.max(2, x(endSec) - left);
          const detail = clipDetailForWidth(width);
          const capture = captureMap.get(clip.captureId) ?? null;
          const name = capture?.source_app_name ?? "Capture";
          const isSel = selectedClipId === clip.beatId;
          const isDragging = live !== null && live.index === clip.index;
          const type = sizzleTransitionType(clip.transition);
          const isFade = type !== "cut" && type !== "none";
          const select = (event: { stopPropagation: () => void }): void => {
            event.stopPropagation();
            onSelectClip(clip);
          };
          const retimable = onBeginDrag !== undefined && scene.kind === "sequence" && detail !== "tick";
          const draggable = retimable && clip.index > 0;
          if (detail === "tick") {
            return (
              <button
                key={clip.beatId}
                type="button"
                className={
                  "szt__clip is-tick" +
                  (clip.anchored ? "" : " is-auto") +
                  (isSel ? " is-sel" : "")
                }
                style={{ left: `${left}px` }}
                title={`${name} · ${clip.exact ? "" : "~"}${formatSpan(durationSec)}`}
                aria-label={`Clip ${clip.index + 1}, ${name}`}
                onClick={select}
                onPointerDown={(event) => event.stopPropagation()}
                data-testid={`sizzle-timeline-clip-${clip.beatId}`}
                data-detail="tick"
              />
            );
          }
          return (
            <div key={clip.beatId}>
              <button
                type="button"
                className={
                  "szt__clip" +
                  (isSel ? " is-sel" : "") +
                  (clip.exact ? "" : " is-est") +
                  (draggable ? " is-grab" : "") +
                  (isDragging ? " is-dragging" : "")
                }
                style={{ left: `${left}px`, width: `${width - 1}px` }}
                title={
                  `${name} · ${clip.exact ? "" : "~"}${formatSpan(durationSec)}` +
                  (draggable ? " — drag to retime" : "")
                }
                aria-label={`Clip ${clip.index + 1}, ${name}`}
                aria-pressed={isSel}
                onClick={select}
                onPointerDown={(event) => {
                  if (draggable) onBeginDrag(clip, "start", event, true);
                  else event.stopPropagation();
                }}
                data-testid={`sizzle-timeline-clip-${clip.beatId}`}
                data-detail={detail}
              >
                {clip.anchored || isDragging ? (
                  <span className="szt__pin" />
                ) : clip.pendingAnchor ? (
                  <span className="szt__pin is-pending" title="Phrase anchor — resolves once the narration is synthesized" />
                ) : null}
                <ClipPoster clip={clip} capture={capture} name={name} />
                {detail === "full" ? (
                  <span className="szt__clip-label">
                    <span className="szt__clip-name">{name}</span>
                    <span className="szt__clip-sub">
                      <span className="szt__clip-dur">
                        {clip.exact ? null : <span className="szt__tilde">~</span>}
                        {formatSpan(durationSec)}
                      </span>
                      {capture?.kind === "video" && width >= CLIP_DETAIL_FIT_CHIP_PX ? (
                        <span className="szt__fit">{clip.videoFit}</span>
                      ) : null}
                    </span>
                  </span>
                ) : null}
              </button>
              {clip.index > 0 && !clip.anchored && !isDragging ? (
                <span className="szt__hair" style={{ left: `${left}px` }} />
              ) : null}
              {clip.index > 0 ? (
                <span
                  className={"szt__pip" + (isFade ? " is-fade" : "")}
                  style={{ left: `${left}px` }}
                  title={`Transition: ${type.replace(/-/g, " ")}`}
                >
                  {isFade ? "⟋" : "|"}
                </span>
              ) : null}
              {draggable ? (
                <span
                  className={
                    "szt__grip szt__grip--start" +
                    (isDragging && live?.kind === "start" ? " is-active" : "")
                  }
                  style={{ left: `${left}px` }}
                  title="Drag to retime — the previous clip runs to here"
                  onPointerDown={(event) => onBeginDrag(clip, "start", event, false)}
                  data-testid={`sizzle-timeline-grip-${clip.beatId}`}
                />
              ) : null}
              {retimable && clip.index === last ? (
                <span
                  className={
                    "szt__grip szt__grip--end" + (isDragging && live?.kind === "end" ? " is-active" : "")
                  }
                  style={{ left: `${left + width}px` }}
                  title="Drag to set where the final clip ends"
                  onPointerDown={(event) => onBeginDrag(clip, "end", event, false)}
                  data-testid={`sizzle-timeline-grip-end-${clip.beatId}`}
                />
              ) : null}
            </div>
          );
        });
      })}
    </div>
  );
}

function ClipPoster({
  clip,
  capture,
  name
}: {
  clip: TimelineClip;
  capture: CaptureRecord | null;
  name: string;
}): ReactElement {
  if (capture !== null && capture.kind === "video") {
    return (
      <span className="szt__thumb szt__thumb--video" aria-hidden="true">
        ▶
      </span>
    );
  }
  const src =
    capture !== null
      ? cacheUrl(clip.captureId, 320, "webp", capture.edits_version)
      : cacheUrl(clip.captureId, 320, "webp");
  return (
    <span className="szt__thumb" aria-hidden="true">
      <img src={src} alt="" draggable={false} loading="lazy" decoding="async" title={name} />
    </span>
  );
}
