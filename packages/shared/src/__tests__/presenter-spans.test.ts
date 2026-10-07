import { describe, expect, test } from "vitest";
import { DEFAULT_AVATAR_STYLE, type AvatarStyle, type PresenterSpan } from "../camera";
import {
  mapPresenterSpans,
  normalizePresenterSpans,
  presenterSpanAt,
  storedPresenterAt,
  withPresenterSpan
} from "../presenter-spans";

const at = (x: number): AvatarStyle => ({ ...DEFAULT_AVATAR_STYLE, x });
const xs = (spans: PresenterSpan[]) => spans.map((s) => [s.start, s.end, s.avatar.x]);

describe("presenter spans", () => {
  const base = at(0.7);
  const spans = [{ start: 2, end: 5, avatar: at(0.1) }];

  test("a span shows inside its window; the recording's presenter elsewhere", () => {
    expect(storedPresenterAt(base, spans, 1)?.x).toBe(0.7);
    expect(storedPresenterAt(base, spans, 2)?.x).toBe(0.1);
    expect(storedPresenterAt(base, spans, 4.99)?.x).toBe(0.1);
    // A boundary belongs to what comes after it.
    expect(presenterSpanAt(spans, 5)).toBeNull();
  });

  test("giving a piece its own presenter replaces what covered it", () => {
    const next = withPresenterSpan(spans, { start: 4, end: 8 }, at(0.4), 10);
    expect(xs(next)).toEqual([
      [2, 4, 0.1],
      [4, 8, 0.4]
    ]);
  });

  test("an edit inside a span splits it around the new piece", () => {
    expect(xs(withPresenterSpan(spans, { start: 3, end: 4 }, at(0.5), 10))).toEqual([
      [2, 3, 0.1],
      [3, 4, 0.5],
      [4, 5, 0.1]
    ]);
  });

  test("null gives the range back to the recording's presenter", () => {
    expect(withPresenterSpan(spans, { start: 2, end: 5 }, null, 10)).toEqual([]);
    expect(xs(withPresenterSpan(spans, { start: 4, end: 9 }, null, 10))).toEqual([[2, 4, 0.1]]);
  });

  test("normalizing clamps to the take, drops slivers, and lets the newest write win", () => {
    expect(
      xs(
        normalizePresenterSpans(
          [
            { start: 0, end: 12, avatar: at(0.1) },
            { start: 3, end: 3.05, avatar: at(0.2) },
            { start: 4, end: 6, avatar: at(0.3) }
          ],
          10
        )
      )
    ).toEqual([
      [0, 4, 0.1],
      [4, 6, 0.3],
      [6, 10, 0.1]
    ]);
  });

  test("an all-pieces change reaches every span", () => {
    expect(xs(mapPresenterSpans(spans, (a) => ({ ...a, x: 0 })))).toEqual([[2, 5, 0]]);
  });
});
