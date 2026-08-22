// The clips lane: every clip a segment whose width is its on-screen
// duration. Detail follows the RENDERED width (density ladder, plan §4.5):
// thumbnail + label (+ fit chip) → thumbnail only → a bare tick. Anchored
// clips get the tangerine pin on their left edge, auto clips a hairline,
// and the transition INTO a clip hangs as a pip from the lane's top edge.
//
// Posters are `cacheUrl()` images. Video captures get a neutral placeholder
// — there is no image poster route for videos, and mounting a `<video>`
// per clip (80 at the cap) is the regression this lane exists to avoid.

import type { ReactElement } from "react";
import { sizzleTransitionType, type CaptureRecord } from "@pwrsnap/shared";
import { cacheUrl } from "../../../lib/pwrsnap";
import { formatSpan } from "../../shared/video-range";
import { CLIP_DETAIL_FIT_CHIP_PX, clipDetailForWidth } from "./density";
import type { TimelineClip, TimelineModel } from "./timeline-model";

export function ClipLane({
  model,
  x,
  captureMap,
  selectedClipId,
  onSelectClip
}: {
  model: TimelineModel;
  x: (sec: number) => number;
  captureMap: Map<string, CaptureRecord>;
  selectedClipId: string | null;
  onSelectClip: (clip: TimelineClip) => void;
}): ReactElement {
  return (
    <div className="szt__lane" data-testid="sizzle-timeline-clips">
      {model.scenes.flatMap((scene) =>
        scene.clips.map((clip) => {
          const left = x(clip.startSec);
          const width = Math.max(2, x(clip.endSec) - left);
          const detail = clipDetailForWidth(width);
          const capture = captureMap.get(clip.captureId) ?? null;
          const name = capture?.source_app_name ?? "Capture";
          const isSel = selectedClipId === clip.beatId;
          const type = sizzleTransitionType(clip.transition);
          const isFade = type !== "cut" && type !== "none";
          const select = (event: { stopPropagation: () => void }): void => {
            event.stopPropagation();
            onSelectClip(clip);
          };
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
                title={`${name} · ${clip.exact ? "" : "~"}${formatSpan(clip.durationSec)}`}
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
                  "szt__clip" + (isSel ? " is-sel" : "") + (clip.exact ? "" : " is-est")
                }
                style={{ left: `${left}px`, width: `${width - 1}px` }}
                title={`${name} · ${clip.exact ? "" : "~"}${formatSpan(clip.durationSec)}`}
                aria-label={`Clip ${clip.index + 1}, ${name}`}
                aria-pressed={isSel}
                onClick={select}
                onPointerDown={(event) => event.stopPropagation()}
                data-testid={`sizzle-timeline-clip-${clip.beatId}`}
                data-detail={detail}
              >
                {clip.anchored ? (
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
                        {formatSpan(clip.durationSec)}
                      </span>
                      {capture?.kind === "video" && width >= CLIP_DETAIL_FIT_CHIP_PX ? (
                        <span className="szt__fit">{clip.videoFit}</span>
                      ) : null}
                    </span>
                  </span>
                ) : null}
              </button>
              {clip.index > 0 && !clip.anchored ? (
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
            </div>
          );
        })
      )}
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
