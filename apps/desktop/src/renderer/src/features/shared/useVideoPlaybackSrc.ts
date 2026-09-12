import { useEffect, useRef, useState } from "react";
import { videoPlaybackNeedsPreparation, type RecordedAudioTrackFacts } from "@pwrsnap/shared";
import { captureSrcUrl, dispatch } from "../../lib/pwrsnap";

/**
 * The URL a `<video>` should load for a recording.
 *
 * A take whose audible audio is not the track a player picks up plays
 * silent — system audio armed with nothing running through it leaves a
 * silent track in front of a live microphone, and that is the ordinary
 * case, not an edge one. `video:playback` answers with either the capture
 * URL or a prepared rendition whose single track is what the user should
 * hear.
 *
 * Every surface that mounts an AUDIBLE player calls this. A surface whose
 * player can never be heard must NOT: see the note on gating below.
 *
 * Returns the capture URL synchronously and swaps to a rendition only if
 * one is both needed and successfully prepared, so the worst case is the
 * behavior that shipped before the verb existed.
 */
export function useVideoPlaybackSrc(args: {
  captureId: string;
  /**
   * The record's audio track facts, or null/undefined when it has none —
   * a non-video capture, or a video row whose `video_captures` metadata is
   * missing. Both mean "nothing here can say a rendition is needed", and
   * the hook stays on the capture URL without dispatching.
   */
  video: RecordedAudioTrackFacts | null | undefined;
  /**
   * Called immediately before the returned URL changes, so a caller that
   * owns a playing element can capture what to restore across the swap.
   * Changing `src` resets the element: position goes to 0 and playback
   * stops.
   */
  onBeforeSwap?: (() => void) | undefined;
}): string {
  const { captureId, video, onBeforeSwap } = args;
  const seed = captureSrcUrl(captureId);
  const [playbackUrl, setPlaybackUrl] = useState(seed);

  // Read through a ref so a caller passing an inline closure does not
  // re-run the effect — and re-dispatch — on every render. The float-over
  // re-renders at 60 Hz while its auto-dismiss countdown ticks.
  const onBeforeSwapRef = useRef(onBeforeSwap);
  onBeforeSwapRef.current = onBeforeSwap;

  // Gate on the facts the record already carries. The verb can spawn a
  // stream-copy remux of the whole recording, so the dispatch itself is
  // the thing worth avoiding: for a capture that cannot need a rendition —
  // no audible audio, or the audible audio already in the slot a player
  // takes — this is false and nothing crosses the bus.
  const needsPreparation = video != null && videoPlaybackNeedsPreparation(video);

  useEffect(() => {
    setPlaybackUrl(seed);
    if (!needsPreparation) return;
    let cancelled = false;
    // `dispatch` forwards to `ipcRenderer.invoke`, which REJECTS when the
    // main handler throws — and in split mode this verb crosses the agent
    // bridge, so a teardown mid-flight lands here. Without the catch that
    // is an unhandled rejection, not the fallback this comment claims.
    void dispatch("video:playback", { captureId })
      .then((res) => {
        // A failure here is not worth surfacing: the seed is already the
        // pre-existing behavior, so the worst case is what shipped before
        // this resolution existed.
        if (cancelled || !res.ok || res.value.url === seed) return;
        onBeforeSwapRef.current?.();
        setPlaybackUrl(res.value.url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [captureId, seed, needsPreparation]);

  return playbackUrl;
}
