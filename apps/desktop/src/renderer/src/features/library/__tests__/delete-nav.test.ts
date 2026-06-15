// Coverage for the soft-delete view-navigation decision. This is the exact
// logic that fixes the "Delete didn't close the image → clicked again →
// trashed a neighbor" trap, so it gets direct tests.

import { describe, expect, test } from "vitest";
import { nextAfterDelete } from "../delete-nav";

const IDS = ["a", "b", "c", "d"] as const;

describe("nextAfterDelete", () => {
  test("grid mode never moves the view", () => {
    expect(
      nextAfterDelete({
        viewKind: "grid",
        selectedRecordId: "b",
        deletedId: "b",
        visibleIds: IDS
      })
    ).toBeNull();
  });

  test("deleting a non-selected capture (reel filmstrip) does not move the view", () => {
    expect(
      nextAfterDelete({
        viewKind: "reel",
        selectedRecordId: "b",
        deletedId: "d",
        visibleIds: IDS
      })
    ).toBeNull();
  });

  test("deleting the focused capture advances to the next", () => {
    expect(
      nextAfterDelete({
        viewKind: "focus",
        selectedRecordId: "b",
        deletedId: "b",
        visibleIds: IDS
      })
    ).toEqual({ type: "NAVIGATE", recordId: "c" });
  });

  test("deleting the LAST of several falls back to the previous (no wrap)", () => {
    expect(
      nextAfterDelete({
        viewKind: "focus",
        selectedRecordId: "d",
        deletedId: "d",
        visibleIds: IDS
      })
    ).toEqual({ type: "NAVIGATE", recordId: "c" });
  });

  test("deleting the FIRST advances to the second (does not wrap to the end)", () => {
    expect(
      nextAfterDelete({
        viewKind: "focus",
        selectedRecordId: "a",
        deletedId: "a",
        visibleIds: IDS
      })
    ).toEqual({ type: "NAVIGATE", recordId: "b" });
  });

  test("deleting the only capture closes Focus", () => {
    expect(
      nextAfterDelete({
        viewKind: "focus",
        selectedRecordId: "a",
        deletedId: "a",
        visibleIds: ["a"]
      })
    ).toEqual({ type: "CLOSE_FOCUS" });
  });

  test("deleting the only capture in Reel returns null (reel has no closed state)", () => {
    expect(
      nextAfterDelete({
        viewKind: "reel",
        selectedRecordId: "a",
        deletedId: "a",
        visibleIds: ["a"]
      })
    ).toBeNull();
  });

  test("deleting an id not in the visible set closes Focus rather than navigating nowhere", () => {
    expect(
      nextAfterDelete({
        viewKind: "focus",
        selectedRecordId: "z",
        deletedId: "z",
        visibleIds: IDS
      })
    ).toEqual({ type: "CLOSE_FOCUS" });
  });
});
