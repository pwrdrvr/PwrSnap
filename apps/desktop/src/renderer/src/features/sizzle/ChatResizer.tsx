// Drag handle on the chat pane's left edge, plus the session-scoped
// chat width it edits and the cap that keeps it off the editor.

import { useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { flushSync } from "react-dom";

/** Agent-chat pane width. Dragged via ChatResizer; module-scoped so it
 *  survives remounts within a session and resets on launch. */
export const CHAT_WIDTH_DEFAULT = 400;
export const CHAT_WIDTH_MIN = 320;
export const CHAT_WIDTH_MAX = 720;
let savedChatWidth = CHAT_WIDTH_DEFAULT;

/** The editor column keeps at least this much beside the rail. It is what
 *  the default rail leaves on the minimum window (880 − 400), which is the
 *  width the editor's short-window layout was measured against. Without the
 *  cap, a 720px rail on that window left the editor 160px. */
export const EDITOR_MIN_WIDTH = 480;

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
 * The widest the rail may paint in a workspace `available` px wide: whatever
 * leaves the editor EDITOR_MIN_WIDTH, within the resizer's own 320–720.
 * When the workspace cannot fit both floors the rail keeps its own and the
 * editor scrolls sideways (the minimum window never gets there; a zoomed-in
 * page can). `null` means not measured yet, so only CHAT_WIDTH_MAX applies.
 */
export function chatWidthCap(available: number | null): number {
  if (available === null) return CHAT_WIDTH_MAX;
  return Math.max(CHAT_WIDTH_MIN, Math.min(CHAT_WIDTH_MAX, available - EDITOR_MIN_WIDTH));
}

/**
 * The width the rail actually paints: the saved preference, capped. The cap
 * is applied here, on every render, and never written back, so shrinking the
 * window does not forget a wide rail and widening it again brings it back.
 */
export function effectiveChatWidth(preferred: number, cap: number): number {
  return Math.max(CHAT_WIDTH_MIN, Math.min(preferred, cap));
}

/**
 * The rail's cap for `workspace` (the row the rail shares with the editor),
 * re-read by a ResizeObserver as the window resizes.
 *
 * - `clientWidth`, not `getBoundingClientRect()`: the flex row hands out its
 *   layout box, and a rect read during a transform is post-transform
 *   (AGENTS.md, "Never mix a post-transform rect with a layout measure").
 *   Zero means no layout (hidden, or jsdom) and caps nothing.
 * - The observer commits with `flushSync`. Its callback runs after layout
 *   and before paint, but a plain setState from it renders in a later task,
 *   so the frame paints the rail at its old width first. Measured in Chrome,
 *   narrowing 1400 → 880 with a 720px rail painted one frame of a 160px
 *   editor. The initial read needs no flush: it is in a layout effect.
 * - It stores the cap, not the width, so a resize outside the band where the
 *   cap moves (800–1200px) re-renders nothing.
 */
export function useChatWidthCap(workspace: HTMLElement | null): number {
  const [cap, setCap] = useState(CHAT_WIDTH_MAX);
  useLayoutEffect(() => {
    if (workspace === null) return;
    const read = (): number => {
      const width = workspace.clientWidth;
      return chatWidthCap(width > 0 ? width : null);
    };
    setCap(read());
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const next = read();
      flushSync(() => setCap(next));
    });
    ro.observe(workspace);
    return () => ro.disconnect();
  }, [workspace]);
  return workspace === null ? CHAT_WIDTH_MAX : cap;
}

/**
 * Drag handle on the chat pane's left edge. Pointer-captured so a fast
 * drag doesn't lose the handle; the pane is `flex-basis`-sized so the
 * editor takes the remainder. Double-click resets to the default.
 *
 * `width` is the width the rail PAINTS (already capped) and `max` is the
 * cap, so a drag starts where the handle is drawn and stops where the
 * editor's floor is. A drag writes the width it shows.
 */
export function ChatResizer({
  width,
  max,
  onResize
}: {
  width: number;
  max: number;
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
      aria-valuemax={max}
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
          Math.min(max, Math.max(CHAT_WIDTH_MIN, drag.current.startWidth + dx))
        );
        // A move that leaves the rail where it is writes nothing. Pushing
        // against the cap must not replace a wider saved width, one that
        // a bigger window would still honor, with the capped one.
        if (next === width) return;
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
