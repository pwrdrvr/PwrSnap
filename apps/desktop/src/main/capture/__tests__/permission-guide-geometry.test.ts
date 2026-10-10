// Where the permission guide sits relative to System Settings. The panel's
// job is to stand next to the list the user drops into, so it must never be
// placed over the Settings window when either side has room, and it must
// stay inside the work area (macOS moves a window placed outside it).

import { describe, expect, test } from "vitest";
import {
  findSettingsWindow,
  GUIDE_GAP_PX,
  planGuidePlacement,
  SETTINGS_LIST_OFFSET_PX,
  SYSTEM_SETTINGS_BUNDLE_ID
} from "../permission-guide-geometry";

const WORK = { x: 0, y: 30, width: 1512, height: 920 };
const SIZE = { width: 316, height: 380 };

describe("planGuidePlacement", () => {
  test("Settings with room on its right → panel on the right, notch on the panel's left", () => {
    const settings = { x: 200, y: 120, width: 715, height: 600 };
    const plan = planGuidePlacement({ settings, workArea: WORK, size: SIZE });
    expect(plan.bounds.x).toBe(200 + 715 + GUIDE_GAP_PX);
    expect(plan.notch?.side).toBe("left");
    // The notch lands on the list, in panel coordinates.
    expect(plan.bounds.y + (plan.notch?.y ?? 0)).toBe(settings.y + SETTINGS_LIST_OFFSET_PX);
  });

  test("Settings against the right edge → panel on the left, notch on the panel's right", () => {
    const settings = { x: 760, y: 120, width: 715, height: 600 };
    const plan = planGuidePlacement({ settings, workArea: WORK, size: SIZE });
    expect(plan.bounds.x + plan.bounds.width).toBe(760 - GUIDE_GAP_PX);
    expect(plan.notch?.side).toBe("right");
  });

  test("no room on either side → overlaps at the work area's right edge with no notch", () => {
    const settings = { x: 100, y: 120, width: 1300, height: 600 };
    const plan = planGuidePlacement({ settings, workArea: WORK, size: SIZE });
    expect(plan.bounds.x + plan.bounds.width).toBe(WORK.x + WORK.width);
    expect(plan.notch).toBeNull();
  });

  test("never above the work area (under the menu bar) or below it", () => {
    const high = planGuidePlacement({
      settings: { x: 200, y: 0, width: 715, height: 600 },
      workArea: WORK,
      size: SIZE
    });
    expect(high.bounds.y).toBeGreaterThanOrEqual(WORK.y);

    const low = planGuidePlacement({
      settings: { x: 200, y: 800, width: 715, height: 600 },
      workArea: WORK,
      size: SIZE
    });
    expect(low.bounds.y + low.bounds.height).toBeLessThanOrEqual(WORK.y + WORK.height);
    // Clamped away from the list, the notch still stays on the card.
    expect(low.notch?.y).toBeLessThanOrEqual(SIZE.height - 26);
  });

  test("Settings not found → centred horizontally on the work area, no notch", () => {
    const plan = planGuidePlacement({ settings: null, workArea: WORK, size: SIZE });
    expect(plan.bounds.x).toBe(Math.round((WORK.width - SIZE.width) / 2));
    expect(plan.notch).toBeNull();
  });

  test("a second display to the left (negative x) is honoured", () => {
    const left = { x: -1920, y: 0, width: 1920, height: 1050 };
    const plan = planGuidePlacement({
      settings: { x: -1700, y: 100, width: 715, height: 600 },
      workArea: left,
      size: SIZE
    });
    expect(plan.bounds.x).toBe(-1700 + 715 + GUIDE_GAP_PX);
    expect(plan.notch?.side).toBe("left");
  });
});

describe("findSettingsWindow", () => {
  test("picks the largest System Settings window and ignores other apps", () => {
    const found = findSettingsWindow([
      { bundleId: "com.example.editor", bounds: { x: 0, y: 0, width: 2000, height: 1200 } },
      { bundleId: SYSTEM_SETTINGS_BUNDLE_ID, bounds: { x: 10, y: 10, width: 300, height: 200 } },
      { bundleId: SYSTEM_SETTINGS_BUNDLE_ID, bounds: { x: 50, y: 60, width: 715, height: 600 } },
      { bundleId: null, bounds: { x: 0, y: 0, width: 4000, height: 4000 } }
    ]);
    expect(found).toEqual({ x: 50, y: 60, width: 715, height: 600 });
  });

  test("none open → null", () => {
    expect(findSettingsWindow([])).toBeNull();
  });
});
