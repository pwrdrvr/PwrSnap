// resolve-cell-intent tests. Pure truth-table logic — the single resolver
// that keeps click / dblclick / Enter / Edit-CTA / editor:open from
// diverging. Every trigger × cell-kind combination is asserted here.

import { describe, expect, test } from "vitest";
import {
  resolveCellIntent,
  toGridCell,
  type CellTrigger,
  type GridCell
} from "../resolve-cell-intent";

const ALL_TRIGGERS: CellTrigger[] = ["click", "dblclick", "enter", "edit-cta", "ipc-open"];
const EDIT_TRIGGERS: CellTrigger[] = ["dblclick", "enter", "edit-cta", "ipc-open"];

describe("resolveCellIntent — project cells", () => {
  const project: GridCell = { kind: "project", projectId: "proj-1" };

  test.each(ALL_TRIGGERS)("%s opens the Sizzle window (exempt from split)", (trigger) => {
    expect(resolveCellIntent(trigger, project)).toEqual({
      kind: "open-sizzle",
      projectId: "proj-1"
    });
  });
});

describe("resolveCellIntent — fixture cells", () => {
  const fixture: GridCell = { kind: "fixture" };

  test.each(ALL_TRIGGERS)("%s is a no-op", (trigger) => {
    expect(resolveCellIntent(trigger, fixture)).toEqual({ kind: "noop" });
  });
});

describe("resolveCellIntent — live capture cells", () => {
  const capture: GridCell = { kind: "capture", recordId: "rec-1", isTrashed: false };

  test("plain click → select (no editor)", () => {
    expect(resolveCellIntent("click", capture)).toEqual({
      kind: "select",
      recordId: "rec-1"
    });
  });

  test.each(EDIT_TRIGGERS)("%s → edit", (trigger) => {
    expect(resolveCellIntent(trigger, capture)).toEqual({
      kind: "edit",
      recordId: "rec-1"
    });
  });
});

describe("resolveCellIntent — trashed capture cells", () => {
  const trashed: GridCell = { kind: "capture", recordId: "rec-1", isTrashed: true };

  test("click still selects (read metadata / restore via inspector)", () => {
    expect(resolveCellIntent("click", trashed)).toEqual({
      kind: "select",
      recordId: "rec-1"
    });
  });

  test.each(EDIT_TRIGGERS)("%s is a no-op (editor refuses trashed captures)", (trigger) => {
    expect(resolveCellIntent(trigger, trashed)).toEqual({ kind: "noop" });
  });
});

describe("toGridCell — narrowing the flat live cell", () => {
  test("project wins even when other flags are set", () => {
    expect(
      toGridCell({
        recordId: "rec-1",
        isProject: true,
        projectId: "proj-1",
        hasBackingRecord: false,
        isTrashed: true
      })
    ).toEqual({ kind: "project", projectId: "proj-1" });
  });

  test("isProject without a projectId falls through (defensive)", () => {
    expect(
      toGridCell({
        recordId: "rec-1",
        isProject: true,
        projectId: null,
        hasBackingRecord: true,
        isTrashed: false
      })
    ).toEqual({ kind: "capture", recordId: "rec-1", isTrashed: false });
  });

  test("no backing record → fixture", () => {
    expect(
      toGridCell({
        recordId: "rec-1",
        isProject: false,
        projectId: null,
        hasBackingRecord: false,
        isTrashed: false
      })
    ).toEqual({ kind: "fixture" });
  });

  test("live capture carries its trashed flag", () => {
    expect(
      toGridCell({
        recordId: "rec-1",
        isProject: false,
        projectId: null,
        hasBackingRecord: true,
        isTrashed: true
      })
    ).toEqual({ kind: "capture", recordId: "rec-1", isTrashed: true });
  });

  test("end-to-end: a fixture cell resolves to noop for every trigger", () => {
    const cell = toGridCell({
      recordId: "rec-1",
      isProject: false,
      projectId: null,
      hasBackingRecord: false,
      isTrashed: false
    });
    for (const trigger of ALL_TRIGGERS) {
      expect(resolveCellIntent(trigger, cell)).toEqual({ kind: "noop" });
    }
  });
});
