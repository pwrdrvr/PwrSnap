import { describe, expect, test } from "vitest";
import { resolveQuickCaptureAction } from "../quick-capture-action";

describe("resolveQuickCaptureAction", () => {
  test.each([
    ["ask", "snap", "snap"],
    ["ask", "record", "record"],
    ["snap", "snap", "snap"],
    ["snap", "record", "snap"],
    ["record", "snap", "record"],
    ["record", "record", "record"]
  ] as const)(
    "preference %s with selector action %s routes to %s",
    (preference, selectorAction, expected) => {
      expect(resolveQuickCaptureAction(preference, selectorAction)).toBe(expected);
    }
  );
});
