import { describe, expect, test } from "vitest";
import { ageTickMs, capturedAtMs, formatCaptureAgo, formatThumbAge } from "../float-over-age";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

// Local noon, so "yesterday" and the weekday are unambiguous in any zone.
const now = new Date(2026, 8, 28, 12, 0, 0).getTime();

describe("capture age", () => {
  test("the header counts in durations while they are short", () => {
    expect(formatCaptureAgo(now - 2 * SECOND, now)).toBe("just now");
    expect(formatCaptureAgo(now - 42 * SECOND, now)).toBe("42s ago");
    expect(formatCaptureAgo(now - (3 * MINUTE + 23 * SECOND), now)).toBe("3m 23s ago");
    expect(formatCaptureAgo(now - (HOUR + 3 * MINUTE + 59 * SECOND), now)).toBe("1h 3m ago");
  });

  test("a thumb carries the same duration, without 'ago'", () => {
    expect(formatThumbAge(now - 2 * SECOND, now)).toBe("2s");
    expect(formatThumbAge(now - (3 * MINUTE + 23 * SECOND), now)).toBe("3m 23s");
    expect(formatThumbAge(now - (HOUR + 3 * MINUTE), now)).toBe("1h 3m");
  });

  test("past a day it is a day, then a date", () => {
    const yesterday = new Date(2026, 8, 27, 9, 30).getTime();
    // 26.5h ago, so no longer a duration.
    expect(formatThumbAge(yesterday, now)).toBe("Yesterday");
    expect(formatCaptureAgo(yesterday, now)).toMatch(/^yesterday /);

    const tuesday = new Date(2026, 8, 22, 12, 0).getTime();
    const weekday = new Date(tuesday).toLocaleDateString(undefined, { weekday: "short" });
    expect(formatThumbAge(tuesday, now)).toBe(weekday);
    expect(formatCaptureAgo(tuesday, now).startsWith(`${weekday} `)).toBe(true);

    const older = new Date(2026, 8, 1, 12, 0).getTime();
    expect(formatThumbAge(older, now)).toBe(
      new Date(older).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    );
  });

  test("a capture stamped in the future reads as just now", () => {
    expect(formatCaptureAgo(now + 5 * MINUTE, now)).toBe("just now");
    expect(formatThumbAge(now + 5 * MINUTE, now)).toBe("0s");
  });

  test("seconds tick only while they are shown", () => {
    expect(ageTickMs(now - 59 * MINUTE, now)).toBe(SECOND);
    expect(ageTickMs(now - 2 * HOUR, now)).toBe(MINUTE);
  });

  test("an unparseable timestamp has no age", () => {
    expect(capturedAtMs("not a date")).toBeNull();
    expect(capturedAtMs("2026-09-27T10:00:00.000Z")).toBe(Date.UTC(2026, 8, 27, 10));
  });
});
