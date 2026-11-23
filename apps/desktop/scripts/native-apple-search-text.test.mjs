import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "vitest";

const run = promisify(execFile);

test.skipIf(process.platform !== "darwin")("native Apple search text only keeps bounded, verbatim Vision snippets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pwrsnap-apple-search-test-"));
  try {
    const native = resolve(import.meta.dirname, "..", "native", "apple-caption");
    const binary = join(dir, "verify");
    await run("xcrun", ["swiftc", "-parse-as-library", "-o", binary,
      join(native, "search-text.swift"), join(native, "tests", "search-text-test.swift")],
      { timeout: 90_000 });
    await run(binary, [], { timeout: 5_000 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 100_000);
