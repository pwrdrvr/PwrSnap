// Editor Chat is the same capture-scoped, persisted conversation surface the
// Library detail rail uses. Keeping this wrapper makes the EditorChrome panel
// contract explicit while ensuring both windows resume the same long-lived
// thread and receive the same App Server / ACP stream.

import type { ReactElement } from "react";
import { LibraryChatPanel } from "../../library/chat/LibraryChatPanel";

export interface ChatPanelProps {
  captureId: string;
}

export function ChatPanel({ captureId }: ChatPanelProps): ReactElement {
  return (
    <LibraryChatPanel
      anchorCaptureId={captureId}
      testId="chat-panel"
    />
  );
}
