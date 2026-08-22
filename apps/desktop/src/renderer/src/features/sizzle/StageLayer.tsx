// One layer of a preview stage: the picture for a clip, plus the CSS
// animations that make it move.
//
// Shared by the per-scene stage (`PreviewStage.tsx`) and the reel player
// (`ReelPlayer.tsx`) so the two cannot drift — they must agree, because
// they render the same clip at the same instant and a user flips between
// them while judging a cut.
//
// Both animations are driven by TIME, not by React: the transition and
// the Ken Burns each get a `animation-delay` of minus-the-elapsed-time,
// so the browser advances them on the compositor while the scene plays
// and re-renders only when the clip changes. `animationPlayState` parks
// them when paused, which makes a scrub land on the exact frame.

import type { CSSProperties, ReactElement, RefObject } from "react";
import type { CaptureRecord, SizzleTransitionType } from "@pwrsnap/shared";
import { cacheUrl, captureSrcUrl } from "../../lib/pwrsnap";
import type { KenBurnsDirection } from "./preview-blend";

/** Poster width requested from the cache for a stage-sized picture. */
const STAGE_POSTER_PX = 800;

export type StageBlendStyle = {
  type: SizzleTransitionType;
  durationSec: number;
  /** Seconds elapsed into the transition at the current playhead. */
  elapsedSec: number;
};

/** A CSS animation parked `elapsedSec` into a `durationSec` run. */
export function timedAnimation(
  name: string,
  durationSec: number,
  elapsedSec: number,
  playing: boolean
): CSSProperties {
  const dur = Math.max(0.05, durationSec);
  const at = Math.min(dur, Math.max(0, elapsedSec));
  return {
    animationName: name,
    animationDuration: `${dur.toFixed(3)}s`,
    animationDelay: `-${at.toFixed(3)}s`,
    animationTimingFunction: "linear",
    animationFillMode: "both",
    animationPlayState: playing ? "running" : "paused"
  };
}

export function StageLayer({
  role,
  captureId,
  capture,
  kenBurns,
  kenBurnsDurationSec,
  kenBurnsElapsedSec,
  blend,
  playing,
  videoRef,
  posterStartSec,
  dataBeat,
  testId
}: {
  role: "outgoing" | "incoming";
  captureId: string;
  capture: CaptureRecord | null;
  /** Null for video clips (the footage already moves). */
  kenBurns: KenBurnsDirection | null;
  kenBurnsDurationSec: number;
  kenBurnsElapsedSec: number;
  /** Non-null only while a transition into/out of this layer runs. */
  blend: StageBlendStyle | null;
  playing: boolean;
  /** Present only for the live player on the outgoing layer. */
  videoRef?: RefObject<HTMLVideoElement | null> | undefined;
  /** Where an incoming video's still should be parked (its trim start). */
  posterStartSec?: number | undefined;
  /** Value for `data-beat` — the caller's identity for this clip. */
  dataBeat: string;
  testId: string;
}): ReactElement {
  const blendStyle =
    blend === null
      ? undefined
      : timedAnimation(`szl-xf-${role}-${blend.type}`, blend.durationSec, blend.elapsedSec, playing);
  const isVideo = capture !== null && capture.kind === "video";
  let media: ReactElement;
  if (capture === null && isMissing(captureId)) {
    media = <span className="szl__sequence-preview-empty">Missing capture</span>;
  } else if (isVideo) {
    media =
      videoRef !== undefined ? (
        <video ref={videoRef} key={captureId} src={captureSrcUrl(captureId)} muted playsInline />
      ) : (
        // A still of the incoming clip, parked at the frame the export
        // will cut to — never a second live player.
        <video
          key={`still:${captureId}`}
          src={`${captureSrcUrl(captureId)}#t=${Math.max(0, posterStartSec ?? 0).toFixed(3)}`}
          muted
          playsInline
          preload="metadata"
        />
      );
  } else {
    // A dip passes through a solid colour: the LAYER is the colour and the
    // media arrives in the dip's second half. That reveal has to be set
    // here, inline, because Ken Burns is also inline — a CSS rule using
    // `animation-duration: inherit` loses to any inline style, which left
    // the image at opacity 0 for the whole dip and then hard-cut it in.
    const dipping = blend !== null && (blend.type === "dip-black" || blend.type === "dip-white");
    const mediaStyle =
      dipping && blend !== null
        ? timedAnimation("szl-xf-dip-media", blend.durationSec, blend.elapsedSec, playing)
        : kenBurns !== null
          ? timedAnimation(`szl-kb-${kenBurns}`, kenBurnsDurationSec, kenBurnsElapsedSec, playing)
          : undefined;
    media = (
      <img
        src={cacheUrl(captureId, STAGE_POSTER_PX, "webp", capture?.edits_version)}
        alt=""
        draggable={false}
        style={mediaStyle}
        data-kb={kenBurns ?? undefined}
      />
    );
  }
  return (
    <div
      className={`szl__sequence-preview-layer is-${role}` + (blend !== null ? ` is-${blend.type}` : "")}
      style={blendStyle}
      data-testid={testId}
      data-beat={dataBeat}
      data-progress={blend !== null ? (blend.elapsedSec / Math.max(0.05, blend.durationSec)).toFixed(3) : undefined}
    >
      {media}
    </div>
  );
}

/** A capture id with no record loaded yet is still worth a poster attempt
 *  (the cache serves by id); only a blank id is genuinely missing. */
function isMissing(captureId: string): boolean {
  return captureId.trim().length === 0;
}
