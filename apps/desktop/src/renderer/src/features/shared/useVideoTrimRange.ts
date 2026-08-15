// Local trim-range state bound to a capture's persisted `defaultRange`.
//
//   • Seeds from `record.video.defaultRange` and re-adopts it whenever
//     the record changes underneath us (another window trimmed, or the
//     `events:captures:changed` revalidation after our own persist)
//     — but never mid-drag or while a persist of ours is still pending
//     (a stale echo must not revert a newer local edit).
//   • `setRange(range, commit)`: updates local state immediately (so
//     handles feel direct); on `commit` schedules a debounced
//     `video:setDefaultRange`. Range is rounded to ms before persisting
//     so the export cache key is stable.
//
// Shared by the Library video stage and the float-over mini-trim.

import { useCallback, useEffect, useRef, useState } from "react";
import type { VideoRange } from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";
import { clampRange } from "./video-range";

export const PERSIST_DEBOUNCE_MS = 150;

export type UseVideoTrimRange = {
  range: VideoRange;
  /** `commit=false` while dragging (local only); `true` persists. */
  setRange: (range: VideoRange, commit: boolean) => void;
  /** True between a commit and the acknowledged persist. */
  pending: boolean;
};

function seedRange(persisted: VideoRange | null, durationSec: number): VideoRange {
  return clampRange(persisted ?? { start: 0, end: durationSec }, durationSec);
}

export function useVideoTrimRange(input: {
  captureId: string | null;
  durationSec: number;
  persistedRange: VideoRange | null;
}): UseVideoTrimRange {
  const { captureId, durationSec, persistedRange } = input;
  const [range, setLocal] = useState<VideoRange>(() => seedRange(persistedRange, durationSec));
  const [pending, setPending] = useState(false);
  const draggingRef = useRef(false);
  const pendingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);

  const persistedKey =
    persistedRange === null ? "none" : `${persistedRange.start}|${persistedRange.end}`;

  // Capture switch: hard reset (drop timers, drop pending, reseed).
  useEffect(() => {
    draggingRef.current = false;
    pendingRef.current = false;
    seqRef.current += 1;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setPending(false);
    setLocal(seedRange(persistedRange, durationSec));
    // Only the capture id drives this reset; the upstream-adopt effect
    // below tracks persistedRange / duration for the same capture.
  }, [captureId]);

  // Upstream change for the same capture: adopt unless we're mid-edit.
  useEffect(() => {
    if (draggingRef.current || pendingRef.current) return;
    setLocal(seedRange(persistedRange, durationSec));
  }, [persistedKey, durationSec]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    []
  );

  const setRange = useCallback(
    (next: VideoRange, commit: boolean): void => {
      const clamped = clampRange(next, durationSec);
      setLocal(clamped);
      draggingRef.current = !commit;
      if (!commit || captureId === null) return;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      const seq = ++seqRef.current;
      pendingRef.current = true;
      setPending(true);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void dispatch("video:setDefaultRange", { captureId, range: clamped }).then(() => {
          if (seq !== seqRef.current) return;
          pendingRef.current = false;
          setPending(false);
        });
      }, PERSIST_DEBOUNCE_MS);
    },
    [captureId, durationSec]
  );

  return { range, setRange, pending };
}
