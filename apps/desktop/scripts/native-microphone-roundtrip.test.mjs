import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const run = promisify(execFile);

test.skipIf(process.platform !== "darwin")("microphone samples survive a real AVFoundation AAC round trip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pwrsnap-microphone-roundtrip-"));
  try {
    const native = resolve(import.meta.dirname, "..", "native", "recorder");
    const binary = join(dir, "verify");
    await run("xcrun", ["swiftc", "-parse-as-library", "-o", binary,
      join(native, "microphone.swift"), join(native, "tests", "microphone-roundtrip.swift")], { timeout: 90_000 });
    const result = await run(binary, [join(dir, "microphone.mp4")], { timeout: 30_000 });
    expect(result.stdout).toContain("microphone AAC roundtrip: appended=48");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 125_000);
