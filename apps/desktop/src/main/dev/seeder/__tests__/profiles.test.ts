// Determinism + shape tests for the seeder's distribution algorithm.
// Re-running the same profile MUST produce a bit-identical row plan
// (same capturedAt + bundleId tuples, same ordering) — otherwise the
// "is the curve flat" measurement isn't reproducible. The shape
// checks pin down maxPerDay and the power-law tilt so a regression
// in `allocateRowsToDays` or the Zipf sampler shows up immediately.

import { describe, expect, test } from "vitest";

import {
  generateBundleIdCatalog,
  hashSeed,
  mulberry32,
  planRows,
  PROFILES,
  SYNTHETIC_BUNDLE_IDS
} from "../profiles";

describe("mulberry32", () => {
  test("two RNGs from the same seed produce identical sequences", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 10; i++) {
      expect(a()).toBe(b());
    }
  });

  test("different seeds produce different sequences", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(a()).not.toBe(b());
  });
});

describe("hashSeed", () => {
  test("is deterministic", () => {
    expect(hashSeed("pwrsnap-100")).toBe(hashSeed("pwrsnap-100"));
  });

  test("is well-distributed across small inputs", () => {
    const seen = new Set<number>();
    for (const s of ["a", "b", "c", "d", "e", "1", "2", "3"]) {
      seen.add(hashSeed(s));
    }
    expect(seen.size).toBe(8);
  });
});

describe("generateBundleIdCatalog", () => {
  test("produces N unique synthetic bundle ids", () => {
    const cat = generateBundleIdCatalog(100);
    expect(cat).toHaveLength(100);
    expect(new Set(cat).size).toBe(100);
    expect(cat[0]).toMatch(/^com\.pwrsnap\.synth\./);
  });

  test("SYNTHETIC_BUNDLE_IDS is the 100-entry catalog", () => {
    expect(SYNTHETIC_BUNDLE_IDS).toHaveLength(100);
  });
});

describe("planRows determinism", () => {
  test("same profile + same `now` produces identical plans", () => {
    // Pin `now` so the test isn't flaky with respect to wall clock.
    const now = new Date("2026-05-01T12:00:00Z");
    const a = planRows(PROFILES["100"], now);
    const b = planRows(PROFILES["100"], now);
    expect(a).toEqual(b);
  });

  test("changing the seed changes the plan", () => {
    const now = new Date("2026-05-01T12:00:00Z");
    const a = planRows(PROFILES["100"], now);
    const b = planRows({ ...PROFILES["100"], rngSeed: "different-seed" }, now);
    // Same row count, but different bundle assignments + timestamps.
    expect(a).toHaveLength(b.length);
    const sameAssignments = a.every(
      (row, i) => row.capturedAt === b[i]?.capturedAt && row.bundleId === b[i]?.bundleId
    );
    expect(sameAssignments).toBe(false);
  });
});

describe("planRows shape", () => {
  test("100 profile produces exactly 100 rows in temporal order", () => {
    const rows = planRows(PROFILES["100"], new Date("2026-05-01T12:00:00Z"));
    expect(rows).toHaveLength(100);
    rows.forEach((row, i) => {
      expect(row.index).toBe(i);
    });
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.capturedAt > rows[i - 1]!.capturedAt).toBe(true);
    }
  });

  test("1k profile respects maxPerDay cap (with small overflow tolerance)", () => {
    const rows = planRows(PROFILES["1k"], new Date("2026-05-01T12:00:00Z"));
    expect(rows).toHaveLength(1000);
    const perDay = new Map<string, number>();
    for (const row of rows) {
      const day = row.capturedAt.slice(0, 10);
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
    }
    // The +1ms-bump for duplicate timestamps can occasionally shift a
    // row across a UTC midnight boundary, padding a day's count by ≤1.
    // The maxPerDay cap is documented as a soft cap — accept ≤2 over.
    for (const [, count] of perDay) {
      expect(count).toBeLessThanOrEqual(PROFILES["1k"].maxPerDay + 2);
    }
  });

  test("bundle distribution is power-law-ish — top 10 carry the majority", () => {
    const rows = planRows(PROFILES["10k"], new Date("2026-05-01T12:00:00Z"));
    const counts = new Map<string, number>();
    for (const row of rows) {
      counts.set(row.bundleId, (counts.get(row.bundleId) ?? 0) + 1);
    }
    const sortedCounts = [...counts.values()].sort((a, b) => b - a);
    const top10Sum = sortedCounts.slice(0, 10).reduce((a, b) => a + b, 0);
    // Loose bound — the algorithm shuffles day weights but leaves
    // bundle weights sorted descending, so top-10 should carry "a lot."
    // Empirically lands around 50–65% at zipfS=1.0 over 100 bundles.
    expect(top10Sum / rows.length).toBeGreaterThan(0.4);
  });

  test("timestamps are unique even within heavy days (1ms-bump invariant)", () => {
    const rows = planRows(PROFILES["10k"], new Date("2026-05-01T12:00:00Z"));
    const seen = new Set<string>();
    for (const row of rows) {
      expect(seen.has(row.capturedAt)).toBe(false);
      seen.add(row.capturedAt);
    }
  });
});
