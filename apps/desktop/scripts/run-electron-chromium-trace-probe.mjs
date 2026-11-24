import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const scratch = await mkdtemp(join(tmpdir(), "pwrsnap-chromium-probe-"));
try {
  const script = fileURLToPath(new URL("./electron-chromium-trace-probe.mjs", import.meta.url));
  const result = spawnSync(electron, [script, scratch], {
    stdio: "inherit", timeout: 80_000, killSignal: "SIGKILL"
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  // Chromium can still write its profile during shutdown.
  await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
}
