import { describe, expect, test } from "vitest";
import {
  isTextEntryTarget,
  nextShuttleRate,
  SHUTTLE_RATES,
  transportIntentForKey
} from "../video-transport-keys";

describe("transportIntentForKey", () => {
  test("space toggles play", () => {
    expect(transportIntentForKey({ key: " " })).toEqual({ type: "togglePlay" });
    expect(transportIntentForKey({ key: "Spacebar" })).toEqual({ type: "togglePlay" });
  });

  test("J / K / L shuttle back · pause · shuttle forward (case-insensitive)", () => {
    expect(transportIntentForKey({ key: "j" })).toEqual({ type: "shuttle", direction: -1 });
    expect(transportIntentForKey({ key: "K" })).toEqual({ type: "pause" });
    expect(transportIntentForKey({ key: "l" })).toEqual({ type: "shuttle", direction: 1 });
  });

  test("arrows step one frame; shift-arrows step one second", () => {
    expect(transportIntentForKey({ key: "ArrowLeft" })).toEqual({ type: "step", frames: -1 });
    expect(transportIntentForKey({ key: "ArrowRight" })).toEqual({ type: "step", frames: 1 });
    expect(transportIntentForKey({ key: "ArrowLeft", shiftKey: true })).toEqual({
      type: "seekBy",
      seconds: -1
    });
    expect(transportIntentForKey({ key: "ArrowRight", shiftKey: true })).toEqual({
      type: "seekBy",
      seconds: 1
    });
  });

  test("I / O set in / out; Home / End seek", () => {
    expect(transportIntentForKey({ key: "i" })).toEqual({ type: "setIn" });
    expect(transportIntentForKey({ key: "o" })).toEqual({ type: "setOut" });
    expect(transportIntentForKey({ key: "Home" })).toEqual({ type: "seekStart" });
    expect(transportIntentForKey({ key: "End" })).toEqual({ type: "seekEnd" });
  });

  test("⌘ / ⌃ / ⌥ combos are not ours (⌘F search, ⌘[ reel scrub, …)", () => {
    expect(transportIntentForKey({ key: " ", metaKey: true })).toBeNull();
    expect(transportIntentForKey({ key: "ArrowLeft", ctrlKey: true })).toBeNull();
    expect(transportIntentForKey({ key: "i", altKey: true })).toBeNull();
    expect(transportIntentForKey({ key: "k", metaKey: true })).toBeNull();
  });

  test("shift + letter is not ours (leaves ⇧I etc. to the app)", () => {
    expect(transportIntentForKey({ key: "I", shiftKey: true })).toBeNull();
    expect(transportIntentForKey({ key: "J", shiftKey: true })).toBeNull();
  });

  test("Escape and unrelated keys fall through", () => {
    expect(transportIntentForKey({ key: "Escape" })).toBeNull();
    expect(transportIntentForKey({ key: "Enter" })).toBeNull();
    expect(transportIntentForKey({ key: "a" })).toBeNull();
    expect(transportIntentForKey({ key: "ArrowUp" })).toBeNull();
  });
});

describe("isTextEntryTarget", () => {
  test("inputs, textareas, selects and contentEditable are text entry", () => {
    expect(isTextEntryTarget({ tagName: "INPUT" } as unknown as EventTarget)).toBe(true);
    expect(isTextEntryTarget({ tagName: "textarea" } as unknown as EventTarget)).toBe(true);
    expect(isTextEntryTarget({ tagName: "SELECT" } as unknown as EventTarget)).toBe(true);
    expect(
      isTextEntryTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget)
    ).toBe(true);
  });

  test("buttons / divs / null are not", () => {
    expect(isTextEntryTarget({ tagName: "BUTTON" } as unknown as EventTarget)).toBe(false);
    expect(isTextEntryTarget({ tagName: "DIV" } as unknown as EventTarget)).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });
});

describe("nextShuttleRate", () => {
  test("from idle starts at 1×; same direction climbs the ladder and caps", () => {
    expect(nextShuttleRate(null, 1)).toBe(1);
    expect(nextShuttleRate({ direction: 1, rate: 1 }, 1)).toBe(2);
    expect(nextShuttleRate({ direction: 1, rate: 2 }, 1)).toBe(4);
    expect(nextShuttleRate({ direction: 1, rate: 8 }, 1)).toBe(SHUTTLE_RATES.at(-1));
  });

  test("reversing direction restarts at 1×", () => {
    expect(nextShuttleRate({ direction: 1, rate: 4 }, -1)).toBe(1);
    expect(nextShuttleRate({ direction: -1, rate: 2 }, 1)).toBe(1);
  });
});
