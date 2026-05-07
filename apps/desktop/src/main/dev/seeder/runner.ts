// Seeder orchestration. Walks a planned row list in temporal order,
// composes a tiny color-banded PNG per row via sharp, dispatches
// `capture:ingest` through the live command-bus, records per-bucket
// latency to JSONL, and absorbs the per-row `events:captures:changed`
// broadcasts so the live Library doesn't thrash on bulk inserts.
//
// Phase 5 layers cold-load + scroll instrumentation on top of the
// hooks here (`runColdLoadProbes`, `runScrollProbes`); for Phase 2
// they are stubs that emit a single JSONL row each so the schema
// remains stable.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

import { bus } from "../../command-bus";
import { installBroadcaster } from "../../events";
import { getDataRoot, getPerfRoot } from "../../persistence/paths";
import { getMainLogger } from "../../log";
import { getDb, openDatabase } from "../../persistence/db";
import { createSentinel, wipeDataRoot } from "./wipe";
import {
  isFlagged,
  PROFILES,
  planRows,
  type PlannedRow,
  type Profile,
  type ProfileName
} from "./profiles";

const log = getMainLogger("pwrsnap:dev-seeder:runner");

export type RunOptions = {
  /**
   * If true, allow flagged profiles like `stress100k`. Default false —
   * `stress100k` is gated behind explicit user intent.
   */
  allowFlagged?: boolean | undefined;
};

export type RunResult = {
  profile: ProfileName;
  totalRows: number;
  measurementPath: string;
  totalMs: number;
};

/**
 * Bucket boundaries at which we flush per-batch latency stats. Each
 * bucket emits a JSONL row with p50/p95/p99 across the dispatches
 * since the previous bucket boundary.
 */
const BUCKETS = [100, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 50_000, 100_000];

// ── PNG generator ─────────────────────────────────────────────────

/**
 * Compose a 64×64 PNG: bundle-id-derived hue background + 8×8 index
 * region top-left. ~150–250 bytes after PNG compression. Each row's
 * sha256 is unique because the index region's RGB derives from the
 * row index.
 *
 * `compressionLevel: 0` writes uncompressed PNG — fastest for
 * synthetic content where size doesn't matter (~20 MB at 100k rows
 * is acceptable on an external SSD).
 */
async function composePng(row: PlannedRow): Promise<Buffer> {
  const bg = bundleIdToColor(row.bundleId);
  const idx = indexToColor(row.index);
  const block = await sharp({
    create: {
      width: 8,
      height: 8,
      channels: 4,
      background: { r: idx.r, g: idx.g, b: idx.b, alpha: 1 }
    }
  })
    .png({ compressionLevel: 0 })
    .toBuffer();
  return sharp({
    create: {
      width: 64,
      height: 64,
      channels: 4,
      background: { r: bg.r, g: bg.g, b: bg.b, alpha: 1 }
    }
  })
    .composite([{ input: block, top: 0, left: 0 }])
    .png({ compressionLevel: 0 })
    .toBuffer();
}

function bundleIdToColor(bundleId: string): { r: number; g: number; b: number } {
  let h = 5381;
  for (let i = 0; i < bundleId.length; i++) {
    h = ((h << 5) + h + bundleId.charCodeAt(i)) | 0;
  }
  // Map to a HSL-inspired palette: warm, saturated, mid-light.
  const hue = (h >>> 0) % 360;
  return hslToRgb(hue, 0.55, 0.40);
}

function indexToColor(index: number): { r: number; g: number; b: number } {
  return {
    r: index & 0xff,
    g: (index >>> 8) & 0xff,
    b: (index >>> 16) & 0xff
  };
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60)       { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255)
  };
}

async function writeTempPng(perfTmpDir: string, row: PlannedRow): Promise<string> {
  const buf = await composePng(row);
  const path = join(perfTmpDir, `r${String(row.index).padStart(7, "0")}.png`);
  await writeFile(path, buf);
  return path;
}

// ── MeasurementRow + JSONL writer (sort-and-pick quantiles) ───────

export type MeasurementRow =
  | { type: "profile_start"; profile: ProfileName; rows: number; ts: string }
  | { type: "insert_bucket"; at_n: number; p50: number; p95: number; p99: number; wallMs: number }
  | { type: "db_size"; fileBytes: number; pageCount: number; pageSize: number }
  | { type: "db_index"; name: string; bytes: number; rows: number }
  | { type: "explain"; query: string; plan: readonly string[] }
  | {
      type: "cold_load";
      run: number;
      openMs: number;
      firstPaintMs: number;
      mode: "reload" | "recreate";
    }
  | {
      type: "scroll";
      durationMs: number;
      frames: number;
      droppedPct: number;
      p95FrameMs: number;
    }
  | { type: "scroll_error"; error: "timeout" | "no_window" }
  | { type: "error"; message: string }
  | { type: "profile_end"; totalMs: number };

class MeasurementStream {
  private readonly lines: string[] = [];
  private currentBucketSamples: number[] = [];
  private currentBucketStartMs = 0;
  private nextBucketIdx = 0;

  constructor(private readonly destPath: string) {}

  start(profile: ProfileName, rows: number): void {
    this.write({ type: "profile_start", profile, rows, ts: new Date().toISOString() });
    this.currentBucketStartMs = performance.now();
  }

  recordDispatch(elapsedMs: number, rowIndex: number): void {
    this.currentBucketSamples.push(elapsedMs);
    const bucketBoundary = BUCKETS[this.nextBucketIdx];
    if (bucketBoundary !== undefined && rowIndex + 1 === bucketBoundary) {
      this.flushBucket(bucketBoundary);
      this.nextBucketIdx += 1;
    }
  }

  private flushBucket(atN: number): void {
    const samples = this.currentBucketSamples;
    if (samples.length === 0) return;
    // Sort-and-pick: per-bucket samples ≤ ~50k × 8 bytes = ~400 KB,
    // sub-50ms sort. Reservoir sampling was overengineering.
    const sorted = [...samples].sort((a, b) => a - b);
    const p = (q: number): number => {
      const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
      return sorted[idx] ?? 0;
    };
    const wallMs = performance.now() - this.currentBucketStartMs;
    this.write({
      type: "insert_bucket",
      at_n: atN,
      p50: round3(p(0.5)),
      p95: round3(p(0.95)),
      p99: round3(p(0.99)),
      wallMs: round3(wallMs)
    });
    this.currentBucketSamples = [];
    this.currentBucketStartMs = performance.now();
  }

  write(row: MeasurementRow): void {
    this.lines.push(JSON.stringify(row));
  }

  async close(totalMs: number): Promise<string> {
    this.write({ type: "profile_end", totalMs: round3(totalMs) });
    await mkdir(getPerfRoot(), { recursive: true });
    await writeFile(this.destPath, this.lines.join("\n") + "\n", "utf8");
    log.info("measurement written", { destPath: this.destPath, lineCount: this.lines.length });
    return this.destPath;
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ── Probes (stubs for Phase 2; Phase 5 implements them) ───────────

async function runColdLoadProbes(measurement: MeasurementStream): Promise<void> {
  // Placeholder — Phase 5 wires renderer perf marks. Emit one row so
  // the schema is exercised and downstream readers don't break.
  measurement.write({
    type: "cold_load",
    run: 1,
    openMs: 0,
    firstPaintMs: 0,
    mode: "reload"
  });
}

async function runScrollProbes(measurement: MeasurementStream): Promise<void> {
  // Placeholder — Phase 5 wires the renderer-side RAF counter.
  measurement.write({
    type: "scroll",
    durationMs: 0,
    frames: 0,
    droppedPct: 0,
    p95FrameMs: 0
  });
}

async function captureSchemaSnapshot(measurement: MeasurementStream): Promise<void> {
  const db = getDb();
  try {
    const fileBytes = (db.pragma("page_count", { simple: true }) as number)
      * (db.pragma("page_size", { simple: true }) as number);
    measurement.write({
      type: "db_size",
      fileBytes,
      pageCount: db.pragma("page_count", { simple: true }) as number,
      pageSize: db.pragma("page_size", { simple: true }) as number
    });
  } catch (cause) {
    measurement.write({
      type: "error",
      message: `db_size pragma failed: ${cause instanceof Error ? cause.message : String(cause)}`
    });
  }
  // Phase 5 adds dbstat per-index sizes + EXPLAIN QUERY PLAN snapshots
  // for the four canonical Library queries.
}

// ── Run profile ───────────────────────────────────────────────────

export async function runProfile(name: ProfileName, options: RunOptions = {}): Promise<RunResult> {
  if (isFlagged(name) && options.allowFlagged !== true) {
    throw new Error(
      `Profile '${name}' is flagged (long-running). Pass --seed-stress to opt in.`
    );
  }
  const profile: Profile = PROFILES[name];
  log.info("profile run starting", { profile: name, rows: profile.rows });

  // Wipe before reseed so each profile is a clean slate. wipe.ts
  // refuses if PWRSNAP_DATA_ROOT is unset / equals userData, or if
  // the sentinel is missing/stale — protects the user's real Library.
  await wipeDataRoot();
  await mkdir(getDataRoot(), { recursive: true });
  createSentinel();

  // Open the DB after the wipe so migrations rebuild a fresh schema.
  await openDatabase();

  // Throttle per-row broadcasts. The seeder runner replaces the
  // active broadcaster with a no-op; the JSONL bucket-boundary
  // callback emits one real broadcast so the live Library can see
  // partial state if the user opens it mid-run.
  const broadcastCtl = installBroadcaster(() => {
    /* swallow per-row broadcasts */
  });

  // Plan rows + prepare scratch dir for temp PNGs.
  const plan = planRows(profile);
  const perfTmpDir = join(getPerfRoot(), "tmp");
  await mkdir(perfTmpDir, { recursive: true });

  const measurementPath = join(
    getPerfRoot(),
    `seed-${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`
  );
  const measurement = new MeasurementStream(measurementPath);
  measurement.start(name, plan.length);

  const t0 = performance.now();
  for (const row of plan) {
    const tempPath = await writeTempPng(perfTmpDir, row);
    const dispatchStart = performance.now();
    const result = await bus.dispatch(
      "capture:ingest",
      {
        tempPngPath: tempPath,
        capturedAt: row.capturedAt,
        sourceAppBundleId: row.bundleId,
        sourceAppName: row.appName
      },
      { principal: "seeder" }
    );
    const elapsed = performance.now() - dispatchStart;
    measurement.recordDispatch(elapsed, row.index);

    if (!result.ok) {
      measurement.write({ type: "error", message: `ingest row ${row.index}: ${result.error.message}` });
      throw new Error(`capture:ingest failed at row ${row.index}: ${result.error.message}`);
    }
    // sha256 collision = generator bug. Fail loud so EXPLAIN/curve
    // tests don't pass on a row-short DB.
    if (!result.value.isNew) {
      throw new Error(
        `sha256 collision at row ${row.index} (bundleId=${row.bundleId}). ` +
          `PNG generator must produce per-row unique bytes — see indexToColor.`
      );
    }

    // Periodic WAL checkpoint so the WAL doesn't grow unbounded.
    // PASSIVE so it doesn't block writers.
    if ((row.index + 1) % 10_000 === 0) {
      try {
        getDb().pragma("wal_checkpoint(PASSIVE)");
      } catch {
        /* checkpoint best-effort; continue */
      }
      // Surface partial state to any open Library window.
      broadcastCtl.flushOnce([]);
    }
  }
  // Restore default broadcaster + emit one final broadcast so live
  // Library sees the completed state.
  broadcastCtl.restore();
  broadcastCtl.flushOnce([]);

  // PRAGMA optimize after bulk insert so subsequent queries get
  // refreshed stats (best-practice from the deepening review).
  try {
    getDb().pragma("optimize");
  } catch {
    /* best-effort */
  }

  await captureSchemaSnapshot(measurement);
  await runColdLoadProbes(measurement);
  await runScrollProbes(measurement);

  // Cleanup scratch dir — every PNG is now owned by source-store.
  if (existsSync(perfTmpDir)) {
    await rm(perfTmpDir, { recursive: true, force: true });
  }

  const totalMs = performance.now() - t0;
  await measurement.close(totalMs);

  log.info("profile run complete", {
    profile: name,
    totalRows: plan.length,
    totalMs: round3(totalMs),
    measurementPath
  });

  return {
    profile: name,
    totalRows: plan.length,
    measurementPath,
    totalMs
  };
}
