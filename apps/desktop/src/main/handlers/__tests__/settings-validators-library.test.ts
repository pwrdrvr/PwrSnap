// Bus-boundary validation for the `library` section of settings:write,
// focused on the pinch-to-zoom `gridZoom` field. The renderer snaps to the
// ladder before writing, but the validator must still reject anything the
// renderer (or a future caller / hand-edited IPC) could send out of band.

import { describe, expect, test } from "vitest";
import {
  GRID_COLUMN_BIAS_MAX,
  GRID_ZOOM_MAX,
  GRID_ZOOM_MIN
} from "@pwrsnap/shared";
import { validateSettingsWrite } from "../settings-validators";

function writeGridZoom(gridZoom: unknown) {
  return validateSettingsWrite({ library: { gridZoom } });
}

function writeColumnBias(gridColumnBias: unknown) {
  return validateSettingsWrite({ library: { gridColumnBias } });
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

describe("validateSettingsWrite — library.gridColumnBias", () => {
  test("accepts the in-band endpoints, zero, and interior values", () => {
    expect(writeColumnBias(-GRID_COLUMN_BIAS_MAX).ok).toBe(true);
    expect(writeColumnBias(GRID_COLUMN_BIAS_MAX).ok).toBe(true);
    expect(writeColumnBias(0).ok).toBe(true);
    expect(writeColumnBias(-1).ok).toBe(true);
  });

  test("rejects out-of-range integers", () => {
    expect(writeColumnBias(-GRID_COLUMN_BIAS_MAX - 1).ok).toBe(false);
    expect(writeColumnBias(GRID_COLUMN_BIAS_MAX + 1).ok).toBe(false);
  });

  test("rejects non-integer / non-finite / non-number values", () => {
    expect(writeColumnBias(1.5).ok).toBe(false);
    expect(writeColumnBias(Number.NaN).ok).toBe(false);
    expect(writeColumnBias(Number.POSITIVE_INFINITY).ok).toBe(false);
    expect(writeColumnBias("1").ok).toBe(false);
    expect(writeColumnBias(null).ok).toBe(false);
  });
});
