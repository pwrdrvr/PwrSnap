import { describe, expect, test } from "vitest";
import { validateSettingsWrite } from "../settings-validators";

describe("validateSettingsWrite — shape strokeStyle", () => {
  test("accepts solid / dashed / dotted on the shape tool style", () => {
    for (const strokeStyle of ["solid", "dashed", "dotted"] as const) {
      expect(
        validateSettingsWrite({ editor: { toolStyles: { shape: { strokeStyle } } } }).ok
      ).toBe(true);
    }
  });

  test("rejects anything else, on the tool style and on a bag slot", () => {
    const style = validateSettingsWrite({
      editor: { toolStyles: { shape: { strokeStyle: "wavy" as never } } }
    });
    expect(style.ok).toBe(false);
    if (!style.ok) expect(style.error.code).toBe("invalid_editor_shape_strokeStyle");

    const bag = validateSettingsWrite({
      editor: {
        toolBag: {
          slots: [{ tool: "shape", style: { strokeStyle: "wavy" } } as never]
        }
      }
    });
    expect(bag.ok).toBe(false);
  });
});
