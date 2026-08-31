import { type ReactElement } from "react";
import { ChatPanelSurface } from "../shared/chat/ChatPanelSurface";

export interface SizzleChatPanelProps {
  /** The Sizzle project this chat composes — passed as the thread anchor
   *  so the agent's tools are scoped to it. */
  readonly projectId: string;
}

export function SizzleChatPanel({ projectId }: SizzleChatPanelProps): ReactElement {
  return (
    <ChatPanelSurface
      surface="sizzle"
      scopeId={projectId}
      testId="sizzle-chat-panel"
    />
  );
}
