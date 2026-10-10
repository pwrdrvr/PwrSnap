import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const run = promisify(execFile);

test.skipIf(process.platform !== "darwin")("the recorder finds the selector's microphone by its Chromium name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pwrsnap-microphone-match-"));
  try {
    const native = resolve(import.meta.dirname, "..", "native", "recorder");
    const binary = join(dir, "verify");
    await run("xcrun", ["swiftc", "-parse-as-library", "-o", binary,
      join(native, "microphone.swift"), join(native, "audio-level.swift"),
      join(native, "tests", "microphone-match.swift")], { timeout: 90_000 });
    const result = await run(binary, [], { timeout: 30_000 });
    expect(result.stdout).toContain("microphone match: ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 125_000);
