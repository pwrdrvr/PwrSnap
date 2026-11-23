// The real thing: the production probe and the production enrichment
// backend against the bundled helper or /usr/bin/fm and Apple's on-device model.
//
// OPT-IN. It runs a model on the machine it is on, so it is skipped unless
// PWRSNAP_APPLE_FM_NATIVE_REAL=1 (bundled) or PWRSNAP_APPLE_FM_REAL=1 (CLI)
// and the host is macOS. CI never sets either. The images are synthetic.
//
//   PWRSNAP_APPLE_FM_NATIVE_REAL=1 pnpm exec vitest run \
//     apps/desktop/src/main/ai/apple-fm/__tests__/apple-fm-real.test.ts

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterAll, describe, expect, test } from "vitest";
import { isEnrichmentResultEmpty } from "../../enrichment-schema";
import { prepareEnrichmentImage } from "../../enrichment-image";
import { AppleFmEnrichmentBackend } from "../enrichment";
import { defaultAppleFmProbeDeps, probeAppleFmStatus } from "../status";
import { createNativeCaptionRunner, probeNativeCaptionStatus } from "../native";

const enabled = process.env.PWRSNAP_APPLE_FM_REAL === "1" && process.platform === "darwin";
const nativeEnabled = process.env.PWRSNAP_APPLE_FM_NATIVE_REAL === "1" &&
  process.platform === "darwin" && process.arch === "arm64";

async function captionSyntheticStill(svg: string, appName: string, width: number, height: number) {
  const binary = fileURLToPath(new URL("../../../../../build/native/apple-caption", import.meta.url));
  const run = createNativeCaptionRunner(binary);
  expect(await probeNativeCaptionStatus(run, null)).toMatchObject({
    state: "ready", transport: "native"
  });
  const dir = await mkdtemp(join(tmpdir(), "pwrsnap-apple-caption-real-"));
  try {
    const source = join(dir, "synthetic.png");
    await sharp(Buffer.from(svg)).png().toFile(source);
    const prepared = await prepareEnrichmentImage(source, { tempRoot: dir });
    const response = await new AppleFmEnrichmentBackend({ scratchDir: dir, nativeRun: run })
      .enrichCapture({
        imagePaths: [prepared.path],
        metadata: {
          sourceAppName: appName,
          sourceAppBundleId: null,
          captureKind: "image",
          widthPx: width,
          heightPx: height,
          capturedAt: "2026-11-22T10:00:00.000Z"
        }
      });
    expect(response.userAgent).toMatch(/\(native\)$/);
    expect(response.result.textAnchors).toBeUndefined();
    return response.result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test.skipIf(!nativeEnabled).each([
  { fixture: "invoice", expectedOcr: "Payment pending approval" },
  { fixture: "shapes", expectedOcr: "" }
] as const)("the bundled Apple helper captions a synthetic $fixture on-device", async ({ expectedOcr }) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="700">
    <rect width="100%" height="100%" fill="#ffffff"/>
    ${expectedOcr ? `
      <rect width="1200" height="105" fill="#183150"/>
      <text x="40" y="74" font-size="48" fill="#fff">Freight invoice</text>
      <text x="40" y="240" font-size="56" fill="#182a42">${expectedOcr}</text>
      <text x="40" y="330" font-size="32" fill="#182a42">Scheduled payment for Harbor Freight Services</text>
    ` : '<circle cx="600" cy="350" r="220" fill="#183150"/>'}
  </svg>`;
  const result = await captionSyntheticStill(svg, "Fixture Ledger", 1200, 700);
  if (expectedOcr) {
    expect(`${result.title} ${result.description}`).toMatch(/invoice|payment/i);
    expect(result.ocrText.split("\n")).toContain(expectedOcr);
  } else {
    expect(result.ocrText).toBe("");
  }
}, 180_000);

test.skipIf(!nativeEnabled)("the bundled Apple helper keeps the filename and function name from a synthetic editor", async () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900">
    <rect width="100%" height="100%" fill="#171a1f"/>
    <path d="M0 0h1440v108H0z M0 864h1440v36H0z" fill="#303743"/>
    <g font-family="Menlo" font-size="23" fill="#e4e9f2">
      <text x="540" y="32">Fixture Code Editor</text>
      <text x="44" y="83">main.swift</text>
      <text x="44" y="172">import Foundation</text>
      <text x="44" y="237">func calculatePondSchedule() {</text>
      <text x="76" y="272">print("Reservoir review overdue")</text>
      <text x="44" y="307">}</text>
      <text x="1050" y="891">Ln 5, Col 1   UTF-8</text>
    </g>
  </svg>`;
  const { ocrText } = await captionSyntheticStill(svg, "Fixture Code Editor", 1440, 900);
  expect(ocrText).toContain("main.swift");
  expect(ocrText).toContain("calculatePondSchedule");
  expect(ocrText).not.toMatch(/Fixture Code Editor|\b(?:Ln 5|Col 1|UTF-8)\b/i);
}, 180_000);

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
