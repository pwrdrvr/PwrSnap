import { type ReactElement } from "react";
import { ChatPanelSurface } from "../../shared/chat/ChatPanelSurface";

export interface LibraryChatPanelProps {
  /** The capture the user is currently viewing, passed as the thread
   *  anchor on send. Null when viewing the Library grid. */
  readonly anchorCaptureId?: string | null;
  /** Surface-specific root test id. */
  readonly testId?: string;
}

export function LibraryChatPanel({
  anchorCaptureId = null,
  testId = "library-chat-panel"
}: LibraryChatPanelProps): ReactElement {
  return (
    <ChatPanelSurface
      surface="library"
      scopeId={anchorCaptureId}
      testId={testId}
    />
  );
}
