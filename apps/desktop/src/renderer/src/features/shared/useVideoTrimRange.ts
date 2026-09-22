// Local edit state for a video capture — the in/out trim plus, where the
// surface supports them, splits and cuts (the kept-segment model in
// `@pwrsnap/shared` video-segments.ts).
//
//   • Seeds from the record and re-adopts it whenever the record changes
//     underneath us (an agent edited the video over MCP or chat, another
//     window trimmed it, or the `events:captures:changed` revalidation
//     after our own persist) — but never mid-drag or while a persist of
//     ours is still pending (a stale echo must not revert a newer local
//     edit).
//   • `setRange(range, commit)` moves the OUTER range (the in/out
//     handles) and clips the kept spans to it. It always clips the last
//     COMMITTED edit, never the previous drag frame, so dragging a handle
//     back over a cut restores the cut.
//   • `setSegments(segments, commit)` replaces the kept spans (split,
//     cut, restore, inner-edge drags).
//   • Both update local state immediately (so handles feel direct); a
//     commit schedules a debounced persist. Valid values are adopted
//     verbatim (the timeline / keyboard already round drag values to
//     ms); only out-of-bounds input is clamped. Keeping the float
//     identity is what makes the export cache key stable across
//     surfaces.
//   • Every commit that changes the edit is undoable (`undo` / `redo`).
//     An edit adopted from upstream is undoable too — the state it
//     replaced goes on the stack — so a cut an agent made is one ⌘Z
//     away from gone.
//
// Two persistence modes, named by the caller's `persist`:
//   • "edit" (Library): the whole edit, cuts included; persists with
//     `video:edit { keep }`.
//   • "range" (float-over): the in/out handles only; persists with
//     `video:setDefaultRange`, which clips whatever cuts are stored
//     rather than replacing them, so a surface that cannot show cuts can
//     never erase them.
//
// Shared by the Library video stage and the float-over mini-trim.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  normalizeVideoSegments,
  videoSegmentsEqual,
  videoSegmentsOrFull,
  videoSegmentsOuterRange,
  withVideoOuterRange,
  type VideoRange
} from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";
import { clampRange, exportSegmentsOf, isValidRange, videoSegmentsDepKey } from "./video-range";

export const PERSIST_DEBOUNCE_MS = 150;

/** Undo depth. An entry is a handful of spans; the cap only bounds a
 *  long session of fiddling. */
export const TRIM_HISTORY_LIMIT = 100;

export type UseVideoTrimRange = {
  /** Outer range — first kept start → last kept end. */
  range: VideoRange;
  /** Kept spans in source seconds. Always at least one. */
  segments: readonly VideoRange[];
  /** The spans an export should carry when the edit has interior cuts
   *  (touching spans merged); `undefined` otherwise, so a request for
   *  an uncut edit — and its cache key — is exactly what it was before
   *  cuts existed. */
  exportSegments: VideoRange[] | undefined;
  /** Move the in/out handles. `commit=false` while dragging (local
   *  only); `true` persists. */
  setRange: (range: VideoRange, commit: boolean) => void;
  /** Replace the kept spans. `commit` as for `setRange`. */
  setSegments: (segments: readonly VideoRange[], commit: boolean) => void;
  /** True between a commit and the acknowledged persist. */
  pending: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
};

function seedRange(persisted: VideoRange | null, durationSec: number): VideoRange {
  if (persisted === null) return { start: 0, end: durationSec };
  // Adopt a valid persisted range verbatim — clamping would round it
  // and change the float identity the export cache is keyed on.
  return isValidRange(persisted, durationSec) ? persisted : clampRange(persisted, durationSec);
}

function seedSegments(
  persistedRange: VideoRange | null,
  persistedSegments: readonly VideoRange[] | null | undefined,
  durationSec: number
): VideoRange[] {
  if (persistedSegments !== undefined && persistedSegments !== null && persistedSegments.length > 0) {
    return videoSegmentsOrFull(persistedSegments, durationSec);
  }
  return [seedRange(persistedRange, durationSec)];
}

export type UseVideoTrimRangeInput = {
  captureId: string | null;
  durationSec: number;
  persistedRange: VideoRange | null;
} & (
  | {
      persist: "edit";
      /** The record's kept spans (`null` when there is no record). */
      persistedSegments: readonly VideoRange[] | null;
    }
  | { persist: "range" }
);

export function useVideoTrimRange(input: UseVideoTrimRangeInput): UseVideoTrimRange {
  const { captureId, durationSec, persistedRange } = input;
  const segmentsMode = input.persist === "edit";
  // A range-mode surface never reads the stored cuts: it seeds from the
  // outer range alone, and its writes clip the cuts in main.
  const persistedSegments = input.persist === "edit" ? input.persistedSegments : undefined;
  const [segments, setLocal] = useState<VideoRange[]>(() =>
    seedSegments(persistedRange, persistedSegments, durationSec)
  );
  const [pending, setPending] = useState(false);
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });

  const localRef = useRef(segments);
  /** The last committed edit — the base every handle drag clips, and
   *  what the next undo entry records. */
  const committedRef = useRef(segments);
  const pastRef = useRef<VideoRange[][]>([]);
  const futureRef = useRef<VideoRange[][]>([]);
  const draggingRef = useRef(false);
  const pendingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The persist the timer will run, so a capture switch can flush it
   *  instead of dropping the user's last edit. */
  const flushRef = useRef<(() => void) | null>(null);
  const seqRef = useRef(0);

  // Exact floats, not `videoSpansKey`'s ms rounding: an upstream change
  // below a millisecond is still a change to the export cache key.
  const persistedKey = `${persistedRange === null ? "none" : `${persistedRange.start}|${persistedRange.end}`}#${videoSegmentsDepKey(persistedSegments)}`;

  const setLocalBoth = useCallback((next: VideoRange[]): void => {
    localRef.current = next;
    setLocal(next);
  }, []);

  const syncHistory = useCallback((): void => {
    const next = { canUndo: pastRef.current.length > 0, canRedo: futureRef.current.length > 0 };
    setHistory((prev) =>
      prev.canUndo === next.canUndo && prev.canRedo === next.canRedo ? prev : next
    );
  }, []);

  const flushPending = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const flush = flushRef.current;
    flushRef.current = null;
    flush?.();
  }, []);

  // Capture switch: persist what the previous capture was waiting on,
  // then hard reset (drop history, drop pending, reseed).
  useEffect(() => {
    flushPending();
    draggingRef.current = false;
    pendingRef.current = false;
    seqRef.current += 1;
    pastRef.current = [];
    futureRef.current = [];
    setPending(false);
    syncHistory();
    const seed = seedSegments(persistedRange, persistedSegments, durationSec);
    // Keep the current array when nothing changed (the mount pass), so
    // consumers keyed on identity do not see a spurious edit.
    const next = videoSegmentsEqual(localRef.current, seed) ? localRef.current : seed;
    committedRef.current = next;
    if (next !== localRef.current) setLocalBoth(next);
    // Only the capture id drives this reset; the upstream-adopt effect
    // below tracks the record / duration for the same capture.
  }, [captureId]);

  // Upstream change for the same capture: adopt unless we're mid-edit.
  useEffect(() => {
    if (draggingRef.current || pendingRef.current) return;
    const upstream = seedSegments(persistedRange, persistedSegments, durationSec);
    const current = committedRef.current;
    if (videoSegmentsEqual(upstream, current)) {
      if (!videoSegmentsEqual(localRef.current, current)) setLocalBoth(current);
      return;
    }
    // Someone else changed the edit. Keep what it replaced one undo away.
    pastRef.current.push(current);
    if (pastRef.current.length > TRIM_HISTORY_LIMIT) pastRef.current.shift();
    futureRef.current = [];
    committedRef.current = upstream;
    setLocalBoth(upstream);
    syncHistory();
  }, [persistedKey, durationSec]);

  useEffect(() => () => flushPending(), [flushPending]);

  const persist = useCallback(
    (next: VideoRange[]): void => {
      if (captureId === null) return;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      const seq = ++seqRef.current;
      pendingRef.current = true;
      setPending(true);
      const settle = (): void => {
        if (seq !== seqRef.current) return;
        pendingRef.current = false;
        setPending(false);
      };
      const run = (): void => {
        const request = segmentsMode
          ? dispatch("video:edit", { captureId, keep: next })
          : dispatch("video:setDefaultRange", {
              captureId,
              range: videoSegmentsOuterRange(next)
            });
        void request.then(settle, settle);
      };
      flushRef.current = run;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        flushRef.current = null;
        run();
      }, PERSIST_DEBOUNCE_MS);
    },
    [captureId, segmentsMode]
  );

  const commit = useCallback(
    (next: VideoRange[]): void => {
      draggingRef.current = false;
      const prev = committedRef.current;
      if (videoSegmentsEqual(prev, next)) {
        // A drag that ended where it began, or an Escape-cancel. Nothing
        // to record and nothing to write — but put the local state back
        // in case a drag frame moved it.
        setLocalBoth(prev);
        return;
      }
      pastRef.current.push(prev);
      if (pastRef.current.length > TRIM_HISTORY_LIMIT) pastRef.current.shift();
      futureRef.current = [];
      committedRef.current = next;
      setLocalBoth(next);
      syncHistory();
      persist(next);
    },
    [persist, setLocalBoth, syncHistory]
  );

  const setSegments = useCallback(
    (next: readonly VideoRange[], commitNow: boolean): void => {
      const normalized = normalizeVideoSegments(next, durationSec);
      if (normalized.length === 0) return;
      if (!commitNow) {
        draggingRef.current = true;
        setLocalBoth(normalized);
        return;
      }
      commit(normalized);
    },
    [commit, durationSec, setLocalBoth]
  );

  const setRange = useCallback(
    (next: VideoRange, commitNow: boolean): void => {
      const clamped = isValidRange(next, durationSec) ? next : clampRange(next, durationSec);
      const clipped = withVideoOuterRange(committedRef.current, clamped, durationSec);
      if (!commitNow) {
        draggingRef.current = true;
        setLocalBoth(clipped);
        return;
      }
      commit(clipped);
    },
    [commit, durationSec, setLocalBoth]
  );

  const step = useCallback(
    (from: { current: VideoRange[][] }, to: { current: VideoRange[][] }): void => {
      const target = from.current.pop();
      if (target === undefined) return;
      to.current.push(committedRef.current);
      committedRef.current = target;
      draggingRef.current = false;
      setLocalBoth(target);
      syncHistory();
      persist(target);
    },
    [persist, setLocalBoth, syncHistory]
  );
  const undo = useCallback(() => step(pastRef, futureRef), [step]);
  const redo = useCallback(() => step(futureRef, pastRef), [step]);

  const range = useMemo(() => videoSegmentsOuterRange(segments), [segments]);
  const exportSegments = useMemo(() => exportSegmentsOf(segments), [segments]);

  return {
    range,
    segments,
    exportSegments,
    setRange,
    setSegments,
    pending,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    undo,
    redo
  };
}
