import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const run = promisify(execFile);

// The burst still ring (native/recorder/burst.swift) against synthetic
// ScreenCaptureKit-shaped sample buffers: ring size, eviction on disk,
// pacing, capture order, pixel fidelity, and skipping frames that show
// nothing new. No screen, no TCC.
test.skipIf(process.platform !== "darwin")("the burst ring keeps exactly the newest stills, on disk and in order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pwrsnap-burst-ring-"));
  try {
    const native = resolve(import.meta.dirname, "..", "native", "recorder");
    const binary = join(dir, "verify");
    const out = join(dir, "frames");
    await mkdir(out);
    await run("xcrun", ["swiftc", "-parse-as-library", "-o", binary,
      join(native, "burst.swift"), join(native, "frame-change.swift"),
      join(native, "tests", "burst-ring.swift")], { timeout: 90_000 });
    const result = await run(binary, [out], { timeout: 30_000 });
    expect(result.stdout).toContain("burst ring: ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 125_000);

// changedPixelCount (native/recorder/frame-change.swift) against a naive
// per-pixel model over seeded random padded frames.
test.skipIf(process.platform !== "darwin")("the burst change count matches a per-pixel model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pwrsnap-frame-change-"));
  try {
    const native = resolve(import.meta.dirname, "..", "native", "recorder");
    const binary = join(dir, "verify");
    await run("xcrun", ["swiftc", "-parse-as-library", "-o", binary,
      join(native, "frame-change.swift"), join(native, "tests", "frame-change-model.swift")], { timeout: 90_000 });
    const result = await run(binary, [], { timeout: 30_000 });
    expect(result.stdout).toContain("frame change: ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 125_000);
