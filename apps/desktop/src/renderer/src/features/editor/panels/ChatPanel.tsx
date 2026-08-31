// The standalone Editor needs a per-bundle thread, Editor-only tools, and a
// capture-bound lifecycle. LibraryChatPanel deliberately has broader scope and
// Finder-backed persistence, so mounting it here would misrepresent that
// boundary. Keep this surface truthfully unavailable until the dedicated
// Editor controller lands; the embedded Library editor continues to use the
// real Library chat in DetailRail.

import type { ReactElement } from "react";
import "../../shared/chat/chat-panel.css";

export interface ChatPanelProps {
  captureId: string;
}

export function ChatPanel({ captureId }: ChatPanelProps): ReactElement {
  return (
    <div
      className="ps-libchat ps-libchat--empty"
      data-testid="chat-panel"
      data-capture-id={captureId}
    >
      <div className="ps-libchat-empty-title">Editor chat is unavailable</div>
      <p className="ps-libchat-empty-body">
        Per-capture Editor chat is not available in this standalone editor yet.
      </p>
      <p className="ps-libchat-empty-body">
        Library chat has broader access to your captures and remains available
        from the Library’s Chat tab. This panel stays disabled until its
        bundle-backed Editor conversation is ready.
      </p>
    </div>
  );
}
