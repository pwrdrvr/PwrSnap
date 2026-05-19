// Pure-function unit tests for the AI Providers page helpers.

import { describe, expect, test, vi } from "vitest";
import { formatLastSetAt, formatNextTokenAt } from "../AIProvidersPage";

describe("formatLastSetAt", () => {
  test("returns em-dash for null / empty input", () => {
    expect(formatLastSetAt(null)).toBe("—");
    expect(formatLastSetAt("")).toBe("—");
  });

  test("returns 'just now' under a minute", () => {
    vi.useFakeTimers();
    const now = new Date("2026-05-12T12:00:00.000Z");
    vi.setSystemTime(now);
    expect(formatLastSetAt("2026-05-12T11:59:30.000Z")).toBe("just now");
    vi.useRealTimers();
  });

  test("formats minutes / hours / days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T12:00:00.000Z"));
    expect(formatLastSetAt("2026-05-12T11:55:00.000Z")).toBe("5 mins ago");
    expect(formatLastSetAt("2026-05-12T11:00:00.000Z")).toBe("1 hour ago");
    expect(formatLastSetAt("2026-05-12T09:00:00.000Z")).toBe("3 hours ago");
    expect(formatLastSetAt("2026-05-10T12:00:00.000Z")).toBe("2 days ago");
    vi.useRealTimers();
  });

  test("falls back to an absolute YYYY-MM-DD past one week", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T12:00:00.000Z"));
    expect(formatLastSetAt("2026-05-01T12:00:00.000Z")).toBe("2026-05-01");
    vi.useRealTimers();
  });

  test("returns the raw input on parse failure rather than crashing", () => {
    expect(formatLastSetAt("not-an-iso-date")).toBe("not-an-iso-date");
  });
});

describe("formatNextTokenAt", () => {
  test("formats future token refill times without clamping to just now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T12:00:00.000Z"));
    expect(formatNextTokenAt("2026-05-12T12:00:30.000Z")).toBe("in 30s");
    expect(formatNextTokenAt("2026-05-12T12:05:00.000Z")).toBe("in 5 mins");
    expect(formatNextTokenAt("2026-05-12T14:00:00.000Z")).toBe("in 2 hours");
    vi.useRealTimers();
  });

  test("handles empty, past, and invalid token refill times", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T12:00:00.000Z"));
    expect(formatNextTokenAt(null)).toBe("soon");
    expect(formatNextTokenAt("")).toBe("soon");
    expect(formatNextTokenAt("2026-05-12T11:59:00.000Z")).toBe("now");
    expect(formatNextTokenAt("not-an-iso-date")).toBe("not-an-iso-date");
    vi.useRealTimers();
  });
});
