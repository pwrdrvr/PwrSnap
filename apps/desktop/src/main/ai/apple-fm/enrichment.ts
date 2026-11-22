// Capture enrichment on Apple's on-device model.
//
// One on-device turn per capture. The native helper receives the bounded
// images and capture metadata together. An older development checkout uses
// the guarded CLI. Both return a caption parsed by the shared validator.
//
// A failure never moves the capture to another provider. `AppleFmError` is
// deliberately not one of the errors `isEnrichmentBackendUnavailable`
// accepts: a refusal, a missing licence agreement, or a model still
// downloading is something the operator should see.

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { APPLE_FM_MODEL_ID, APPLE_FM_PROVIDER } from "@pwrsnap/shared";
import type {
  CaptureEnrichmentRequest,
  CaptureEnrichmentResponse,
  EnrichmentBackend
} from "../capture-enrichment-client";
import { agentScratchJail } from "../enrichment-sandbox";
import {
  CAPTURE_ENRICHMENT_BASE_INSTRUCTIONS,
  CAPTURE_ENRICHMENT_SCHEMA,
  buildCaptureEnrichmentPrompt,
  parseCaptureEnrichmentResponse
} from "../enrichment-schema";
import {
  AppleFmOutputLimitError,
  AppleFmTimeoutError,
  runAppleFm,
  type FmRunResult,
  type FmRunner
} from "./fm-cli";
import { APPLE_FM_PROBE_TIMEOUT_MS, isFmDefaultProviderUnset, saysLicenseRequired } from "./status";

/** The on-device model answers in seconds; this bounds a wedged run. */
export const APPLE_FM_ENRICHMENT_TIMEOUT_MS = 120_000;

/** Lane key in the shared enrichment queue. One run at a time: the model
 *  shares this Mac's memory and GPU with whatever the user is doing. */
export const APPLE_FM_QUEUE_LANE = APPLE_FM_PROVIDER;
export const APPLE_FM_QUEUE_CONCURRENCY = 1;

export const APPLE_FM_USER_AGENT = "PwrSnap Apple Foundation Models (fm)";
export const APPLE_FM_NATIVE_USER_AGENT = "PwrSnap Apple Foundation Models (native)";

export type AppleFmErrorCode =
  | "guardrail"
  | "license-required"
  | "not-ready"
  | "provider-override"
  | "timeout"
  | "invalid-output"
  | "failed";

/** A caption run on the on-device model that did not produce a caption.
 *  `message` is what the Library and the Float-Over show, after their own
 *  "Apple Intelligence could not read this snap: " — so each one is written
 *  to finish that sentence. */
export class AppleFmError extends Error {
  constructor(
    readonly code: AppleFmErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AppleFmError";
  }

  /** The failure is about this Mac's setup, so the cached status is stale. */
  get setupRelated(): boolean {
    return (
      this.code === "license-required" ||
      this.code === "not-ready" ||
      this.code === "provider-override"
    );
  }
}

const SETTINGS_HINT = "Open Settings → AI Providers → Apple Intelligence.";

/** Turn the tool's own failure text into the sentence the user reads.
 *
 *  Pass the tool's STDERR, never its stdout: stdout is where model output
 *  goes, and model output is derived from an untrusted screenshot. It must
 *  not choose the failure class, and it must not reach the run's error or
 *  the log. The tool's text only chooses the sentence, except for the
 *  bounded last-resort detail. Exported for tests. */
export function appleFmErrorFromOutput(text: string): AppleFmError {
  if (/guardrail/i.test(text)) {
    return new AppleFmError(
      "guardrail",
      "Apple's safety checks declined it. Regenerate, or pick another provider for captions."
    );
  }
  if (saysLicenseRequired(text)) {
    return new AppleFmError(
      "license-required",
      `Apple's terms for the on-device model haven't been agreed to on this Mac. ${SETTINGS_HINT}`
    );
  }
  if (
    /does not support Apple Intelligence|Apple Intelligence is not enabled|not available\. Try again later|not ready|Model unavailable/i.test(
      text
    )
  ) {
    return new AppleFmError(
      "not-ready",
      `the on-device model isn't available right now; macOS may still be downloading it. ${SETTINGS_HINT}`
    );
  }
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0)
    ?.replace(/^Error:\s*/i, "");
  const detail = line !== undefined ? ` (${line.length > 160 ? `${line.slice(0, 159)}…` : line})` : "";
  return new AppleFmError("failed", `the on-device model reported an error${detail}.`);
}

/** The bundled helper emits fixed machine-readable errors. Its stderr is
 * deliberately never presented verbatim. */
export function appleFmNativeError(result: string): AppleFmError {
  switch (result.trim()) {
    case "not-ready":
      return new AppleFmError("not-ready", "the on-device model is unavailable on this Mac.");
    case "guardrail":
      return new AppleFmError("guardrail", "Apple's safety checks declined it. Regenerate, or pick another provider for captions.");
    case "timeout":
      return new AppleFmError("timeout", "the on-device model didn't answer in time. Regenerate to try again.");
    default:
      return new AppleFmError("failed", "the on-device model could not finish the caption.");
  }
}

/** The exact `fm respond` argv for one enrichment. Pure and exported so the
 *  security-relevant shape is one greppable, testable value. */
export function buildAppleFmEnrichmentArgs(input: {
  schemaPath: string;
  instructions: string;
  imagePaths: readonly string[];
}): string[] {
  if (!isAbsolute(input.schemaPath)) throw new Error("fm schema path must be absolute");
  if (input.imagePaths.length === 0) throw new Error("fm enrichment needs at least one image");
  for (const path of input.imagePaths) {
    // App-prepared files only. An absolute path can never be read as a flag.
    if (!isAbsolute(path)) throw new Error("fm image path must be absolute");
  }
  return [
    "respond",
    "--no-stream",
    // Deterministic decoding: the same capture should not re-caption
    // differently on every Regenerate.
    "--greedy",
    "--model",
    APPLE_FM_MODEL_ID,
    "--schema",
    input.schemaPath,
    "--instructions",
    input.instructions,
    ...input.imagePaths.flatMap((path) => ["--image", path])
  ];
}

export function appleFmScratchDir(): string {
  return agentScratchJail(".apple-fm");
}

export type AppleFmEnrichmentOptions = {
  run?: FmRunner;
  nativeRun?: FmRunner;
  scratchDir?: string;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
};

export class AppleFmEnrichmentBackend implements EnrichmentBackend {
  private readonly run: FmRunner;
  private readonly nativeRun: FmRunner | undefined;
  private readonly scratchDir: string;
  private readonly timeoutMs: number;
  private readonly platform: NodeJS.Platform;

  constructor(options: AppleFmEnrichmentOptions = {}) {
    this.run = options.run ?? runAppleFm;
    this.nativeRun = options.nativeRun;
    this.scratchDir = options.scratchDir ?? appleFmScratchDir();
    this.timeoutMs = options.timeoutMs ?? APPLE_FM_ENRICHMENT_TIMEOUT_MS;
    this.platform = options.platform ?? process.platform;
  }

  async enrichCapture(req: CaptureEnrichmentRequest): Promise<CaptureEnrichmentResponse> {
    req.abortSignal?.throwIfAborted();
    if (this.platform !== "darwin") {
      throw new AppleFmError(
        "not-ready",
        "the on-device model is part of macOS and isn't available on this computer."
      );
    }
    // tmpdir can be reaped; make the jail before handing it to anything.
    await mkdir(this.scratchDir, { recursive: true });
    const result = this.nativeRun === undefined
      ? await this.invokeCli(req)
      : await this.invokeNative(this.nativeRun, req);

    let parsed: CaptureEnrichmentResponse["result"];
    try {
      parsed = parseCaptureEnrichmentResponse(result.stdout);
    } catch {
      throw new AppleFmError(
        "invalid-output",
        "the on-device model returned a caption PwrSnap couldn't read. Regenerate to try again."
      );
    }
    return {
      result: parsed,
      threadId: `apple-fm-${randomUUID()}`,
      turnId: randomUUID(),
      userAgent: this.nativeRun === undefined ? APPLE_FM_USER_AGENT : APPLE_FM_NATIVE_USER_AGENT,
      model: APPLE_FM_MODEL_ID,
      modelProvider: APPLE_FM_PROVIDER,
      serviceTier: null,
      tokens: null
    };
  }

  private async invokeNative(run: FmRunner, req: CaptureEnrichmentRequest): Promise<FmRunResult> {
    const result = await this.attempt(() => run(["caption"], {
      stdin: JSON.stringify({
        metadata: buildCaptureEnrichmentPrompt(req.metadata),
        imagePaths: req.imagePaths,
        recognizeText: req.metadata.captureKind === "image"
      }),
      cwd: this.scratchDir,
      timeoutMs: this.timeoutMs,
      ...(req.abortSignal !== undefined ? { signal: req.abortSignal } : {})
    }));
    if (result.code !== 0) throw appleFmNativeError(result.stderr);
    return result;
  }

  private async invokeCli(req: CaptureEnrichmentRequest): Promise<FmRunResult> {
    const signal = req.abortSignal !== undefined ? { signal: req.abortSignal } : {};
    const schemaPath = join(this.scratchDir, "capture-enrichment.schema.json");
    await writeFile(schemaPath, JSON.stringify(CAPTURE_ENRICHMENT_SCHEMA), "utf8");

    // Checked per run, not trusted from a cached status: a default provider
    // set in fm's own config after the last check must still stop a capture
    // from being handed to a tool that might send it elsewhere.
    const provider = await this.attempt(() =>
      this.run(["config", "get", "default-model-provider"], {
        timeoutMs: APPLE_FM_PROBE_TIMEOUT_MS,
        cwd: this.scratchDir,
        ...signal
      })
    );
    // `config get` runs no model, so both streams are the tool's own words.
    const providerText = `${provider.stdout}\n${provider.stderr}`;
    if (saysLicenseRequired(providerText)) throw appleFmErrorFromOutput(providerText);
    if (!isFmDefaultProviderUnset(provider)) {
      throw new AppleFmError(
        "provider-override",
        `the fm tool is set to use another model provider, so PwrSnap didn't run it. ${SETTINGS_HINT}`
      );
    }

    const result = await this.attempt(() =>
      this.run(
        buildAppleFmEnrichmentArgs({
          schemaPath,
          instructions: CAPTURE_ENRICHMENT_BASE_INSTRUCTIONS,
          imagePaths: req.imagePaths
        }),
        {
          stdin: buildCaptureEnrichmentPrompt(req.metadata),
          timeoutMs: this.timeoutMs,
          cwd: this.scratchDir,
          ...signal
        }
      )
    );
    if (result.code !== 0) {
      // stderr only: stdout can hold model output (see appleFmErrorFromOutput).
      throw appleFmErrorFromOutput(result.stderr);
    }

    return result;
  }

  private async attempt<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof AppleFmTimeoutError) {
        throw new AppleFmError(
          "timeout",
          "the on-device model didn't answer in time, so the run was stopped. Regenerate to try again."
        );
      }
      if (error instanceof AppleFmOutputLimitError) {
        throw new AppleFmError(
          "invalid-output",
          "the on-device model returned a caption PwrSnap couldn't read. Regenerate to try again."
        );
      }
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
        throw new AppleFmError(
          "not-ready",
          `the on-device model needs macOS 27 or later; its command-line tool isn't on this Mac. ${SETTINGS_HINT}`
        );
      }
      throw error;
    }
  }

  async close(): Promise<void> {}
}
