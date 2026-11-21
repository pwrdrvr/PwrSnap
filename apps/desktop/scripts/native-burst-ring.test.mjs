import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const run = promisify(execFile);

// The burst still ring (native/recorder/burst.swift) against synthetic
// ScreenCaptureKit-shaped sample buffers: ring size, eviction on disk,
// pacing, capture order and pixel fidelity. No screen, no TCC.
test.skipIf(process.platform !== "darwin")("the burst ring keeps exactly the newest stills, on disk and in order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pwrsnap-burst-ring-"));
  try {
    const native = resolve(import.meta.dirname, "..", "native", "recorder");
    const binary = join(dir, "verify");
    const out = join(dir, "frames");
    await mkdir(out);
    await run("xcrun", ["swiftc", "-parse-as-library", "-o", binary,
      join(native, "burst.swift"), join(native, "tests", "burst-ring.swift")], { timeout: 90_000 });
    const result = await run(binary, [out], { timeout: 30_000 });
    expect(result.stdout).toContain("burst ring: ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 125_000);
