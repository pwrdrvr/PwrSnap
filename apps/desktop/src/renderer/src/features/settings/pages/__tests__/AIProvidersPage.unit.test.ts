// Pure-function unit tests for the AI Providers page helpers.
// The full component renders a snapshot table + secret control; we
// skip the component render (no @testing-library) and test the
// small helpers it extracts.

import { describe, expect, test, vi } from "vitest";
import type { DesktopCodexDiscoverySnapshot } from "@pwrsnap/shared";
import { formatLastSetAt, resolveUsing } from "../AIProvidersPage";

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

describe("resolveUsing", () => {
  const snapshot: DesktopCodexDiscoverySnapshot = {
    refreshedAt: "2026-05-12T12:00:00.000Z",
    resolvedPath: "/opt/homebrew/bin/codex",
    candidates: [
      {
        path: "/opt/homebrew/bin/codex",
        source: "path",
        version: "0.125.0",
        available: true
      },
      {
        path: "/Applications/Codex.app/Contents/Resources/codex",
        source: "application",
        version: "0.130.0",
        available: true
      }
    ]
  };

  test("returns true when path matches the resolved binary", () => {
    expect(resolveUsing(snapshot, "/opt/homebrew/bin/codex")).toBe(true);
  });

  test("returns false for non-resolved paths", () => {
    expect(
      resolveUsing(snapshot, "/Applications/Codex.app/Contents/Resources/codex")
    ).toBe(false);
  });

  test("returns false when snapshot is null", () => {
    expect(resolveUsing(null, "/opt/homebrew/bin/codex")).toBe(false);
  });

  test("returns false when resolvedPath is null on the snapshot", () => {
    expect(
      resolveUsing(
        { ...snapshot, resolvedPath: null },
        "/opt/homebrew/bin/codex"
      )
    ).toBe(false);
  });
});
