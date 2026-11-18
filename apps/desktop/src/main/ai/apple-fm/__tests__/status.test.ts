// What PwrSnap concludes from the fm tool's answers.
//
// The rule every case here protects: the tool being on disk is NOT
// readiness. `ready` is reached only when macOS itself says the system
// model is available AND Apple's terms are agreed AND fm is not configured
// to send prompts to another provider. Stated twice: as a table of the
// tool's real sentences (measured on macOS 27.2), and as a property against
// an oracle written without reference to the probe's control flow.

import fc from "fast-check";
import { describe, expect, test, vi } from "vitest";
import type { AppleFmState, AppleFmStatus } from "@pwrsnap/shared";
import { assertAppleFmArgs, AppleFmTimeoutError, type FmRunResult } from "../fm-cli";
import {
  AppleFmStatusService,
  classifyUnavailableReason,
  parseFmModelsSystemRow,
  probeAppleFmStatus,
  saysLicenseRequired,
  type AppleFmProbeDeps
} from "../status";

const PCC_ROW =
  "  ✗ pcc                  (Private Cloud Compute is not available in this context. Please use the Terminal app.)";

const TOOL = {
  licenseAgreed: "Agreed to license FM1 version 1.1 on Oct 27, 2026 at 1:07 PM.\n",
  licenseNotAgreed: "Not agreed. Run 'sudo fm license' to review and agree.\n",
  providerUnset: "(none)\n",
  modelsReady: `  Apple Foundation Models\n  ✓ system (AFM 3 Core)\n${PCC_ROW}\n`,
  modelsNotEligible: `  Apple Foundation Models\n  ✗ system (This device does not support Apple Intelligence.)\n${PCC_ROW}\n`,
  modelsOff: `  Apple Foundation Models\n  ✗ system (Apple Intelligence is not enabled.)\n${PCC_ROW}\n`,
  modelsNotReady: `  Apple Foundation Models\n  ✗ system (The model is not available. Try again later.)\n${PCC_ROW}\n`,
  modelsUnknownReason: `  Apple Foundation Models\n  ✗ system (Something new in a later macOS.)\n${PCC_ROW}\n`,
  modelsNoSystemRow: `  Apple Foundation Models\n${PCC_ROW}\n`
} as const;

type Answer = Partial<FmRunResult> | Error;
type Script = {
  platform?: NodeJS.Platform;
  exists?: boolean;
  license?: Answer;
  provider?: Answer;
  models?: Answer;
};

function result(partial: Partial<FmRunResult>): FmRunResult {
  return { code: 0, signal: null, stdout: "", stderr: "", ...partial };
}

function deps(script: Script): { deps: AppleFmProbeDeps; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    deps: {
      platform: script.platform ?? "darwin",
      macosVersion: () => "27.2",
      fileExists: async () => script.exists ?? true,
      now: () => 1_700_000_000_000,
      run: async (args) => {
        // Every command the probe issues must pass the spawn-site rules.
        assertAppleFmArgs(args);
        calls.push([...args]);
        const answer =
          args[0] === "license"
            ? script.license ?? { stdout: TOOL.licenseAgreed }
            : args[0] === "config"
              ? script.provider ?? { stdout: TOOL.providerUnset }
              : script.models ?? { stdout: TOOL.modelsReady, code: 1 };
        if (answer instanceof Error) throw answer;
        return result(answer);
      }
    }
  };
}

async function probe(script: Script): Promise<AppleFmStatus> {
  return probeAppleFmStatus(deps(script).deps);
}

describe("probe transitions", () => {
  const cases: ReadonlyArray<[string, Script, AppleFmState, Partial<AppleFmStatus>]> = [
    ["not macOS", { platform: "win32" }, "unsupported-platform", { macosVersion: null }],
    ["Linux", { platform: "linux" }, "unsupported-platform", {}],
    ["macOS without the tool", { exists: false }, "needs-macos", { macosVersion: "27.2" }],
    [
      "terms not agreed",
      { license: { stdout: TOOL.licenseNotAgreed, code: 1 } },
      "license-required",
      { detail: "Not agreed. Run 'sudo fm license' to review and agree." }
    ],
    [
      "terms not agreed, reported with exit 0",
      { license: { stdout: TOOL.licenseNotAgreed } },
      "license-required",
      {}
    ],
    ["licence status unreadable", { license: { code: 2, stderr: "Error: boom" } }, "probe-failed", { detail: "boom" }],
    [
      "a default model provider is configured",
      { provider: { stdout: "http://localhost:1976/api/v1\n" } },
      "provider-override",
      { detail: null }
    ],
    ["the provider guard cannot be read", { provider: { code: 1, stderr: "Error: no config" } }, "probe-failed", {}],
    ["ready (fm models exits 1 because the cloud model is unavailable)", {}, "ready", { modelLabel: "AFM 3 Core" }],
    [
      "device not eligible",
      { models: { stdout: TOOL.modelsNotEligible, code: 1 } },
      "device-not-eligible",
      { detail: "This device does not support Apple Intelligence." }
    ],
    ["Apple Intelligence off", { models: { stdout: TOOL.modelsOff, code: 1 } }, "apple-intelligence-off", {}],
    [
      "model still downloading",
      { models: { stdout: TOOL.modelsNotReady, code: 1 } },
      "model-not-ready",
      { detail: "The model is not available. Try again later." }
    ],
    [
      "a reason this build does not know is reported verbatim, not guessed",
      { models: { stdout: TOOL.modelsUnknownReason, code: 1 } },
      "unavailable",
      { detail: "Something new in a later macOS." }
    ],
    ["no system row at all", { models: { stdout: TOOL.modelsNoSystemRow, code: 1 } }, "probe-failed", {}],
    [
      "the licence banner printed by another command",
      { models: { stderr: "YOU HAVE NOT AGREED TO THE FOUNDATION MODELS CLI LEGAL NOTICE & TERMS.\n", code: 1 } },
      "license-required",
      {}
    ],
    ["the tool hangs", { models: new AppleFmTimeoutError(10_000) }, "probe-failed", {}],
    ["the tool cannot be spawned", { license: Object.assign(new Error("spawn EACCES"), { code: "EACCES" }) }, "probe-failed", { detail: "spawn EACCES" }]
  ];

  test.each(cases)("%s", async (_name, script, state, extra) => {
    const status = await probe(script);
    expect(status.state).toBe(state);
    expect(status).toMatchObject(extra);
    expect(status.checkedAt).toBe(1_700_000_000_000);
  });

  test("an abort is not swallowed into a status", async () => {
    await expect(probe({ license: new DOMException("cancelled", "AbortError") })).rejects.toMatchObject({
      name: "AbortError"
    });
  });

  test("off macOS, and without the tool, nothing is spawned", async () => {
    for (const script of [{ platform: "win32" as const }, { exists: false }]) {
      const harness = deps(script);
      await probeAppleFmStatus(harness.deps);
      expect(harness.calls).toEqual([]);
    }
  });

  test("a ready probe asks three read-only questions and never runs a model turn", async () => {
    const harness = deps({});
    await probeAppleFmStatus(harness.deps);
    expect(harness.calls).toEqual([
      ["license", "--status"],
      ["config", "get", "default-model-provider"],
      ["models"]
    ]);
  });

  test("the configured provider value is never echoed into the status", async () => {
    const status = await probe({ provider: { stdout: "https://user:fixture-secret@example.invalid/v1\n" } });
    expect(JSON.stringify(status)).not.toContain("fixture-secret");
  });

  test("a long tool message is bounded", async () => {
    const status = await probe({ license: { code: 1, stderr: `Error: ${"x".repeat(5_000)}` } });
    expect(status.detail?.length).toBeLessThanOrEqual(240);
  });
});

describe("oracle: ready means macOS said so, with terms agreed and no other provider", () => {
  // Independent of the probe's control flow: three facts decide readiness.
  const licenseArb = fc.constantFrom<Answer>(
    { stdout: TOOL.licenseAgreed },
    { stdout: TOOL.licenseNotAgreed, code: 1 },
    { stdout: TOOL.licenseNotAgreed },
    { code: 3, stderr: "Error: unreadable" },
    new Error("spawn failed")
  );
  const providerArb = fc.constantFrom<Answer>(
    { stdout: TOOL.providerUnset },
    { stdout: "local\n" },
    { stdout: "https://example.invalid/v1\n" },
    { stdout: "" },
    { code: 1, stderr: "Error: nope" }
  );
  const modelsArb = fc.constantFrom<Answer>(
    { stdout: TOOL.modelsReady, code: 1 },
    { stdout: TOOL.modelsReady, code: 0 },
    { stdout: TOOL.modelsNotEligible, code: 1 },
    { stdout: TOOL.modelsOff, code: 1 },
    { stdout: TOOL.modelsNotReady, code: 1 },
    { stdout: TOOL.modelsUnknownReason, code: 1 },
    { stdout: TOOL.modelsNoSystemRow, code: 1 },
    { stdout: "", stderr: "Error: Model unavailable.", code: 1 },
    new AppleFmTimeoutError(1)
  );

  function oracleReady(script: Script): boolean {
    if ((script.platform ?? "darwin") !== "darwin" || script.exists === false) return false;
    const text = (r: Answer | undefined): string => (r instanceof Error || r === undefined ? "" : r.stdout ?? "");
    const ok = (r: Answer | undefined): boolean => !(r instanceof Error) && (r?.code ?? 0) === 0;
    return (
      ok(script.license) &&
      text(script.license).startsWith("Agreed") &&
      ok(script.provider) &&
      text(script.provider).trim() === "(none)" &&
      !(script.models instanceof Error) &&
      /✓\s+system/u.test(text(script.models))
    );
  }

  test("property", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<NodeJS.Platform>("darwin", "win32", "linux"),
        fc.boolean(),
        licenseArb,
        providerArb,
        modelsArb,
        async (platform, exists, license, provider, models) => {
          const script: Script = { platform, exists, license, provider, models };
          const status = await probe(script);
          expect(status.state === "ready").toBe(oracleReady(script));
          // The tool merely existing is never enough.
          if (status.state === "ready") expect(status.modelLabel).toBe("AFM 3 Core");
        }
      ),
      { numRuns: 400 }
    );
  });
});

describe("parsing the tool's sentences", () => {
  test("the system row is read; the cloud row never is", () => {
    expect(parseFmModelsSystemRow(TOOL.modelsReady)).toEqual({ available: true, modelLabel: "AFM 3 Core" });
    expect(parseFmModelsSystemRow(`  ✗ system\n  ✓ pcc (cloud)\n`)).toEqual({ available: false, reason: null });
    expect(parseFmModelsSystemRow(`  ✓ pcc (AFM Cloud)\n`)).toBeNull();
    // A custom provider's model that happens to contain "system" is not it.
    expect(parseFmModelsSystemRow(`  ✓ my-system-model\n  ✓ systematic (x)\n`)).toBeNull();
  });

  test("unavailable reasons map to the three states macOS documents", () => {
    expect(classifyUnavailableReason("This device does not support Apple Intelligence.")).toBe("device-not-eligible");
    expect(classifyUnavailableReason("Apple Intelligence is not enabled.")).toBe("apple-intelligence-off");
    expect(classifyUnavailableReason("The model is not available. Try again later.")).toBe("model-not-ready");
    expect(classifyUnavailableReason("The system is not ready. Try again later.")).toBe("model-not-ready");
    expect(classifyUnavailableReason("")).toBe("unavailable");
  });

  test("licence wording", () => {
    expect(saysLicenseRequired(TOOL.licenseNotAgreed)).toBe(true);
    expect(saysLicenseRequired("YOU HAVE NOT AGREED TO THE FOUNDATION MODELS CLI LEGAL NOTICE & TERMS.")).toBe(true);
    expect(saysLicenseRequired("You have not agreed to these terms. Exiting.")).toBe(true);
    expect(saysLicenseRequired(TOOL.licenseAgreed)).toBe(false);
  });
});

describe("AppleFmStatusService", () => {
  const ready: AppleFmStatus = { state: "ready", modelLabel: "AFM 3 Core", detail: null, macosVersion: "27.2", checkedAt: 1 };
  const notReady: AppleFmStatus = { ...ready, state: "model-not-ready", modelLabel: null, checkedAt: 2 };

  test("answers from its cache until told otherwise; nothing polls", async () => {
    const probeFn = vi.fn(async () => ready);
    const service = new AppleFmStatusService(probeFn);
    expect(service.peek()).toBeNull();
    await service.get();
    await service.get();
    await service.get(false);
    expect(probeFn).toHaveBeenCalledTimes(1);
    expect(service.peek()).toBe(ready);
  });

  test("concurrent reads share one probe", async () => {
    let release!: (status: AppleFmStatus) => void;
    const probeFn = vi.fn(() => new Promise<AppleFmStatus>((resolve) => { release = resolve; }));
    const service = new AppleFmStatusService(probeFn);
    const all = Promise.all([service.get(), service.get(true), service.get()]);
    release(ready);
    expect(await all).toEqual([ready, ready, ready]);
    expect(probeFn).toHaveBeenCalledTimes(1);
  });

  test("force and invalidate each ask macOS again", async () => {
    const probeFn = vi.fn<() => Promise<AppleFmStatus>>().mockResolvedValueOnce(notReady).mockResolvedValue(ready);
    const service = new AppleFmStatusService(probeFn);
    expect((await service.get()).state).toBe("model-not-ready");
    expect((await service.get(true)).state).toBe("ready");
    service.invalidate();
    expect(service.peek()).toBeNull();
    await service.get();
    expect(probeFn).toHaveBeenCalledTimes(3);
  });

  test("an invalidation outlives a probe that was already in flight", async () => {
    // The in-flight probe saw the world before the failure that invalidated
    // it. Its answer goes to whoever asked, but never back into the cache.
    let release!: (status: AppleFmStatus) => void;
    const probeFn = vi
      .fn<() => Promise<AppleFmStatus>>()
      .mockImplementationOnce(() => new Promise<AppleFmStatus>((resolve) => { release = resolve; }))
      .mockResolvedValue(notReady);
    const service = new AppleFmStatusService(probeFn);
    const early = service.get();
    service.invalidate();
    release(ready);
    expect(await early).toBe(ready);
    expect(service.peek()).toBeNull();
    // The next read asks macOS again instead of serving the disproved answer.
    expect(await service.get()).toBe(notReady);
    expect(probeFn).toHaveBeenCalledTimes(2);
  });

  test("a rejected probe is not cached and does not wedge the next read", async () => {
    const probeFn = vi.fn<() => Promise<AppleFmStatus>>().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(ready);
    const service = new AppleFmStatusService(probeFn);
    await expect(service.get()).rejects.toThrow("boom");
    expect(await service.get()).toBe(ready);
  });
});
