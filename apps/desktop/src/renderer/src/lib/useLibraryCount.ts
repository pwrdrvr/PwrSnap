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

/** State plus the request the `total` actually belongs to. Carrying the
 *  key is what lets a refetch of the SAME request keep its number on
 *  screen while a switch to a DIFFERENT one clears it — see `run`. */
type KeyedCountState = LibraryCountState & { forKey: string | null };

const IDLE: KeyedCountState = { total: null, loading: false, error: null, forKey: null };

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
  const [state, setState] = useState<KeyedCountState>(IDLE);
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
      // A refetch of the SAME request (captures changed underneath us)
      // keeps its number on screen — blanking it would flicker the
      // topbar on every capture. A switch to a DIFFERENT request must
      // clear it: the old number describes a filter the user is no
      // longer looking at, and rendering it beside the new filter's
      // label is just a wrong count with a confident presentation.
      setState((prev) =>
        prev.forKey === key
          ? { ...prev, loading: true, error: null }
          : { total: null, loading: true, error: null, forKey: key }
      );
      void (async () => {
        const result: Result<{ total: number }, PwrSnapError> = await dispatch(
          "library:counts",
          parsed
        );
        if (cancelled || seq.current !== mine) return;
        if (!result.ok) {
          setState({ total: null, loading: false, error: result.error.message, forKey: key });
          return;
        }
        // Shape-check before commit. In production the bus contract
        // guarantees `{ total: number }`, but several renderer tests stub
        // `pwrsnapApi.dispatch` per-command and answer anything they
        // don't recognize with `ok(undefined)` — see the same guard and
        // the same note in `useSizzleProjects`. Leaving `total` null on a
        // malformed payload is also the right production behavior: the
        // topbar falls back to the unfiltered library total rather than
        // rendering a wrong number.
        const total = (result.value as { total?: unknown } | undefined)?.total;
        setState({
          total: typeof total === "number" ? total : null,
          loading: false,
          error: null,
          forKey: key
        });
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
