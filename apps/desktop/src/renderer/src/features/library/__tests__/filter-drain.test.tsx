// filter-drain tests. The bug this module fixes: an exclude-mode
// source-app facet is applied client-side over the loaded keyset
// window, so a page whose captures are ALL excluded renders zero rows
// — and the grid's only load-more trigger is the virtualizer's
// near-tail effect, which never fires with zero virtual items. The
// Library then shows an empty grid forever even though later pages
// have matching captures.
//
// What's protected here:
//   1. Page filters to EMPTY -> loadMore() is called.
//   2. The drain keeps going as successive pages also filter to empty.
//   3. It STOPS when the backend runs out (hasMore false) — the loop's
//      termination condition, so a fully-drained cursor can't spin.
//   4. It doesn't fire when rows are visible, when a fetch is already
//      in flight, or when the facet isn't client-side (`active`).

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { shouldDrainForFilter, useFilterDrain, type UseFilterDrainInput } from "../filter-drain";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function Harness(props: UseFilterDrainInput): null {
  useFilterDrain(props);
  return null;
}

function render(props: UseFilterDrainInput): void {
  act(() => {
    root?.render(createElement(Harness, props));
  });
}

const base: Omit<UseFilterDrainInput, "loadMore"> = {
  active: true,
  hasMore: true,
  isLoadingMore: false,
  visibleCount: 0,
  loadedCount: 100
};

describe("shouldDrainForFilter", () => {
  test("drains only when active + hasMore + idle + nothing visible", () => {
    expect(shouldDrainForFilter(base)).toBe(true);
    expect(shouldDrainForFilter({ ...base, active: false })).toBe(false);
    expect(shouldDrainForFilter({ ...base, hasMore: false })).toBe(false);
    expect(shouldDrainForFilter({ ...base, isLoadingMore: true })).toBe(false);
    expect(shouldDrainForFilter({ ...base, visibleCount: 1 })).toBe(false);
  });
});

describe("useFilterDrain", () => {
  test("page filters to empty -> loadMore is called", () => {
    const loadMore = vi.fn(async () => undefined);
    render({ ...base, loadMore });
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  test("keeps draining while successive pages also filter to empty", () => {
    const loadMore = vi.fn(async () => undefined);
    render({ ...base, loadMore });
    expect(loadMore).toHaveBeenCalledTimes(1);

    // Fetch in flight — must not stack a second request.
    render({ ...base, isLoadingMore: true, loadMore });
    expect(loadMore).toHaveBeenCalledTimes(1);

    // Page 2 landed, still nothing survives the facet -> pull page 3.
    render({ ...base, loadedCount: 200, loadMore });
    expect(loadMore).toHaveBeenCalledTimes(2);
  });

  test("stops once a row survives the filter", () => {
    const loadMore = vi.fn(async () => undefined);
    render({ ...base, loadMore });
    expect(loadMore).toHaveBeenCalledTimes(1);

    render({ ...base, loadedCount: 200, visibleCount: 3, loadMore });
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  test("stops when the backend has returned everything (hasMore false)", () => {
    const loadMore = vi.fn(async () => undefined);
    render({ ...base, hasMore: false, loadMore });
    expect(loadMore).not.toHaveBeenCalled();

    // Still empty, still no cursor — re-renders must not re-arm it.
    render({ ...base, hasMore: false, loadedCount: 300, loadMore });
    expect(loadMore).not.toHaveBeenCalled();
  });

  test("never fires for a server-side filter (active false)", () => {
    const loadMore = vi.fn(async () => undefined);
    render({ ...base, active: false, loadMore });
    render({ ...base, active: false, loadedCount: 200, loadMore });
    expect(loadMore).not.toHaveBeenCalled();
  });
});
