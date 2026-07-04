import { describe, expect, test } from "vitest";

import {
  filterSelectionToAliveOrInFlight,
  pruneLandedInFlightSelectionIds
} from "../selection-cleanup";

describe("selection cleanup", () => {
  test("drops in-flight ids after they land in the rendered layer set", () => {
    const next = pruneLandedInFlightSelectionIds(
      new Set(["landed", "pending"]),
      new Set(["landed", "existing"])
    );

    expect([...next]).toEqual(["pending"]);
  });

  test("keeps selected ids that are alive or still in flight", () => {
    const selected = ["alive", "pending", "stale"];
    const next = filterSelectionToAliveOrInFlight(
      selected,
      new Set(["alive"]),
      new Set(["pending"])
    );

    expect(next).toEqual(["alive", "pending"]);
  });

  test("preserves array identity when no selection ids are removed", () => {
    const selected = ["alive", "pending"];
    const next = filterSelectionToAliveOrInFlight(
      selected,
      new Set(["alive"]),
      new Set(["pending"])
    );

    expect(next).toBe(selected);
  });
});
