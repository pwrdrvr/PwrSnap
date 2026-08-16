// filter-drain — keeps keyset pagination moving when a CLIENT-SIDE
// facet empties the loaded keyset window.
//
// The grid's only "fetch the next page" trigger is the virtualizer's
// near-tail effect (VirtualizedGrid: `if (lastItem === undefined)
// return`). That effect can never fire when the filtered row set is
// EMPTY, because an empty grid renders no virtual items at all.
//
// That's fine for filters the server applies (include-mode source apps
// drain their own cursor, so `gridHasMore` is false), but type facets
// and EXCLUDE-mode source-app facets are applied client-side over the
// current keyset window. If page 1 contains no videos, for example,
// selecting Videos makes the grid empty and nothing triggers
// `loadMore()` even when later pages contain videos.
//
// So: when a client-side filter is active, more pages exist, no fetch
// is in flight, and NOTHING is visible, pull the next page. Repeat
// until either a row survives the filter or the backend says there is
// nothing left (`hasMore === false`) — that's the loop's termination
// condition, and it is the backend's, not ours.
//
// Tests: __tests__/filter-drain.test.tsx.

import { useEffect } from "react";

export type FilterDrainState = {
  /** A client-side facet is narrowing the loaded window. False for
   *  server-side filters and neutral facets. */
  readonly active: boolean;
  /** The backend has more pages (`gridHasMore`). */
  readonly hasMore: boolean;
  /** A page fetch is already in flight — don't stack another. */
  readonly isLoadingMore: boolean;
  /** Rows that survived the client-side filter. Zero means the grid is
   *  blank AND the virtualizer has no last item to trigger on. */
  readonly visibleCount: number;
  /** Rows that survived scope selection but have not yet had the
   *  client-side facets applied. A zero here means an unrelated scope
   *  (such as Today) made the page empty, so advancing the keyset could
   *  needlessly scan the entire historical library. */
  readonly candidateCount: number;
};

/** Pure decision: should we pull another page purely to keep the
 *  client-side filter fed? Exported for tests + readability. */
export function shouldDrainForFilter(state: FilterDrainState): boolean {
  if (!state.active) return false;
  if (!state.hasMore) return false;
  if (state.isLoadingMore) return false;
  if (state.candidateCount === 0) return false;
  return state.visibleCount === 0;
}

export type UseFilterDrainInput = FilterDrainState & {
  /** Loaded (unfiltered) row count — re-arms the check after a page
   *  lands, in case the `isLoadingMore` flip is batched away. */
  readonly loadedCount: number;
  readonly loadMore: () => Promise<void>;
};

/**
 * Dispatch `loadMore()` while a client-side filter leaves the grid
 * empty. Self-limiting: each pass flips `isLoadingMore` (and, once the
 * page lands, `loadedCount`), so the effect re-evaluates rather than
 * spinning; it stops as soon as a row survives the filter or `hasMore`
 * goes false.
 */
export function useFilterDrain(input: UseFilterDrainInput): void {
  const { loadedCount, loadMore, ...state } = input;
  const drain = shouldDrainForFilter(state);
  useEffect(() => {
    if (!drain) return;
    void loadMore();
  }, [drain, loadedCount, loadMore]);
}
