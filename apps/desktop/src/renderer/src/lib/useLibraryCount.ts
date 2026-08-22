// useLibraryCount — exact match-set size for a composed Library filter.
//
// The sidebar's scope / types / source-app facets are applied
// client-side, over whatever pages `useLibrary` has paged in so far. So
// the renderer genuinely cannot count its own match set: a
// `records.filter(...).length` reports the loaded window and climbs as
// the user scrolls. `library:counts` answers for the whole table
// instead — one COUNT(*) per filter change, measured at ~3ms over a
// 3.7k-row library.
//
// Captures only. Sizzle Reels projects live outside the captures table
// and the renderer already holds the full list, so callers add
// `projects.length` themselves.

import { useEffect, useMemo, useRef, useState } from "react";
import type { LibraryCountsRequest, PwrSnapError, Result } from "@pwrsnap/shared";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { dispatch, subscribe } from "./pwrsnap";

export type LibraryCountState = {
  /** `null` until the first response for the CURRENT request lands. */
  total: number | null;
  loading: boolean;
  error: string | null;
};

const IDLE: LibraryCountState = { total: null, loading: false, error: null };

/**
 * Count captures matching `request`. Pass `null` to stand down (the
 * caller already knows the answer, or the count would be meaningless —
 * search, for instance, reports its own match count).
 *
 * Refetches when the request changes and on `events:captures:changed`,
 * so the number tracks new captures and deletions without a reload.
 */
export function useLibraryCount(request: LibraryCountsRequest | null): LibraryCountState {
  // Structural identity for the request. Every field is a primitive or
  // an array of primitives, so a JSON round-trip is a sound (and cheap)
  // fingerprint — and it keeps callers free to build the object inline
  // without memoizing it themselves.
  const key = useMemo(() => (request === null ? null : JSON.stringify(request)), [request]);
  const [state, setState] = useState<LibraryCountState>(IDLE);
  // Monotonic guard so a slow response for an older filter cannot
  // clobber a newer one's number — same pattern the settings hook uses.
  const seq = useRef(0);

  useEffect(() => {
    if (key === null) {
      seq.current += 1;
      setState(IDLE);
      return;
    }
    const parsed = JSON.parse(key) as LibraryCountsRequest;
    let cancelled = false;

    const run = (): void => {
      seq.current += 1;
      const mine = seq.current;
      // Keep the previous total visible while the new one resolves —
      // blanking it makes the topbar flicker on every facet click.
      setState((prev) => ({ ...prev, loading: true, error: null }));
      void (async () => {
        const result: Result<{ total: number }, PwrSnapError> = await dispatch(
          "library:counts",
          parsed
        );
        if (cancelled || seq.current !== mine) return;
        setState(
          result.ok
            ? { total: result.value.total, loading: false, error: null }
            : { total: null, loading: false, error: result.error.message }
        );
      })();
    };

    run();
    const unsubscribe = subscribe(EVENT_CHANNELS.capturesChanged, run);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [key]);

  return state;
}
