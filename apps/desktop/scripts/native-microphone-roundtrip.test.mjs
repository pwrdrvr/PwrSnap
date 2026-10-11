import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const run = promisify(execFile);

async function runWithDiagnostics(binary, args, options) {
  try {
    return await run(binary, args, options);
  } catch (error) {
    // Vitest's default execFile error omits stdout/stderr on a timeout.
    // Keep the native stages in the message before the temp dir is removed.
    throw new Error(
      `Native microphone fixture failed (code=${error.code}, signal=${error.signal}, killed=${error.killed}).\n` +
      `stdout:\n${error.stdout ?? ""}\nstderr:\n${error.stderr ?? ""}`,
      { cause: error }
    );
  }
}

test("a blocked native process reports its last stage within the deadline", async () => {
  await expect(runWithDiagnostics(process.execPath, ["-e",
    'process.stderr.write("roundtrip: start decoding\\n"); setInterval(() => {}, 1000);'
  ], { timeout: 1_000 })).rejects.toThrow(/killed=true[\s\S]*roundtrip: start decoding/);
});

test.skipIf(process.platform !== "darwin")("microphone samples survive a real AVFoundation AAC round trip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pwrsnap-microphone-roundtrip-"));
  try {
    const native = resolve(import.meta.dirname, "..", "native", "recorder");
    const binary = join(dir, "verify");
    await run("xcrun", ["swiftc", "-parse-as-library", "-o", binary,
      join(native, "microphone.swift"), join(native, "audio-level.swift"),
      join(native, "tests", "microphone-roundtrip.swift")], { timeout: 90_000 });
    const result = await runWithDiagnostics(binary, [join(dir, "microphone.mp4")], { timeout: 30_000 });
    expect(result.stdout).toContain("microphone AAC roundtrip: appended=48");
    expect(result.stderr).toContain("roundtrip: tone writer completed");
    expect(result.stderr).toContain("roundtrip: quiet writer completed status=2");
    expect(result.stderr).toContain("roundtrip: decode offline PCM");
    expect(result.stderr).toMatch(/roundtrip: decoded \d+ samples/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 125_000);
