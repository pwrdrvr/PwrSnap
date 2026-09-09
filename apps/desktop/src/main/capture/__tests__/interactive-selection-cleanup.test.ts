import { describe, expect, test, vi } from "vitest";

import { withInteractiveSelectionCleanup } from "../interactive-selection-cleanup";

describe("withInteractiveSelectionCleanup", () => {
  test("a rejected post-selection storage check hides and releases exactly once", async () => {
    const hideSelector = vi.fn();
    const releaseSnapshot = vi.fn(async () => undefined);

    await expect(
      withInteractiveSelectionCleanup({
        snapshotId: "snapshot-video",
        hideSelector,
        releaseSnapshot,
        run: async () => {
          throw new Error("storage probe failed");
        }
      })
    ).rejects.toThrow("storage probe failed");

    expect(hideSelector).toHaveBeenCalledTimes(1);
    expect(releaseSnapshot).toHaveBeenCalledTimes(1);
    expect(releaseSnapshot).toHaveBeenCalledWith("snapshot-video");
  });

  test("eager cleanup plus a later failure remains exactly-once", async () => {
    const hideSelector = vi.fn();
    const releaseSnapshot = vi.fn(async () => undefined);

    await expect(
      withInteractiveSelectionCleanup({
        snapshotId: "snapshot-video",
        hideSelector,
        releaseSnapshot,
        run: async (cleanup) => {
          cleanup.hideSelector();
          await cleanup.releaseSnapshot();
          throw new Error("recording dispatch failed");
        }
      })
    ).rejects.toThrow("recording dispatch failed");

    expect(hideSelector).toHaveBeenCalledTimes(1);
    expect(releaseSnapshot).toHaveBeenCalledTimes(1);
  });

  test("snapshotless window selection still tears down without a release", async () => {
    const hideSelector = vi.fn();
    const releaseSnapshot = vi.fn(async () => undefined);

    await withInteractiveSelectionCleanup({
      snapshotId: undefined,
      hideSelector,
      releaseSnapshot,
      run: async () => undefined
    });

    expect(hideSelector).toHaveBeenCalledTimes(1);
    expect(releaseSnapshot).not.toHaveBeenCalled();
  });
});
