import type { ReactElement } from "react";
import { dispatch } from "../../../lib/pwrsnap";
export function isChatgptUsageLimit(message: string): boolean {
  return message.includes("subscription_sharing_usage_limit_exceeded");
}
export function ChatgptUsageAction(): ReactElement {
  return <button type="button" className="pss__key-btn is-primary" onClick={() => {
    void dispatch("app:openExternal", { url: "https://chatgpt.com/settings/usage" });
  }}>Manage usage</button>;
}
