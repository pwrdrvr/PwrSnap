// Source-level guard for the volume slider's mouse affordance.
//
// Why a source scan and not a render test: this is a Blink DEFAULT-ACTION
// behavior, and jsdom implements none of it. A range input's value change
// on click/drag happens inside `RangeInputType::HandleMouseDownEvent`,
// which `EventDispatcher::DispatchEventPostProcess` runs only when the
// event is not `defaultPrevented`. Under jsdom, dispatching a mousedown
// with a `preventDefault` listener changes nothing either way, so a
// render test passes identically against the broken and the fixed code —
// it would be tautological.
//
// What shipped: the transport's five <button>s share an
// `onMouseDown={keepFocus}` handler that calls `preventDefault()` to stop
// the button stealing focus from the stage. That is correct for a button,
// which activates on `click`. The same handler was put on the new
// <input type="range">, where the value change IS the default action — so
// the slider was completely inert to click and drag, keyboard-only, while
// looking perfectly normal. Measured in Chromium against two otherwise
// identical inputs and the same click: the guarded one stayed at 1.0 with
// zero `input` events, the unguarded one moved to 0.26 with one.
//
// The slider is also hover-revealed (width 0 → 64px), so the mouse is its
// primary affordance; losing it loses the control.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname, "..", "VideoTransport.tsx"),
  "utf8"
);

/** The JSX element opening at `<input`, up to its closing `/>`. */
function rangeInputMarkup(): string {
  const start = source.indexOf("<input");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("/>", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("volume slider mouse affordance", () => {
  test("the range input does not suppress its own default action", () => {
    const markup = rangeInputMarkup();
    expect(markup).toContain('type="range"');
    // Any mousedown handler here is suspect, but `keepFocus` specifically
    // calls preventDefault and is the one that broke it.
    expect(markup).not.toContain("keepFocus");
    expect(markup).not.toContain("onMouseDown");
  });

  test("the buttons still keep focus off themselves", () => {
    // The counterpart: `keepFocus` is correct on buttons and must not be
    // removed wholesale in the course of fixing the slider. Play, loop,
    // mute and fullscreen all rely on it so the stage keeps the keyboard.
    const handlers = source.match(/onMouseDown=\{keepFocus\}/g) ?? [];
    expect(handlers.length).toBeGreaterThanOrEqual(4);
  });

  test("keepFocus is still what it claims to be", () => {
    // If this ever stops calling preventDefault the test above is moot.
    expect(source).toContain("keepFocus = (e: { preventDefault: () => void }): void");
  });
});
