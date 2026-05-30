// Pins the chat default-name date to LOCAL time, not UTC. The bug: a
// chat created at 10pm in New York was named with tomorrow's UTC date.

// Force a non-UTC zone so local≠UTC near midnight. Node re-reads
// process.env.TZ for Date operations performed after this assignment
// (the imported module computes no dates at load time).
process.env.TZ = "America/New_York";

import { describe, expect, it } from "vitest";
import { localDateStamp } from "../chat-thread-controller";

describe("localDateStamp", () => {
  it("uses the local calendar date, not UTC (late-night NYC stays 'today')", () => {
    // 2026-05-30 02:30 UTC === 2026-05-29 22:30 in New York (EDT).
    // The UTC slice would wrongly give 2026-05-30.
    expect(localDateStamp(new Date("2026-05-30T02:30:00Z"))).toBe("2026-05-29");
  });

  it("matches the runtime's local calendar date for any instant", () => {
    for (const iso of ["2026-05-29T16:00:00Z", "2026-01-01T04:30:00Z", "2026-12-31T23:59:00Z"]) {
      const d = new Date(iso);
      // en-CA formats as YYYY-MM-DD in the LOCAL timezone.
      expect(localDateStamp(d)).toBe(d.toLocaleDateString("en-CA"));
    }
  });
});
