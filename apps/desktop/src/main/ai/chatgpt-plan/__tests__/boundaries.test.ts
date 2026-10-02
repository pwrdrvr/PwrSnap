import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { CHATGPT_PLAN_CONFIG, CHATGPT_PLAN_PROVIDER, chatgptPlanArgs } from "../codex-config";
import { planErrorMessage, requiresPlanSignIn } from "../errors";

describe("SIWC inference boundary", () => {
  test("uses documented Responses provider and disables websockets and remote search", () => {
    expect(CHATGPT_PLAN_CONFIG.model_providers[CHATGPT_PLAN_PROVIDER]).toEqual({ name: "ChatGPT plan", base_url: "https://api.openai.com/v1", env_key: "ACCESS_TOKEN", wire_api: "responses", requires_openai_auth: false, supports_websockets: false });
    expect(chatgptPlanArgs()).toContain('model_provider="openai_chatgpt_plan"');
    expect(CHATGPT_PLAN_CONFIG.web_search).toBe("disabled");
    expect(CHATGPT_PLAN_CONFIG.features.code_mode).toBe(false);
  });
  test("delegates Responses body to app-server without a direct completion endpoint or unsupported additions", () => {
    const session = readFileSync(new URL("../session.ts", import.meta.url), "utf8");
    expect(session).toContain('fetcher("https://api.openai.com/v1/models"');
    expect(session).not.toContain('/v1/responses');
    for (const field of ["previous_response_id", "background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "multi_agent", "prompt", "prompt_cache_retention", "safety_identifier", "temperature", "top_p", "truncation", "user"])
      expect(CHATGPT_PLAN_CONFIG).not.toHaveProperty(field);
    const pool = readFileSync(new URL("../../codex-agent-pool.ts", import.meta.url), "utf8");
    expect(pool).toContain('event.status !== "completed"');
    expect(pool).toContain('...imagePathsToLocalImageInputs');
    expect(pool).toContain('...codexEnrichmentThreadSandbox');
  });
  test("MCP adds no SIWC or general completion tools, and credentials remain write-protected", () => {
    const registry = readFileSync(new URL("../../../local-agents/mcp-tool-registry.ts", import.meta.url), "utf8");
    expect(registry).not.toContain("chatgptPlan:");
    expect(registry).not.toContain("/v1/responses");
    const validators = readFileSync(new URL("../../../handlers/settings-validators.ts", import.meta.url), "utf8");
    expect(validators).toContain('value !== "chatgptPlanRegistration"');
  });
  test("limit errors identify Manage usage without an invented reset time; eligibility errors do not retry", () => {
    expect(planErrorMessage("fixture", "subscription_sharing_usage_limit_exceeded")).toContain("Manage usage");
    expect(planErrorMessage("subscription_sharing_user_not_eligible")).toContain("Choose another billing provider");
    expect(planErrorMessage("subscription_sharing_usage_unavailable")).toContain("Retry later");
    expect(requiresPlanSignIn("fixture", "subscription_sharing_invalid_user")).toBe(true);
    expect(requiresPlanSignIn("subscription_sharing_usage_unavailable")).toBe(false);
  });
});
