// Drag handle on the chat pane's left edge, plus the session-scoped
// chat width it edits.

import { useRef, type ReactElement } from "react";

/** Agent-chat pane width. Dragged via ChatResizer; module-scoped so it
 *  survives remounts within a session and resets on launch. */
export const CHAT_WIDTH_DEFAULT = 400;
export const CHAT_WIDTH_MIN = 320;
export const CHAT_WIDTH_MAX = 720;
let savedChatWidth = CHAT_WIDTH_DEFAULT;

export function getSavedChatWidth(): number {
  return savedChatWidth;
}

export function setSavedChatWidth(width: number): void {
  savedChatWidth = width;
}

/** Test-only: reset the session-scoped chat width between cases. */
export function resetSizzleChatWidthForTests(): void {
  savedChatWidth = CHAT_WIDTH_DEFAULT;
}

/**
 * Drag handle on the chat pane's left edge. Pointer-captured so a fast
 * drag doesn't lose the handle; the pane is `flex-basis`-sized so the
 * editor takes the remainder. Double-click resets to the default.
 */
export function ChatResizer({
  width,
  onResize
}: {
  width: number;
  onResize: (next: number) => void;
}): ReactElement {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  return (
    <div
      className="szl__chat-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize chat (drag · double-click to reset)"
      aria-valuenow={width}
      aria-valuemin={CHAT_WIDTH_MIN}
      aria-valuemax={CHAT_WIDTH_MAX}
      title="Drag to resize · double-click to reset"
      data-testid="sizzle-chat-resizer"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        (event.target as HTMLElement).setPointerCapture(event.pointerId);
        drag.current = { startX: event.clientX, startWidth: width };
      }}
      onPointerMove={(event) => {
        if (drag.current === null) return;
        // A cancelled or lost pointer capture never fires pointerup, which
        // would otherwise leave the divider stuck in drag mode and resize
        // the pane on a plain hover. No buttons held => the drag is over.
        if (event.buttons === 0) {
          drag.current = null;
          return;
        }
        // The pane sits on the right, so dragging LEFT widens it.
        const dx = drag.current.startX - event.clientX;
        const next = Math.round(
          Math.min(CHAT_WIDTH_MAX, Math.max(CHAT_WIDTH_MIN, drag.current.startWidth + dx))
        );
        onResize(next);
      }}
      onPointerUp={(event) => {
        if (drag.current === null) return;
        (event.target as HTMLElement).releasePointerCapture(event.pointerId);
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
      onDoubleClick={() => onResize(CHAT_WIDTH_DEFAULT)}
    />
  );
}
