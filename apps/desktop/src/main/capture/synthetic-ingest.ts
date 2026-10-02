// Body of the dev-only `capture:ingest` verb, which the dev seeder
// dispatches once per synthetic row. capture-handlers.ts registers it
// only when `import.meta.env.DEV` is true; it lives in its own module so
// the seeder's tests can drive the exact write the verb performs.
//
// It writes through `persistCaptureFromTempV2`, the one capture write
// entrypoint, so every ingested row is a real v2 layer-tree bundle the
// coordinator can render. It used to insert a bare v1 row (no
// bundle_path), which the v2-only read path refuses: every seeded grid
// thumbnail was a broken image.
//
// Two departures from a real capture, both deliberate:
//   - No `persistAndBroadcast`, which would enqueue AI enrichment for
//     every synthetic row.
//   - `durable: false`, which drops the bundle write's two fsyncs. They
//     were most of a seeded row's cost, and the rows are synthetic and
//     wiped on every run.

import type { CaptureRecord, Req } from "@pwrsnap/shared";

import { persistCaptureFromTempV2 } from "../persistence/bundle-store";

export async function ingestSyntheticCapture(
  req: Req<"capture:ingest">
): Promise<CaptureRecord> {
  const { record } = await persistCaptureFromTempV2({
    tempPath: req.tempPngPath,
    capturedAt: req.capturedAt,
    sourceApp: { bundleId: req.sourceAppBundleId, appName: req.sourceAppName },
    devicePixelRatio: req.devicePixelRatio ?? 2,
    durable: false
  });
  return record;
}
