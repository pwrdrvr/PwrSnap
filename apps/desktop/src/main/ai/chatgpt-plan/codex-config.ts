export const CHATGPT_PLAN_PROVIDER = "openai_chatgpt_plan";
/** Published app-server SIWC configuration; no legacy ChatGPT backend endpoint. */
export const CHATGPT_PLAN_CONFIG = {
  model_provider: CHATGPT_PLAN_PROVIDER,
  model_providers: { [CHATGPT_PLAN_PROVIDER]: {
    name: "ChatGPT plan", base_url: "https://api.openai.com/v1", env_key: "ACCESS_TOKEN",
    wire_api: "responses", requires_openai_auth: false, supports_websockets: false
  } },
  web_search: "disabled",
  features: { code_mode: false }
};
export function chatgptPlanArgs(): string[] {
  const provider = CHATGPT_PLAN_CONFIG.model_providers.openai_chatgpt_plan;
  return ["app-server", "-c", `model_provider=${JSON.stringify(CHATGPT_PLAN_PROVIDER)}`,
    ...Object.entries(provider).flatMap(([key, value]) => ["-c", `model_providers.${CHATGPT_PLAN_PROVIDER}.${key}=${JSON.stringify(value)}`]),
    "-c", 'web_search="disabled"', "-c", "features.code_mode=false"];
}
