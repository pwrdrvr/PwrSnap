import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, test } from "vitest";
import { AppleFmEnrichmentBackend, AppleFmError } from "../enrichment";
import { AppleFmTimeoutError } from "../fm-cli";
import { createNativeCaptionRunner, probeNativeCaptionStatus } from "../native";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixtureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pwrsnap-native-caption-"));
  directories.push(dir);
  return dir;
}

describe.skipIf(process.platform === "win32")("native caption launch boundary", () => {
  test("on unsupported macOS versions both readiness and captioning leave the helper unlaunched", async () => {
    const dir = await fixtureDir();
    const binary = join(dir, "apple-caption");
    await writeFile(binary, '#!/bin/sh\nprintf "ran\\n" >> "${0%/*}/spawned"\nexit 1\n', {
      mode: 0o700
    });

    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 10, max: 26 }), fc.nat({ max: 9 }),
      async (major, minor) => {
        const version = `${major}.${minor}`;
        const run = createNativeCaptionRunner(binary, version);
        await expect(probeNativeCaptionStatus(run, version)).resolves.toMatchObject({
          state: "needs-macos"
        });
        const backend = new AppleFmEnrichmentBackend({
          platform: "darwin", scratchDir: dir, nativeRun: run,
          run: async () => { throw new Error("Unexpected CLI invocation"); }
        });
        await expect(backend.enrichCapture({
          imagePaths: [join(dir, "prepared.jpg")],
          metadata: {
            sourceAppName: "Fixture",
            sourceAppBundleId: null,
            captureKind: "image", widthPx: 640, heightPx: 480,
            capturedAt: "2026-11-22T10:00:00.000Z"
          }
        })).rejects.toMatchObject({ code: "not-ready", setupRelated: true, message: /macOS 27/ });
        await expect(readFile(join(dir, "spawned"))).rejects.toMatchObject({ code: "ENOENT" });
      }
    ), { numRuns: 20, examples: [[14, 0], [15, 0], [26, 6]] });
  });

  test("launch details never cross the transport, regardless of path or command", async () => {
    const dir = await fixtureDir();
    await fc.assert(fc.asyncProperty(
      fc.stringMatching(/^[a-z][a-z0-9]{0,10}$/),
      fc.constantFrom("status", "test", "caption"),
      async (suffix, command) => {
        const binary = join(dir, `private-install-${suffix}`, "apple-caption");
        const unavailable = createNativeCaptionRunner(binary, "27.2");
        const denied = join(dir, `non-executable-${suffix}`);
        await writeFile(denied, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
        const unreadable = createNativeCaptionRunner(denied, "27.2");

        const missingError = await unavailable([command], { timeoutMs: 1_000 }).catch((error: unknown) => error);
        const deniedError = await unreadable([command], { timeoutMs: 1_000 }).catch((error: unknown) => error);
        expect(missingError).toBeInstanceOf(AppleFmError);
        expect(missingError).toMatchObject({
          code: "not-ready", message: "the bundled Apple captions helper couldn't be found."
        });
        expect(deniedError).toBeInstanceOf(AppleFmError);
        expect(deniedError).toMatchObject({
          code: "failed", message: "the bundled Apple captions helper couldn't be started."
        });
        for (const error of [missingError, deniedError]) {
          expect(error).not.toHaveProperty("path");
          expect(error).not.toHaveProperty("cause");
        }
      }
    ), { numRuns: 20, examples: [["permissions", "caption"]] });
  });

  test("cancellation and timeout keep their own causes", async () => {
    const dir = await fixtureDir();
    const binary = join(dir, "apple-caption");
    await writeFile(binary, "#!/bin/sh\nexec /bin/sleep 5\n", { mode: 0o700 });
    const run = createNativeCaptionRunner(binary, "27.2");
    await expect(run(["caption"], { signal: AbortSignal.abort(), timeoutMs: 500 }))
      .rejects.toMatchObject({ name: "AbortError" });
    await expect(run(["caption"], { timeoutMs: 20 })).rejects.toBeInstanceOf(AppleFmTimeoutError);
  });
});
