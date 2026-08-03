import { describe, expect, test } from "vitest";
import type { AppLogEntry } from "@pwrsnap/shared";
import { filterForLevel, renderLines } from "./LogsWindow";

function entry(sequence: number, level: string, line: string): AppLogEntry {
  return { sequence, timestamp: sequence, level, line };
}

describe("LogsWindow log rendering", () => {
  test("normalizes electron-log levels for filtering", () => {
    expect(filterForLevel("warning")).toBe("warn");
    expect(filterForLevel("trace")).toBe("debug");
    expect(filterForLevel("silly")).toBe("info");
  });

  test("finds case-insensitive matches across formatted lines", () => {
    const rendered = renderLines([
      entry(1, "info", "[time] [info ] (scope) Codex tool ok"),
      entry(2, "warn", "[time] [warn ] (scope) codex tool failed")
    ], "CODEX");
    expect(rendered.matchCount).toBe(2);
    expect(rendered.lines[0]?.parts.some((part) => part.matchIndex === 0)).toBe(true);
    expect(rendered.lines[1]?.parts.some((part) => part.matchIndex === 1)).toBe(true);
  });
});
