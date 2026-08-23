import { describe, expect, test } from "vitest";

import {
  isInteractiveSelectorLeased,
  tryAcquireInteractiveSelectorLease
} from "../interactive-selector-lease";

describe("interactive selector lease", () => {
  test("rejects duplicate acquisition, releases idempotently, and can be reacquired", () => {
    expect(isInteractiveSelectorLeased()).toBe(false);

    const first = tryAcquireInteractiveSelectorLease();
    expect(first).not.toBeNull();
    expect(isInteractiveSelectorLeased()).toBe(true);
    expect(tryAcquireInteractiveSelectorLease()).toBeNull();

    first?.release();
    expect(isInteractiveSelectorLeased()).toBe(false);

    const second = tryAcquireInteractiveSelectorLease();
    expect(second).not.toBeNull();
    expect(isInteractiveSelectorLeased()).toBe(true);

    // A stale duplicate release from the first owner must not clear the
    // current token.
    first?.release();
    expect(isInteractiveSelectorLeased()).toBe(true);
    expect(tryAcquireInteractiveSelectorLease()).toBeNull();

    second?.release();
    second?.release();
    expect(isInteractiveSelectorLeased()).toBe(false);

    const third = tryAcquireInteractiveSelectorLease();
    expect(third).not.toBeNull();
    third?.release();
    expect(isInteractiveSelectorLeased()).toBe(false);
  });
});
