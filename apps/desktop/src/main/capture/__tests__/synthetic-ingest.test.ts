// `capture:ingest` skips the bundle write's fsyncs only inside an
// overridden data root, where the dev seeder runs and wipes the tree
// every time. The verb is registered in every dev build, so against the
// real library it must write durably like any capture.

import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  overridden: true,
  persist: vi.fn(async () => ({ record: { id: "cap_seed_000001" } }))
}));

vi.mock("../../persistence/bundle-store", () => ({
  persistCaptureFromTempV2: mocks.persist
}));
vi.mock("../../persistence/paths", () => ({
  isOverriddenDataRoot: () => mocks.overridden
}));

const { ingestSyntheticCapture } = await import("../synthetic-ingest");

const req = {
  tempPngPath: "/tmp/seed/r0000001.png",
  capturedAt: "2026-01-02T10:00:00.000Z",
  sourceAppBundleId: "com.pwrsnap.synth.slack",
  sourceAppName: "Slack"
};

beforeEach(() => {
  mocks.persist.mockClear();
});

describe("ingestSyntheticCapture", () => {
  test("skips fsync inside an overridden data root", async () => {
    mocks.overridden = true;
    await ingestSyntheticCapture(req);
    expect(mocks.persist).toHaveBeenCalledWith({
      tempPath: req.tempPngPath,
      capturedAt: req.capturedAt,
      sourceApp: { bundleId: req.sourceAppBundleId, appName: req.sourceAppName },
      devicePixelRatio: 2,
      durable: false
    });
  });

  test("writes durably against the real library", async () => {
    mocks.overridden = false;
    await ingestSyntheticCapture(req);
    expect(mocks.persist).toHaveBeenCalledWith(expect.objectContaining({ durable: true }));
  });
});
