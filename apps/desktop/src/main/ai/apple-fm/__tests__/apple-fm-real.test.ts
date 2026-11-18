// The real thing: the production probe and the production enrichment
// backend against /usr/bin/fm and Apple's on-device model.
//
// OPT-IN. It runs a model on the machine it is on, so it is skipped unless
// PWRSNAP_APPLE_FM_REAL=1 and the host is macOS. CI never sets it. The image
// is synthetic (drawn here), so no real capture is ever sent to the model:
//
//   PWRSNAP_APPLE_FM_REAL=1 npx vitest run --config vitest.workspace.ts \
//     apps/desktop/src/main/ai/apple-fm/__tests__/apple-fm-real.test.ts

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, test } from "vitest";
import { isEnrichmentResultEmpty } from "../../enrichment-schema";
import { prepareEnrichmentImage } from "../../enrichment-image";
import { AppleFmEnrichmentBackend } from "../enrichment";
import { defaultAppleFmProbeDeps, probeAppleFmStatus } from "../status";

const enabled = process.env.PWRSNAP_APPLE_FM_REAL === "1" && process.platform === "darwin";

describe.skipIf(!enabled)("Apple on-device model, for real", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test("the probe reports a state macOS actually gave, and a ready one names the model", async () => {
    const status = await probeAppleFmStatus(defaultAppleFmProbeDeps(() => null));
    console.log("[apple-fm-real] status:", JSON.stringify(status));
    expect(status.state).not.toBe("unsupported-platform");
    expect(status.state).not.toBe("probe-failed");
    if (status.state === "ready") expect(status.modelLabel).toBeTruthy();
  });

  test("a synthetic screenshot is captioned on-device through the production backend", async (ctx) => {
    const status = await probeAppleFmStatus(defaultAppleFmProbeDeps(() => null));
    if (status.state !== "ready") {
      console.log(`[apple-fm-real] model not ready (${status.state}); skipping the inference`);
      ctx.skip();
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), "pwrsnap-afm-real-"));
    dirs.push(dir);
    const source = join(dir, "synthetic.png");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="820">
      <rect width="100%" height="100%" fill="#1e1e1e"/>
      <rect width="100%" height="64" fill="#333"/>
      <text x="24" y="42" font-family="Menlo" font-size="24" fill="#fff">Terminal — zsh — build.log</text>
      <text x="24" y="140" font-family="Menlo" font-size="30" fill="#4ade80">$ pnpm test</text>
      <text x="24" y="200" font-family="Menlo" font-size="30" fill="#f87171">FAIL  src/invoice.test.ts &gt; totals &gt; adds tax</text>
      <text x="24" y="260" font-family="Menlo" font-size="30" fill="#fff">AssertionError: expected 107.5 to be 108</text>
      <text x="24" y="350" font-family="Menlo" font-size="30" fill="#facc15">Tests  1 failed | 37 passed (38)</text>
    </svg>`;
    await sharp(Buffer.from(svg)).png().toFile(source);
    // The same bounded preparation every enrichment run goes through.
    const prepared = await prepareEnrichmentImage(source, { tempRoot: dir });
    try {
      const startedAt = performance.now();
      const response = await new AppleFmEnrichmentBackend({ scratchDir: join(dir, "jail") }).enrichCapture({
        imagePaths: [prepared.path],
        metadata: {
          sourceAppName: "Terminal",
          sourceAppBundleId: "com.apple.Terminal",
          captureKind: "image",
          widthPx: 1400,
          heightPx: 820,
          capturedAt: "2026-11-17T10:00:00.000Z",
          existingUserTags: ["build-error", "terminal-output"]
        }
      });
      const ms = Math.round(performance.now() - startedAt);
      console.log(`[apple-fm-real] ${ms} ms:`, JSON.stringify(response.result));
      expect(response.modelProvider).toBe("apple:system");
      expect(response.model).toBe("system");
      expect(isEnrichmentResultEmpty(response.result)).toBe(false);
      expect(response.result.title?.length ?? 0).toBeGreaterThan(0);
      // It read the picture, not just the metadata.
      expect(JSON.stringify(response.result).toLowerCase()).toMatch(/test|fail|assert|terminal|build/);
    } finally {
      await prepared.cleanup();
    }
  }, 180_000);
});
