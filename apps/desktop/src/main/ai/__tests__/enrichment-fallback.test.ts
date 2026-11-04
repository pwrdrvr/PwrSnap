import { describe, expect, test } from "vitest";
import type { Settings } from "@pwrsnap/shared";
import { DirectApiError, isConnectFailure } from "../direct-api/transport";
import {
  AcpAgentUnavailableError,
  EnrichmentPrimaryHealth,
  enrichmentFallbackFor,
  isEnrichmentBackendUnavailable,
  settingsWithEnrichmentDefault
} from "../enrichment-fallback";

const CUSTOM = "custom:12345678-1234-4234-8234-123456789001";

function settings(primary: string | undefined, fallback: Settings["ai"]["enrichmentFallback"]): Settings {
  return {
    ai: {
      defaults: { libraryChat: {}, sizzleChat: {}, enrichment: primary === undefined ? {} : { provider: primary } },
      enrichmentFallback: fallback,
      acp: { enabledAgentIds: ["kimi"] }
    }
  } as unknown as Settings;
}

describe("isEnrichmentBackendUnavailable", () => {
  test.each([
    ["connection refused", new DirectApiError("x", undefined, undefined, true), true],
    ["404 (no model loaded)", new DirectApiError("x", 404), true],
    ["502 (proxy, stopped upstream)", new DirectApiError("x", 502), true],
    ["503", new DirectApiError("x", 503), true],
    ["504 (a slow upstream is a timeout)", new DirectApiError("x", 504), false],
    ["an uninstalled ACP agent", new AcpAgentUnavailableError("kimi"), true],
    ["401 (credential)", new DirectApiError("x", 401), false],
    ["403", new DirectApiError("x", 403), false],
    ["500 (the server answered)", new DirectApiError("x", 500), false],
    ["TLS / bad address (no socket code)", new DirectApiError("x"), false],
    ["invalid output", new DirectApiError("Model returned invalid enrichment JSON."), false],
    ["a plain error", new Error("boom"), false],
    ["a non-error", "boom", false]
  ])("%s → %s", (_label, error, expected) => {
    expect(isEnrichmentBackendUnavailable(error)).toBe(expected);
  });
});

describe("isConnectFailure", () => {
  test("finds the socket code undici nests under `cause`", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), { code: "ECONNREFUSED" });
    expect(isConnectFailure(new TypeError("fetch failed", { cause: refused }))).toBe(true);
  });

  test("finds it inside a happy-eyeballs AggregateError", () => {
    const v6 = Object.assign(new Error("v6"), { code: "ECONNREFUSED" });
    const v4 = Object.assign(new Error("v4"), { code: "ECONNREFUSED" });
    expect(isConnectFailure(new TypeError("fetch failed", { cause: new AggregateError([v6, v4]) }))).toBe(true);
  });

  test("a certificate failure is not unreachable", () => {
    const tls = Object.assign(new Error("self-signed"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    expect(isConnectFailure(new TypeError("fetch failed", { cause: tls }))).toBe(false);
  });

  test("survives a cause cycle", () => {
    const a: Error & { cause?: unknown } = new Error("a");
    a.cause = a;
    expect(isConnectFailure(a)).toBe(false);
  });
});

describe("enrichmentFallbackFor", () => {
  test("off when unset", () => {
    expect(enrichmentFallbackFor(settings(CUSTOM, null))).toBeNull();
    expect(enrichmentFallbackFor(settings(CUSTOM, undefined))).toBeNull();
  });

  test("armed for a Direct API or ACP primary", () => {
    expect(enrichmentFallbackFor(settings(CUSTOM, {}))).toEqual({});
    expect(enrichmentFallbackFor(settings("acp:kimi", { reasoning: "low" }))).toEqual({ reasoning: "low" });
  });

  test("never for a Codex primary — there is nothing to fall back from", () => {
    expect(enrichmentFallbackFor(settings(undefined, { provider: "acp:kimi" }))).toBeNull();
    expect(enrichmentFallbackFor(settings("codex", { provider: CUSTOM }))).toBeNull();
  });

  test("never for a disabled ACP agent's primary — that run is on Codex", () => {
    expect(enrichmentFallbackFor(settings("acp:qwen", {}))).toBeNull();
  });

  test("never back onto the primary itself", () => {
    expect(enrichmentFallbackFor(settings(CUSTOM, { provider: CUSTOM }))).toBeNull();
  });

  test("settingsWithEnrichmentDefault swaps only the enrichment slot", () => {
    const base = settings(CUSTOM, {});
    const swapped = settingsWithEnrichmentDefault(base, { provider: "acp:kimi" });
    expect(swapped.ai.defaults.enrichment).toEqual({ provider: "acp:kimi" });
    expect(base.ai.defaults.enrichment).toEqual({ provider: CUSTOM });
  });
});

describe("EnrichmentPrimaryHealth", () => {
  test("reports transitions only, and expires the down window", () => {
    let now = 0;
    const health = new EnrichmentPrimaryHealth(() => now, 60_000);
    expect(health.isDown(CUSTOM)).toBe(false);
    expect(health.markDown(CUSTOM)).toBe(true);
    expect(health.isDown(CUSTOM)).toBe(true);
    now = 60_000;
    // Expired: the next run probes again. Still down → no new transition.
    expect(health.isDown(CUSTOM)).toBe(false);
    expect(health.markDown(CUSTOM)).toBe(false);
    expect(health.isDown(CUSTOM)).toBe(true);
    // It answered: one transition back, then nothing to report.
    expect(health.markUp(CUSTOM)).toBe(true);
    expect(health.markUp(CUSTOM)).toBe(false);
    expect(health.isDown(CUSTOM)).toBe(false);
  });

  test("an outage runs from the first unreachable attempt to the next answer, fallback or not", () => {
    let now = 1_000;
    const health = new EnrichmentPrimaryHealth(() => now, 60_000);
    expect(health.endOutage(CUSTOM)).toBeNull();
    health.noteUnreachable(CUSTOM);
    now = 5_000;
    // A second failure does not move the start.
    health.noteUnreachable(CUSTOM);
    // Tracked apart from the fallback's down window.
    expect(health.isDown(CUSTOM)).toBe(false);
    now = 90_000;
    expect(health.endOutage(CUSTOM)).toEqual({ downSince: 1_000, upAt: 90_000 });
    expect(health.endOutage(CUSTOM)).toBeNull();
  });

  test("an outage left by a provider the user moved off ends when the new one answers", () => {
    let now = 1_000;
    const health = new EnrichmentPrimaryHealth(() => now, 60_000);
    health.noteUnreachable(CUSTOM);
    now = 2_000;
    expect(health.endOutage("codex")).toBeNull();
    now = 9_000_000;
    expect(health.endOutage(CUSTOM)).toBeNull();
  });
});
