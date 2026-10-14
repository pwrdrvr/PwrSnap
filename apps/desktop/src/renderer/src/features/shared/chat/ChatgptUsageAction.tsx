// Sign in with ChatGPT in chat surfaces: the "Using ChatGPT plan" line OpenAI's
// guidelines ask for near the model selector, and the Manage usage action
// shown beside a usage-limit error. Main turns the protocol code into
// CHATGPT_USAGE_LIMIT_MESSAGE, so that sentence is what is matched here; the
// raw code never reaches the renderer.
import type { ReactElement } from "react";
import { CHATGPT_USAGE_LIMIT_MESSAGE, CHATGPT_USAGE_URL, isChatgptConnection, type Settings } from "@pwrsnap/shared";
import { dispatch } from "../../../lib/pwrsnap";

export function isChatgptUsageLimit(message: string): boolean {
  return message.includes(CHATGPT_USAGE_LIMIT_MESSAGE);
}

function openUsage(): void {
  void dispatch("app:openExternal", { url: CHATGPT_USAGE_URL });
}

export function ChatgptUsageAction(): ReactElement {
  return <button type="button" className="pss__key-btn is-primary" onClick={openUsage}>Manage usage</button>;
}

/** `custom:<modelId>` provider ids whose model runs on the ChatGPT plan. */
export function chatgptPlanProviders(settings: Settings): ReadonlySet<string> {
  const plan = new Set((settings.ai?.customConnections ?? []).filter(isChatgptConnection).map((c) => c.id));
  return new Set((settings.ai?.customModels ?? []).filter((m) => plan.has(m.connectionId)).map((m) => `custom:${m.id}`));
}

export function ChatgptPlanNote(): ReactElement {
  return (
    <div className="ps-libchat-plan" data-testid="chat-chatgpt-plan">
      <span>Using ChatGPT plan</span>
      <button type="button" className="ps-libchat-plan-link" onClick={openUsage}>Manage usage ↗</button>
    </div>
  );
}
