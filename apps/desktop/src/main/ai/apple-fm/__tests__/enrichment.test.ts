// One caption run on Apple's on-device model, against a scripted tool.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { APPLE_FM_PROVIDER } from "@pwrsnap/shared";
import type { CaptureEnrichmentRequest } from "../../capture-enrichment-client";
import { isEnrichmentBackendUnavailable } from "../../enrichment-fallback";
import { CAPTURE_ENRICHMENT_BASE_INSTRUCTIONS, CAPTURE_ENRICHMENT_SCHEMA } from "../../enrichment-schema";
import { AppleFmEnrichmentBackend, AppleFmError, appleFmErrorFromOutput } from "../enrichment";
import {
  AppleFmOutputLimitError,
  AppleFmTimeoutError,
  assertAppleFmArgs,
  type FmRunOptions,
  type FmRunResult
} from "../fm-cli";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((task) => task()));
});

const CAPTION = {
  ocrText: "FAIL src/invoice.test.ts",
  title: "Failing invoice test in the terminal",
  description: "A terminal showing one failed unit test out of thirty-eight.",
  filenameStem: "terminal-failing-invoice-test",
  textAnchors: ["FAIL", "AssertionError"],
  tags: [{ label: "terminal-output", confidence: 1 }]
};

type Call = { args: string[]; options: FmRunOptions };
type Answer = Partial<FmRunResult> | Error;

async function harness(script: { provider?: Answer; respond?: Answer; platform?: NodeJS.Platform } = {}) {
  const scratchDir = await mkdtemp(join(tmpdir(), "pwrsnap-afm-enrich-"));
  cleanup.push(() => rm(scratchDir, { recursive: true, force: true }));
  const calls: Call[] = [];
  const backend = new AppleFmEnrichmentBackend({
    scratchDir,
    timeoutMs: 1_234,
    platform: script.platform ?? "darwin",
    run: async (args, options) => {
      assertAppleFmArgs(args);
      calls.push({ args: [...args], options });
      const answer =
        args[0] === "config"
          ? script.provider ?? { stdout: "(none)\n" }
          : script.respond ?? { stdout: JSON.stringify(CAPTION) };
      if (answer instanceof Error) throw answer;
      return { code: 0, signal: null, stdout: "", stderr: "", ...answer };
    }
  });
  return { backend, calls, scratchDir };
}

function request(overrides: Partial<CaptureEnrichmentRequest> = {}): CaptureEnrichmentRequest {
  return {
    imagePaths: ["/private/tmp/pwrsnap-fixture/prepared-1.jpg"],
    metadata: {
      sourceAppName: "Fixture Terminal",
      sourceAppBundleId: "example.fixture.terminal",
      captureKind: "image",
      widthPx: 900,
      heightPx: 560,
      capturedAt: "2026-11-17T10:00:00.000Z",
      existingUserTags: ["fixture-private-tag"]
    },
    ...overrides
  };
}

describe("a successful run", () => {
  test("returns the validated caption with on-device attribution and no usage", async () => {
    const { backend } = await harness();
    const response = await backend.enrichCapture(request());
    expect(response.result).toMatchObject({ title: CAPTION.title, filenameStem: CAPTION.filenameStem });
    expect(response).toMatchObject({
      model: "system",
      modelProvider: APPLE_FM_PROVIDER,
      serviceTier: null,
      tokens: null,
      userAgent: "PwrSnap Apple Foundation Models (fm)"
    });
    expect(response.threadId).toMatch(/^apple-fm-/);
  });

  test("checks fm's provider setting, then runs exactly one model turn", async () => {
    const { backend, calls, scratchDir } = await harness();
    await backend.enrichCapture(request({ imagePaths: ["/jail/frame-1.jpg", "/jail/frame-2.jpg"] }));
    expect(calls.map((call) => call.args[0])).toEqual(["config", "respond"]);
    const respond = calls[1]!;
    expect(respond.args).toEqual([
      "respond",
      "--no-stream",
      "--greedy",
      "--model",
      "system",
      "--schema",
      join(scratchDir, "capture-enrichment.schema.json"),
      "--instructions",
      CAPTURE_ENRICHMENT_BASE_INSTRUCTIONS,
      "--image",
      "/jail/frame-1.jpg",
      "--image",
      "/jail/frame-2.jpg"
    ]);
    expect(respond.options.timeoutMs).toBe(1_234);
    expect(respond.options.cwd).toBe(scratchDir);
  });

  test("the capture's metadata travels on stdin, never in argv", async () => {
    const { backend, calls } = await harness();
    await backend.enrichCapture(request());
    const respond = calls[1]!;
    expect(respond.options.stdin).toContain("Fixture Terminal");
    expect(respond.options.stdin).toContain("fixture-private-tag");
    const argv = respond.args.join("\n");
    expect(argv).not.toContain("Fixture Terminal");
    expect(argv).not.toContain("fixture-private-tag");
    expect(argv).not.toContain("example.fixture.terminal");
  });

  test("the schema handed to the tool is the shared enrichment schema", async () => {
    const { backend, scratchDir } = await harness();
    await backend.enrichCapture(request());
    const written = JSON.parse(await readFile(join(scratchDir, "capture-enrichment.schema.json"), "utf8"));
    expect(written).toEqual(CAPTURE_ENRICHMENT_SCHEMA);
  });

  test("a fenced JSON answer is accepted like every other backend's", async () => {
    const { backend } = await harness({ respond: { stdout: "```json\n" + JSON.stringify(CAPTION) + "\n```\n" } });
    expect((await backend.enrichCapture(request())).result.title).toBe(CAPTION.title);
  });
});

describe("failures fail closed", () => {
  async function failure(script: Parameters<typeof harness>[0]): Promise<AppleFmError> {
    const { backend } = await harness(script);
    const error = await backend.enrichCapture(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppleFmError);
    return error as AppleFmError;
  }

  test("a configured default provider stops the run before any capture is handed over", async () => {
    const { backend, calls } = await harness({ provider: { stdout: "https://example.invalid/v1\n" } });
    const error = await backend.enrichCapture(request()).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "provider-override", setupRelated: true });
    expect(calls.map((call) => call.args[0])).toEqual(["config"]);
    expect((error as Error).message).not.toContain("example.invalid");
  });

  test("an unreadable provider setting also stops the run", async () => {
    const { backend, calls } = await harness({ provider: { code: 1, stderr: "Error: nope" } });
    await expect(backend.enrichCapture(request())).rejects.toMatchObject({ code: "provider-override" });
    expect(calls).toHaveLength(1);
  });

  test.each([
    ["Error: The model's safety guardrails were triggered.", "guardrail", false],
    ["Not agreed. Run 'sudo fm license' to review and agree.", "license-required", true],
    ["Error: The model is not available. Try again later.", "not-ready", true],
    ["Error: This device does not support Apple Intelligence.", "not-ready", true],
    ["Error: Unable to load image at '/jail/x.jpg'", "failed", false]
  ] as const)("%s → %s", async (stderr, code, setupRelated) => {
    const error = await failure({ respond: { code: 1, stderr } });
    expect(error.code).toBe(code);
    expect(error.setupRelated).toBe(setupRelated);
  });

  test("model output never chooses the failure class or reaches the message", async () => {
    // stdout is where model output goes, and it is derived from an untrusted
    // screenshot. Only the tool's own stderr may classify or be quoted.
    const leaked = await failure({
      respond: { code: 1, stdout: "fixture-screenshot-text about a guardrail\nNot agreed.", stderr: "" }
    });
    expect(leaked.code).toBe("failed");
    expect(leaked.setupRelated).toBe(false);
    expect(leaked.message).toBe("the on-device model reported an error.");
    expect(leaked.message).not.toContain("fixture-screenshot-text");

    const real = await failure({
      respond: { code: 1, stdout: "fixture-screenshot-text", stderr: "Error: The model's safety guardrails were triggered." }
    });
    expect(real.code).toBe("guardrail");
  });

  test("an answer that is not the schema is a failure, not a blank caption", async () => {
    expect((await failure({ respond: { stdout: "I can't help with that." } })).code).toBe("invalid-output");
    expect((await failure({ respond: { stdout: "" } })).code).toBe("invalid-output");
  });

  test("a wedged run and a runaway output are reported, not thrown raw", async () => {
    expect((await failure({ respond: new AppleFmTimeoutError(1_234) })).code).toBe("timeout");
    expect((await failure({ respond: new AppleFmOutputLimitError() })).code).toBe("invalid-output");
  });

  test("a Mac without the tool says what it needs", async () => {
    const error = await failure({ provider: Object.assign(new Error("spawn /usr/bin/fm ENOENT"), { code: "ENOENT" }) });
    expect(error).toMatchObject({ code: "not-ready" });
    expect(error.message).toContain("macOS 27");
  });

  test("off macOS nothing is run at all", async () => {
    const { backend, calls } = await harness({ platform: "win32" });
    await expect(backend.enrichCapture(request())).rejects.toMatchObject({ code: "not-ready" });
    expect(calls).toEqual([]);
  });

  test("cancellation propagates as an abort, before and during the run", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const first = await harness();
    await expect(first.backend.enrichCapture(request({ abortSignal: aborted.signal }))).rejects.toMatchObject({
      name: "AbortError"
    });
    expect(first.calls).toEqual([]);

    const second = await harness({ respond: new DOMException("fm run cancelled", "AbortError") });
    const controller = new AbortController();
    await expect(second.backend.enrichCapture(request({ abortSignal: controller.signal }))).rejects.toMatchObject({
      name: "AbortError"
    });
    expect(second.calls[1]?.options.signal).toBe(controller.signal);
  });

  test("no on-device failure is one the caption fallback may act on", async () => {
    // AGENTS.md: the fallback trigger set is not widened. A refusal, missing
    // terms or a model still downloading is something the operator must see.
    for (const stderr of [
      "Error: The model's safety guardrails were triggered.",
      "Not agreed. Run 'sudo fm license' to review and agree.",
      "Error: The model is not available. Try again later.",
      "Error: anything else"
    ]) {
      expect(isEnrichmentBackendUnavailable(appleFmErrorFromOutput(stderr))).toBe(false);
    }
    expect(isEnrichmentBackendUnavailable(new AppleFmError("timeout", "x"))).toBe(false);
  });

  test("messages finish the UI's sentence and bound the tool's own text", () => {
    const long = appleFmErrorFromOutput(`Error: ${"y".repeat(2_000)}`);
    expect(long.message.length).toBeLessThan(260);
    expect(appleFmErrorFromOutput("").message).toBe("the on-device model reported an error.");
  });
});
