// Bus-boundary validation for the `library` section of settings:write,
// focused on the pinch-to-zoom `gridZoom` field. The renderer snaps to the
// ladder before writing, but the validator must still reject anything the
// renderer (or a future caller / hand-edited IPC) could send out of band.

import { describe, expect, test } from "vitest";
import { GRID_ZOOM_MAX, GRID_ZOOM_MIN } from "@pwrsnap/shared";
import { validateSettingsWrite } from "../settings-validators";

function writeGridZoom(gridZoom: unknown) {
  return validateSettingsWrite({ library: { gridZoom } });
}

describe("validateSettingsWrite — library.gridZoom", () => {
  test("accepts the in-band endpoints and an interior value", () => {
    expect(writeGridZoom(GRID_ZOOM_MIN).ok).toBe(true);
    expect(writeGridZoom(GRID_ZOOM_MAX).ok).toBe(true);
    expect(writeGridZoom(220).ok).toBe(true);
  });

  test("rejects out-of-range numbers", () => {
    expect(writeGridZoom(GRID_ZOOM_MIN - 1).ok).toBe(false);
    expect(writeGridZoom(GRID_ZOOM_MAX + 1).ok).toBe(false);
    expect(writeGridZoom(0).ok).toBe(false);
  });

  test("rejects non-finite and non-number values", () => {
    expect(writeGridZoom(Number.NaN).ok).toBe(false);
    expect(writeGridZoom(Number.POSITIVE_INFINITY).ok).toBe(false);
    expect(writeGridZoom("180").ok).toBe(false);
    expect(writeGridZoom(null).ok).toBe(false);
  });

  test("an absent gridZoom is fine (other library fields still validate)", () => {
    expect(validateSettingsWrite({ library: { confirmBeforeTrash: true } }).ok).toBe(true);
    expect(validateSettingsWrite({ library: {} }).ok).toBe(true);
  });
});

function writeGridCopyPalette(gridCopyPalette: unknown) {
  return validateSettingsWrite({ library: { gridCopyPalette } });
}

describe("validateSettingsWrite — library.gridCopyPalette", () => {
  test("accepts both anchor modes", () => {
    expect(writeGridCopyPalette({ anchor: "follow" }).ok).toBe(true);
    expect(writeGridCopyPalette({ anchor: "pinned" }).ok).toBe(true);
    // Deep-partial: an empty object leaves the field alone.
    expect(writeGridCopyPalette({}).ok).toBe(true);
  });

  test("rejects an unknown anchor mode", () => {
    expect(writeGridCopyPalette({ anchor: "sticky" }).ok).toBe(false);
    expect(writeGridCopyPalette({ anchor: "" }).ok).toBe(false);
    expect(writeGridCopyPalette({ anchor: null }).ok).toBe(false);
    expect(writeGridCopyPalette({ anchor: 1 }).ok).toBe(false);
  });

  test("rejects a non-object gridCopyPalette", () => {
    expect(writeGridCopyPalette("follow").ok).toBe(false);
    expect(writeGridCopyPalette(null).ok).toBe(false);
    expect(writeGridCopyPalette([]).ok).toBe(false);
  });
});
