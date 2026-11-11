import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CHATGPT_PLAN_BASE_URL, CHATGPT_USAGE_LIMIT_MESSAGE, type ResolvedCustomModel } from "@pwrsnap/shared";
import { CustomCredentials } from "../../direct-api/credentials";
import { DirectApiError, discoverApi, invokeApi } from "../../direct-api/transport";
import { body, json, model, server, stream } from "../../direct-api/__tests__/fixtures";
import { planErrorMessage, requiresPlanSignIn } from "../errors";

// Sign in with ChatGPT is a Direct API connection: PwrSnap calls
// /v1/responses itself, with the request shape the token-sharing preview
// requires, and no agent harness is involved.
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((fn) => fn())); });

function planModel(baseUrl: string): ResolvedCustomModel {
  // A saved model may say streaming is off; the plan route needs it on.
  return { ...model(baseUrl, "openai-responses"), auth: { type: "chatgpt" }, capabilities: { vision: true, streaming: false } };
}
function session(token = "fixture-plan-token") {
  return { accessToken: vi.fn(async () => token), signedIn: vi.fn(async () => true), signOut: vi.fn(), invalidate: vi.fn(async () => undefined) };
}
const noSecrets = { getValue: vi.fn(), replace: vi.fn(), clear: vi.fn(), getStatus: vi.fn() };

describe("SIWC direct API boundary", () => {
  test("Responses body streams, stores nothing, and omits fields the plan route rejects", async () => {
    let seen: Record<string, unknown> = {};
    const http = await server(async (req, res) => {
      seen = JSON.parse(await body(req)) as Record<string, unknown>;
      stream(res, [{ type: "response.output_text.delta", delta: "fixture answer" }, { type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 2 } } }]);
    }); cleanup.push(http.close);
    const result = await invokeApi({ model: planModel(`${http.url}/v1`), headers: {}, system: "fixture system", messages: [{ role: "user", text: "fixture input" }] });
    expect(result.text).toBe("fixture answer");
    expect(seen).toMatchObject({ stream: true, store: false, instructions: "fixture system" });
    expect(Array.isArray(seen.input)).toBe(true);
    for (const field of ["max_output_tokens", "temperature", "top_p", "previous_response_id", "background", "conversation",
      "metadata", "prompt", "prompt_cache_retention", "safety_identifier", "truncation", "user", "tools"])
      expect(seen).not.toHaveProperty(field);
  });

  test("a failed stream surfaces the plan's message, keeps the code, and never shows the code", async () => {
    const http = await server((_req, res) => {
      stream(res, [{ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "server text" } } }]);
    }); cleanup.push(http.close);
    const failure = await invokeApi({ model: planModel(`${http.url}/v1`), headers: {}, system: "", messages: [{ role: "user", text: "x" }] }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(DirectApiError);
    expect((failure as DirectApiError).message).toBe(CHATGPT_USAGE_LIMIT_MESSAGE);
    expect((failure as DirectApiError).code).toBe("subscription_sharing_usage_limit_exceeded");
    expect((failure as DirectApiError).message).not.toContain("subscription_sharing");
  });

  test("an HTTP error's documented code becomes its message", async () => {
    const http = await server((_req, res) => {
      res.statusCode = 403; json(res, { error: { code: "subscription_sharing_user_not_eligible", message: "server text" } });
    }); cleanup.push(http.close);
    await expect(invokeApi({ model: planModel(`${http.url}/v1`), headers: {}, system: "", messages: [{ role: "user", text: "x" }] }))
      .rejects.toThrow("ChatGPT plan usage isn't available for this account");
  });

  test("the account catalog lists only visible models, in server order, with vision only when stated", async () => {
    const http = await server((_req, res) => json(res, { models: [
      { slug: "fixture-hidden", display_name: "Hidden", visibility: "hidden" },
      { slug: "fixture-visible", display_name: "Visible", visibility: "list", input_modalities: ["text", "image"] },
      { slug: "fixture-text", display_name: "Text", visibility: "list", input_modalities: ["text"] },
      { slug: "fixture-unstated", display_name: "Bad\u0007name", visibility: "list" }
    ] })); cleanup.push(http.close);
    const { models } = await discoverApi({ baseUrl: `${http.url}/v1`, protocol: "openai-responses" }, {});
    expect(models).toEqual([
      { id: "fixture-visible", displayName: "Visible", vision: true },
      { id: "fixture-text", displayName: "Text", vision: false },
      { id: "fixture-unstated", vision: null }
    ]);
  });

  test("the plan token is only ever sent to api.openai.com", async () => {
    const plan = session();
    const credentials = new CustomCredentials(noSecrets, async () => undefined, plan);
    const endpoint = { connectionId: "fixture-conn", protocol: "openai-responses" as const, auth: { type: "chatgpt" as const } };
    expect(await credentials.headers({ ...endpoint, baseUrl: CHATGPT_PLAN_BASE_URL })).toEqual({ Authorization: "Bearer fixture-plan-token" });
    for (const baseUrl of ["http://127.0.0.1:1/v1", "https://api.openai.com.fixture.test/v1", "https://api.openai.com/v2"])
      await expect(credentials.headers({ ...endpoint, baseUrl })).rejects.toThrow("can only call api.openai.com");
    expect(plan.accessToken).toHaveBeenCalledOnce();
    expect(noSecrets.getValue).not.toHaveBeenCalled();
  });

  test("only a revoked-grant code clears the session", async () => {
    const plan = session();
    const credentials = new CustomCredentials(noSecrets, async () => undefined, plan);
    const endpoint = { connectionId: "fixture-conn", baseUrl: CHATGPT_PLAN_BASE_URL, protocol: "openai-responses" as const, auth: { type: "chatgpt" as const } };
    await credentials.noteFailure(endpoint, new DirectApiError("x", 429, "subscription_sharing_usage_limit_exceeded"));
    await credentials.noteFailure(endpoint, new Error("subscription_sharing_invalid_user"));
    expect(plan.invalidate).not.toHaveBeenCalled();
    await credentials.noteFailure(endpoint, new DirectApiError("x", 401, "subscription_sharing_invalid_user"));
    expect(plan.invalidate).toHaveBeenCalledOnce();
  });

  test("error codes map to sentences; unknown codes do not", () => {
    expect(planErrorMessage("subscription_sharing_usage_limit_exceeded")).toBe(CHATGPT_USAGE_LIMIT_MESSAGE);
    expect(planErrorMessage("subscription_sharing_usage_unavailable")).toContain("Try again");
    expect(planErrorMessage("fixture_unknown_code")).toBeUndefined();
    expect(planErrorMessage(undefined)).toBeUndefined();
    expect(requiresPlanSignIn("chatpass_v2_scope_not_authorized")).toBe(true);
    expect(requiresPlanSignIn("subscription_sharing_usage_unavailable")).toBe(false);
  });

  test("no agent harness, MCP tool, or settings write reaches the plan", () => {
    const sources = ["../session.ts", "../oauth-client.ts", "../../../handlers/chatgpt-plan-handlers.ts"]
      .map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
    expect(sources).not.toMatch(/codex-agent-pool|app-server|CodexAgentPool|acp/i);
    const registry = readFileSync(new URL("../../../local-agents/mcp-tool-registry.ts", import.meta.url), "utf8");
    expect(registry).not.toContain("chatgptPlan:");
    const validators = readFileSync(new URL("../../../handlers/settings-validators.ts", import.meta.url), "utf8");
    expect(validators).toContain('value !== "chatgptPlanRegistration"');
    expect(validators).toContain("chatgpt_plan_main_owned");
  });
});
