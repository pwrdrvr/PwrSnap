import { CHATGPT_USAGE_LIMIT_MESSAGE, type Settings } from "@pwrsnap/shared";

// The documented SIWC protocol codes (errors-and-recovery), as the text a
// user reads. The code itself never reaches the UI: the renderer recognizes a
// usage limit by CHATGPT_USAGE_LIMIT_MESSAGE, which main and renderer share.
export const CHATGPT_USAGE_LIMIT_CODE = "subscription_sharing_usage_limit_exceeded";

const SIGN_IN_AGAIN = "Sign in to ChatGPT again in Settings → AI Providers → ChatGPT.";
const MESSAGES: Readonly<Record<string, string>> = {
  subscription_sharing_usage_limit_exceeded: CHATGPT_USAGE_LIMIT_MESSAGE,
  subscription_sharing_user_not_eligible:
    "ChatGPT plan usage isn't available for this account. Pick another provider for this job in Settings → AI Features.",
  subscription_sharing_usage_unavailable: "ChatGPT couldn't check plan usage just now. Try again in a moment.",
  subscription_sharing_user_unavailable: "Your ChatGPT account is unavailable just now. Try again in a moment.",
  subscription_sharing_invalid_user: SIGN_IN_AGAIN,
  chatpass_v2_scope_not_authorized:
    "PwrSnap doesn't have permission to use your ChatGPT plan. Continue with ChatGPT in Settings → AI Providers → ChatGPT to grant it.",
  chatpass_v2_invalid_authorization_context: SIGN_IN_AGAIN,
  subscription_sharing_route_not_supported: "ChatGPT plan usage doesn't support this request.",
  subscription_sharing_unsupported_capability:
    "This request uses a model or input that ChatGPT plan usage doesn't support. Try another model."
};

/** The user-facing text for a documented SIWC code, or undefined. */
export function planErrorMessage(code: string | undefined): string | undefined {
  return code !== undefined && Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : undefined;
}

/** Codes after which the stored session cannot work until the user signs in again. */
export function requiresPlanSignIn(code: string | undefined): boolean {
  return code === "subscription_sharing_invalid_user" || code === "chatpass_v2_scope_not_authorized" ||
    code === "chatpass_v2_invalid_authorization_context";
}

/** Shared by enqueue and the final check immediately before automatic inference. */
export function automaticPlanBlock(settings: Settings): { code: string; message: string } | null {
  if (settings.ai.chatgptPlan?.backgroundConsent !== true) {
    return { code: "chatgpt_background_consent_required",
      message: "Allow automatic use for new captures in Settings → AI Providers → ChatGPT first." };
  }
  if (settings.ai.chatgptPlan.usagePaused === true) {
    return { code: "chatgpt_automatic_usage_paused", message: CHATGPT_USAGE_LIMIT_MESSAGE };
  }
  return null;
}
