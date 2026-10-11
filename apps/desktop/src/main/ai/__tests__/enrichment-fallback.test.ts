import { describe, expect, test } from "vitest";
import type { Settings } from "@pwrsnap/shared";
import { DirectApiError, isConnectFailure } from "../direct-api/transport";
import {
  AcpAgentUnavailableError,
  enrichmentFallbackFor,
  isEnrichmentBackendUnavailable,
  settingsWithEnrichmentDefault
} from "../enrichment-fallback";

const CUSTOM = "custom:12345678-1234-4234-8234-123456789001";

function settings(primary: string | undefined, fallback: Settings["ai"]["enrichmentFallback"]): Settings {
  return {
    ai: {
      defaults: { libraryChat: {}, sizzleChat: {}, enrichment: primary === undefined ? {} : { provider: primary } },
      enrichmentFallback: fallback
    }
  } as unknown as Settings;
}

describe("isEnrichmentBackendUnavailable", () => {
  test.each([
    ["connection refused", new DirectApiError("x", undefined, true), true],
    ["404 (no model loaded)", new DirectApiError("x", 404), true],
    ["502 (proxy, stopped upstream)", new DirectApiError("x", 502), true],
    ["503", new DirectApiError("x", 503), true],
    ["504", new DirectApiError("x", 504), true],
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
