// Bus-boundary validation for the Draw tool family: its working style
// (`editor.toolStyles.draw`) and a Draw slot in the tool bag. The one
// rule specific to Draw is that the eraser is a MODE of the tool, never
// something a bag slot holds.

import { describe, expect, test } from "vitest";
import { TOOL_BAG_SIZE, type ToolBagSlot } from "@pwrsnap/shared";
import { validateSettingsWrite } from "../settings-validators";

function writeDrawStyle(draw: unknown) {
  return validateSettingsWrite({ editor: { toolStyles: { draw } } } as never);
}

function bagWith(slot: unknown) {
  const slots: unknown[] = [slot];
  while (slots.length < TOOL_BAG_SIZE) slots.push(null);
  return validateSettingsWrite({ editor: { toolBag: { slots } } } as never);
}

describe("validateSettingsWrite — editor.toolStyles.draw", () => {
  test("accepts every mode, eraser included — it is the tool's working state", () => {
    for (const mode of ["pen", "marker", "spray", "eraser"]) {
      expect(writeDrawStyle({ mode }).ok, mode).toBe(true);
    }
    expect(writeDrawStyle({ color: "green", thickness: "x-large" }).ok).toBe(true);
  });

  test("rejects an unknown mode, color or thickness", () => {
    expect(writeDrawStyle({ mode: "crayon" }).ok).toBe(false);
    expect(writeDrawStyle({ color: 42 }).ok).toBe(false);
    expect(writeDrawStyle({ thickness: "huge" }).ok).toBe(false);
  });
});

describe("validateSettingsWrite — Draw tool-bag slots", () => {
  const marker: ToolBagSlot = {
    tool: "draw",
    style: { mode: "marker", color: "yellow", thickness: "large" }
  };

  test("a pen, marker or spray slot is accepted", () => {
    expect(bagWith(marker).ok).toBe(true);
    expect(bagWith({ ...marker, style: { ...marker.style, mode: "pen" } }).ok).toBe(true);
    expect(bagWith({ ...marker, style: { ...marker.style, mode: "spray" } }).ok).toBe(true);
  });

  test("an eraser slot is refused — a slot holds what the next drag DRAWS", () => {
    const result = bagWith({ ...marker, style: { ...marker.style, mode: "eraser" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_editor_toolBag_draw_mode");
  });
});
