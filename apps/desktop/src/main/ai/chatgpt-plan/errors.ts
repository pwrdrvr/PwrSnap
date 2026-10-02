export const PLAN_USAGE_URL = "https://chatgpt.com/settings/usage";
const messages: Record<string, string> = {
  subscription_sharing_usage_limit_exceeded: "ChatGPT plan usage limit reached. Manage usage in ChatGPT settings.",
  subscription_sharing_user_not_eligible: "ChatGPT plan usage is unavailable for this account. Choose another billing provider in AI Providers.",
  subscription_sharing_usage_unavailable: "ChatGPT plan usage is temporarily unavailable. Retry later.",
  subscription_sharing_user_unavailable: "ChatGPT account is temporarily unavailable. Retry later.",
  subscription_sharing_invalid_user: "Reconnect ChatGPT in AI Providers.",
  chatpass_v2_scope_not_authorized: "ChatGPT plan permission is missing. Reconnect in AI Providers.",
  chatpass_v2_invalid_authorization_context: "Reconnect ChatGPT in AI Providers.",
  subscription_sharing_route_not_supported: "This operation is unavailable with ChatGPT plan usage.",
  subscription_sharing_unsupported_capability: "This operation uses a capability unavailable with ChatGPT plan usage."
};
export function planErrorMessage(message: string, code?: string): string {
  const key = Object.keys(messages).find(key => key === code || message.includes(key));
  return key ? `${key}: ${messages[key]}` : message;
}

export function requiresPlanSignIn(message: string, code?: string): boolean {
  return ["subscription_sharing_invalid_user", "chatpass_v2_scope_not_authorized", "chatpass_v2_invalid_authorization_context"]
    .some(key => code === key || message.includes(key));
}
