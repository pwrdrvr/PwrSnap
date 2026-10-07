import { useMemo } from "react";
import { PresenterLayer, type PresenterEditing } from "../camera/PresenterLayer";
import { useActivePresenterSpan, videoTimeSubscribe } from "../camera/useActivePresenterSpan";
import { applyPresenterAction } from "../camera/usePresenter";
import { geometryFor, resolvePresenterStyle, type AvatarStyle } from "@pwrsnap/shared";
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
  avatar,
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
  testId,
  presenterEdit
}: {
  avatar?: AvatarStyle | undefined;
  /** Set only while this scene's presenter can be edited on the stage
   *  (the paused, settled outgoing layer). */
  presenterEdit?: ScenePresenterEdit | undefined;
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
        <video style={capture?.video?.camera ? { objectFit: "contain" } : undefined} ref={videoRef} key={captureId} src={captureSrcUrl(captureId)} muted playsInline />
      ) : (
        // A still of the incoming clip, parked at the frame the export
        // will cut to — never a second live player.
        <video
          key={`still:${captureId}`}
          style={capture?.video?.camera ? { objectFit: "contain" } : undefined}
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
      {capture?.video?.camera && (
        // The reel stage is the 16:9 output canvas, so the presenter is
        // placed against the whole layer, not the letterboxed picture.
        <ScenePresenter
          capture={capture}
          videoRef={videoRef}
          avatar={avatar}
          time={posterStartSec ?? 0}
          edit={presenterEdit}
        />
      )}
    </div>
  );
}

/** A capture id with no record loaded yet is still worth a poster attempt
 *  (the cache serves by id); only a blank id is genuinely missing. */
function isMissing(captureId: string): boolean {
  return captureId.trim().length === 0;
}

/** Editing a scene's presenter on the reel stage. Every change lands on
 *  the SCENE's own presenter, never the recording's; `null` gives the
 *  scene back to the recording. */
export type ScenePresenterEdit = {
  readonly selected: boolean;
  readonly onSelect: (selected: boolean) => void;
  readonly onChange: (avatar: AvatarStyle | null) => void;
};

/** A scene's presenter: its own when it has one; otherwise the
 *  recording's, piece by piece, following the clip's source time. */
function ScenePresenter({
  capture,
  videoRef,
  avatar,
  time,
  edit
}: {
  readonly capture: CaptureRecord;
  readonly videoRef: RefObject<HTMLVideoElement | null> | undefined;
  readonly avatar: AvatarStyle | undefined;
  readonly time: number;
  readonly edit: ScenePresenterEdit | undefined;
}): ReactElement | null {
  const camera = capture.video?.camera;
  const spans = useMemo(
    () => (avatar === undefined ? (capture.video?.avatarSpans ?? []) : []),
    [avatar, capture.video?.avatarSpans]
  );
  const subscribe = useMemo(() => (videoRef === undefined ? null : videoTimeSubscribe(videoRef)), [videoRef]);
  const active = useActivePresenterSpan(spans, subscribe, time);
  if (!camera) return null;
  const stored = avatar ?? spans[active]?.avatar ?? capture.video?.avatar;
  const geometry = geometryFor(camera, { width: 16, height: 9 });
  const style = resolvePresenterStyle(stored, geometry);
  const editing: PresenterEditing | undefined =
    edit === undefined
      ? undefined
      : {
          selected: edit.selected,
          onSelect: edit.onSelect,
          // The first edit copies what shows — the recording's presenter,
          // or the piece's — into the scene.
          onChange: (next) => edit.onChange(next),
          onAction: (action) => {
            const next = applyPresenterAction(style, action, geometry);
            if (action.type === "toggleVisible" && next !== null && !next.visible) edit.onSelect(false);
            edit.onChange(next);
          },
          inheritable: avatar !== undefined,
          inheritLabel: "Use the recording’s presenter in this scene",
          tag: "Presenter · this scene"
        };
  return (
    <PresenterLayer
      fit="canvas"
      capture={capture}
      {...(videoRef !== undefined ? { videoRef } : {})}
      style={style}
      time={time}
      editing={editing}
    />
  );
}
