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
import { ipcMain } from "electron";
import sharp from "sharp";
import { IterableQueueMapperSimple } from "@shutterstock/p-map-iterable";
import {
  EVENT_CHANNELS,
  type PerfMarkPayload,
  type ScrollProbeRequest
} from "@pwrsnap/shared";

import { bus } from "../../command-bus";
import { installBroadcaster } from "../../events";
import { getDataRoot, getPerfRoot } from "../../persistence/paths";
import { getMainLogger } from "../../log";
import { getDb, openDatabase } from "../../persistence/db";
import { compose } from "../../render/compose";
import { findMainLibraryWindow } from "../../window";
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

// ── Thumb pre-render ──────────────────────────────────────────────
//
// Production behavior: when a user captures, the float-over toast
// shows immediately and asks for a 1440w preview, and the Library's
// next render asks for 400w cells. By the time the user opens the
// Library full-screen, the on-disk render cache is already warm.
//
// The seeder's `capture:ingest` doesn't trigger any of those views,
// so the cache stays empty. First scroll through 10k rows then hits
// thousands of cache misses simultaneously, each going through main
// → sharp → file write → response, and the protocol-handler queue
// chokes. Result: blank cells that paint slowly behind the scroll.
//
// Fix: pre-render the Library's grid-cell width (400 webp) for every
// inserted row, in the background, with bounded concurrency. The
// inserts stay sequential (preserves temporal order, exercises real
// DB packing); thumb renders run in a parallel queue that drains
// after the insert loop.
//
// Concurrency = 8 was chosen as a reasonable default — sharp's
// libvips runs its own thread pool, and 8 outstanding render jobs
// keeps it busy without thrashing. The Library only ever asks for
// width=400, so we render only that size; other widths (800 for the
// tray, 1440 for the float-over) will still hit the runtime
// protocol handler when first viewed.
const THUMB_RENDER_CONCURRENCY = 8;
const THUMB_RENDER_WIDTH = 400;

type ThumbRenderJob = {
  captureId: string;
  srcPath: string;
  widthPx: number;
  heightPx: number;
};

async function renderOneThumb(job: ThumbRenderJob): Promise<void> {
  // compose() handles cache-hit / cache-miss / atomic write itself.
  // We don't go through the coordinator (which de-dupes concurrent
  // calls) because the seeder dispatches each captureId exactly once.
  await compose({
    captureId: job.captureId,
    srcPath: job.srcPath,
    imageWidthPx: job.widthPx,
    imageHeightPx: job.heightPx,
    width: THUMB_RENDER_WIDTH,
    format: "webp"
  });
}

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
  | { type: "thumb_render_done"; wallMs: number; errors: number }
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

// ── Probes ────────────────────────────────────────────────────────

const COLD_LOAD_RUNS = 3;
const COLD_LOAD_TIMEOUT_MS = 30_000;

/**
 * Wait for the next `library:firstPaint` perf mark from any renderer.
 * Returns the mark payload + the wall-time delta from when this fn
 * was called. Resolves with `null` on timeout.
 */
function awaitFirstPaint(): Promise<{ ms: number; rowsRendered: number } | null> {
  return new Promise((resolve) => {
    const start = performance.now();
    const timer = setTimeout(() => {
      ipcMain.removeListener(EVENT_CHANNELS.perfMark, listener);
      resolve(null);
    }, COLD_LOAD_TIMEOUT_MS);
    const listener = (_event: unknown, payload: PerfMarkPayload): void => {
      if (payload.kind !== "library:firstPaint") return;
      clearTimeout(timer);
      ipcMain.removeListener(EVENT_CHANNELS.perfMark, listener);
      resolve({
        ms: performance.now() - start,
        rowsRendered: payload.rowsRendered
      });
    };
    ipcMain.on(EVENT_CHANNELS.perfMark, listener);
  });
}

/**
 * Cold-load probe. Two modes:
 *   • reload (primary) — keep the Library window mounted; reload the
 *     URL to drop in-memory state and re-fetch the head page. Measures
 *     the data-relevant cold path without window-construction noise.
 *   • recreate (baseline) — close + recreate the window once for a
 *     full cold-start number.
 *
 * Both rely on the renderer-side `library:firstPaint` perf mark.
 *
 * SKIPPED in CLI mode (`--seed=<profile>`): the CLI boot path skips
 * `registerIpcDispatcher` + library handlers + window infrastructure
 * to avoid bringing up the UI mid-seed. There's no rendered UI to
 * cold-load against; the probe writes a `scroll_error: skipped` row
 * for schema continuity. Run cold-load measurement separately by
 * launching the Library interactively against the seeded data root.
 */
async function runColdLoadProbes(measurement: MeasurementStream): Promise<void> {
  // CLI seed runs skip handler + dispatcher registration. If no
  // Library window exists, creating one would mount a renderer that
  // calls `library:list` and crashes on the missing 'cmd' handler.
  // Detect by absence and skip cleanly.
  const initialWin = findMainLibraryWindow();
  if (initialWin === null) {
    measurement.write({ type: "scroll_error", error: "no_window" });
    return;
  }
  // Foreground the window + disable RAF throttling so the measurement
  // reflects real perf, not a backgrounded window's throttled RAF
  // (~1Hz). The user's terminal has focus during CLI probe-only mode;
  // without this, the scroll probe in particular runs at ~2fps and
  // p95FrameMs reports the throttle, not real frame work.
  initialWin.show();
  initialWin.focus();
  initialWin.webContents.setBackgroundThrottling(false);

  for (let run = 1; run <= COLD_LOAD_RUNS; run++) {
    const win = findMainLibraryWindow();
    if (win === null) {
      measurement.write({ type: "scroll_error", error: "no_window" });
      return;
    }

    const openStart = performance.now();
    win.reload();
    const firstPaint = await awaitFirstPaint();
    const openMs = performance.now() - openStart;
    if (firstPaint === null) {
      measurement.write({ type: "scroll_error", error: "timeout" });
      continue;
    }
    measurement.write({
      type: "cold_load",
      run,
      openMs: round3(openMs),
      firstPaintMs: round3(firstPaint.ms),
      mode: "reload"
    });
  }
}

const SCROLL_PROBE_DURATION_MS = 5000;
const SCROLL_PROBE_PX_PER_FRAME = 200;
const SCROLL_PROBE_TIMEOUT_MS = SCROLL_PROBE_DURATION_MS + 5000;

/**
 * Wait for the next `perf:scrollProbe:result` (or `:error`) perf mark
 * from any renderer. Returns the mark or null on timeout.
 */
function awaitScrollProbeResult(): Promise<
  | Extract<PerfMarkPayload, { kind: "perf:scrollProbe:result" }>
  | Extract<PerfMarkPayload, { kind: "perf:scrollProbe:error" }>
  | null
> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ipcMain.removeListener(EVENT_CHANNELS.perfMark, listener);
      resolve(null);
    }, SCROLL_PROBE_TIMEOUT_MS);
    const listener = (_event: unknown, payload: PerfMarkPayload): void => {
      if (
        payload.kind !== "perf:scrollProbe:result" &&
        payload.kind !== "perf:scrollProbe:error"
      ) {
        return;
      }
      clearTimeout(timer);
      ipcMain.removeListener(EVENT_CHANNELS.perfMark, listener);
      resolve(payload);
    };
    ipcMain.on(EVENT_CHANNELS.perfMark, listener);
  });
}

/**
 * Scroll probe. Dispatches the request to the live Library renderer,
 * which programmatically scrolls the virtualizer at fixed velocity
 * for `SCROLL_PROBE_DURATION_MS` and RAF-counts dropped frames. Skips
 * when no Library window exists (CLI seed runs).
 */
async function runScrollProbes(measurement: MeasurementStream): Promise<void> {
  const win = findMainLibraryWindow();
  if (win === null) {
    measurement.write({
      type: "scroll",
      durationMs: 0,
      frames: 0,
      droppedPct: 0,
      p95FrameMs: 0
    });
    measurement.write({ type: "scroll_error", error: "no_window" });
    return;
  }

  // Defense in depth — RAF in a backgrounded window throttles to ~1Hz
  // and the probe ends up measuring the throttle, not real frame work.
  // The cold-load probe sets these too, but a future caller might run
  // scroll without cold-load.
  win.show();
  win.focus();
  win.webContents.setBackgroundThrottling(false);

  const request: ScrollProbeRequest = {
    durationMs: SCROLL_PROBE_DURATION_MS,
    pxPerFrame: SCROLL_PROBE_PX_PER_FRAME
  };
  win.webContents.send(EVENT_CHANNELS.perfScrollProbeRequest, request);
  const result = await awaitScrollProbeResult();
  if (result === null) {
    measurement.write({ type: "scroll_error", error: "timeout" });
    return;
  }
  if (result.kind === "perf:scrollProbe:error") {
    measurement.write({
      type: "error",
      message: `scroll probe: ${result.reason}`
    });
    return;
  }
  measurement.write({
    type: "scroll",
    durationMs: round3(result.durationMs),
    frames: result.frames,
    droppedPct: round3(result.droppedPct),
    p95FrameMs: round3(result.p95FrameMs)
  });
}

const CANONICAL_QUERIES: ReadonlyArray<{ name: string; sql: string }> = [
  {
    name: "library:list@head",
    sql: `SELECT * FROM captures WHERE deleted_at IS NULL
          ORDER BY captured_at DESC, id DESC LIMIT 100`
  },
  {
    name: "library:list@page",
    sql: `SELECT * FROM captures WHERE deleted_at IS NULL
          AND (captured_at, id) < ('2025-01-01T00:00:00.000Z', 'aaa')
          ORDER BY captured_at DESC, id DESC LIMIT 100`
  },
  {
    name: "library:list@app",
    sql: `SELECT * FROM captures WHERE deleted_at IS NULL
          AND source_app_bundle_id = 'com.pwrsnap.synth.slack'
          ORDER BY captured_at DESC, id DESC LIMIT 100`
  },
  {
    name: "library:appStats",
    sql: `SELECT source_app_bundle_id, count FROM app_stats ORDER BY count DESC`
  }
];

async function captureSchemaSnapshot(measurement: MeasurementStream): Promise<void> {
  const db = getDb();
  // db_size — file bytes from page_count × page_size.
  try {
    const pageCount = db.pragma("page_count", { simple: true }) as number;
    const pageSize = db.pragma("page_size", { simple: true }) as number;
    measurement.write({
      type: "db_size",
      fileBytes: pageCount * pageSize,
      pageCount,
      pageSize
    });
  } catch (cause) {
    measurement.write({
      type: "error",
      message: `db_size pragma failed: ${cause instanceof Error ? cause.message : String(cause)}`
    });
  }
  // Per-index byte sizes via dbstat. Falls back to file-size only
  // if the build lacks the dbstat virtual table.
  try {
    const rows = db
      .prepare(
        `SELECT name, SUM(pgsize) AS bytes, MIN(payload) AS min_payload
         FROM dbstat
         WHERE name LIKE 'idx_%'
         GROUP BY name`
      )
      .all() as Array<{ name: string; bytes: number }>;
    for (const r of rows) {
      measurement.write({ type: "db_index", name: r.name, bytes: r.bytes, rows: 0 });
    }
  } catch {
    // dbstat unavailable — silent fallback.
  }
  // EXPLAIN QUERY PLAN for the canonical Library queries.
  for (const q of CANONICAL_QUERIES) {
    try {
      const planRows = db
        .prepare(`EXPLAIN QUERY PLAN ${q.sql}`)
        .all() as Array<{ detail: string }>;
      measurement.write({
        type: "explain",
        query: q.name,
        plan: planRows.map((p) => p.detail)
      });
    } catch (cause) {
      measurement.write({
        type: "error",
        message: `EXPLAIN ${q.name} failed: ${cause instanceof Error ? cause.message : String(cause)}`
      });
    }
  }
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

  // Background thumb renderer. Each successful ingest enqueues a
  // job; the queue runs THUMB_RENDER_CONCURRENCY at a time. enqueue()
  // blocks the caller when the queue is full, providing natural
  // backpressure so we don't accumulate Mb of pending sharp jobs in
  // memory at stress100k scale.
  const thumbQueue = new IterableQueueMapperSimple<ThumbRenderJob>(renderOneThumb, {
    concurrency: THUMB_RENDER_CONCURRENCY
  });
  const thumbStart = performance.now();

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

    // Enqueue thumb render. await blocks if the queue is full
    // (backpressure: the insert loop pauses if sharp can't keep up,
    // bounding memory regardless of profile size).
    await thumbQueue.enqueue({
      captureId: result.value.record.id,
      // Perf seeder uses the legacy capture-flow (putCaptureSource +
      // insertOrFindCapture) — synthesized rows always have
      // legacy_src_path populated. Bundle-flow captures (live ⌘⇧P)
      // route through persistCaptureFromTemp and use bundle_path
      // instead.
      srcPath: result.value.record.legacy_src_path ?? "",
      widthPx: result.value.record.width_px,
      heightPx: result.value.record.height_px
    });

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
  // Drain pending thumb renders before reporting completion. onIdle()
  // resolves when every enqueued job has finished.
  await thumbQueue.onIdle();
  const thumbWallMs = performance.now() - thumbStart;
  measurement.write({
    type: "thumb_render_done",
    wallMs: round3(thumbWallMs),
    errors: thumbQueue.errors.length
  });
  if (thumbQueue.errors.length > 0) {
    log.warn("thumb-render errors", { count: thumbQueue.errors.length });
    for (const err of thumbQueue.errors.slice(0, 5)) {
      measurement.write({
        type: "error",
        message: `thumb-render: ${err.error instanceof Error ? err.error.message : String(err.error)}`
      });
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

/**
 * Probe-only run: measure against an existing seeded data root WITHOUT
 * re-seeding. Cheap (a few seconds vs. minutes for stress100k) and
 * useful for repeated UI-perf sampling against the same dataset.
 *
 * No wipe, no insert loop. Opens the DB if not already open, snapshots
 * schema + EXPLAIN plans, runs cold-load + scroll probes, writes JSONL.
 *
 * Caller is responsible for ensuring `PWRSNAP_DATA_ROOT` points at a
 * pre-seeded tree (we don't validate row counts; an empty tree just
 * produces empty/skipped probe rows).
 */
export async function runProbeOnly(name: ProfileName): Promise<RunResult> {
  log.info("probe-only run starting", { profile: name });

  // Open the DB against the configured data root. Idempotent — if
  // another caller already opened it (interactive boot), reuses the
  // singleton.
  await openDatabase();

  const measurementPath = join(
    getPerfRoot(),
    `probe-${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`
  );
  const measurement = new MeasurementStream(measurementPath);
  // Profile name is recorded in the JSONL header so the result file
  // self-describes which seeded dataset it targeted; rows is the
  // declared profile size, not a re-count of what's actually in the
  // DB (probes are about the load/scroll path, not the data shape).
  measurement.start(name, PROFILES[name].rows);

  const t0 = performance.now();
  await captureSchemaSnapshot(measurement);
  await runColdLoadProbes(measurement);
  await runScrollProbes(measurement);
  const totalMs = performance.now() - t0;
  await measurement.close(totalMs);

  log.info("probe-only run complete", {
    profile: name,
    totalMs: round3(totalMs),
    measurementPath
  });

  return {
    profile: name,
    totalRows: PROFILES[name].rows,
    measurementPath,
    totalMs
  };
}
