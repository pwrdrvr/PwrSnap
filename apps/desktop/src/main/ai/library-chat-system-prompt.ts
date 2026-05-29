// Assembles the Library chat system prompt:
//   • L1 — base instructions (library-chat-base.md, version-controlled)
//   • L2 — the user's Settings.ai.chat (User Guidance + sensitive-data
//          patterns), injected verbatim
//
// L3 (per-turn active-capture context) is NOT part of the system prompt:
// it changes as the user navigates between captures within a thread, so
// the controller injects a `<current_capture id="...">` block into each
// TURN instead (see chat-thread-controller.ts buildCurrentCaptureContext
// + library-chat-base.md §"The capture you're looking at"). The system
// prompt below is the stable L1 + L2 set once as baseInstructions at
// thread/start. See plan §"System prompt design".

import { readFileSync } from "node:fs";
import type { Settings } from "@pwrsnap/shared";

const LIBRARY_CHAT_BASE_PROMPT_FILE = new URL(
  "./prompts/library-chat-base.md",
  import.meta.url
);

/** L1 base instructions — loaded once at module init. */
export const LIBRARY_CHAT_BASE_INSTRUCTIONS = readFileSync(
  LIBRARY_CHAT_BASE_PROMPT_FILE,
  "utf8"
).trimEnd();

/**
 * Build the full system prompt for a chat thread: L1 base + L2 user
 * guidance + patterns. `anchorCaptureId` is accepted for forward-compat
 * (richer thread-creation framing later) but the system prompt does NOT
 * encode the active capture — that's per-turn and lives in the turn
 * context the controller injects (see module header).
 */
export function buildLibrarySystemPrompt(input: {
  settings: Settings;
  anchorCaptureId: string | null;
}): string {
  const { settings } = input;
  const chat = settings.ai.chat;
  const parts: string[] = [LIBRARY_CHAT_BASE_INSTRUCTIONS];

  const guidance = chat.userGuidance.trim();
  const patterns = chat.sensitiveDataPatterns;

  if (guidance.length > 0 || patterns.length > 0) {
    const l2: string[] = ["\n## User guidance (from Settings)\n"];
    l2.push(
      guidance.length > 0
        ? guidance
        : "(no free-form guidance set — the user hasn't added any yet)"
    );
    if (patterns.length > 0) {
      l2.push("\n### Sensitive-data patterns the user taught you\n");
      l2.push(
        `Default redaction style: **${chat.defaultRedactionStyle}**. ` +
          "Use these names when redacting matching content:"
      );
      for (const p of patterns) {
        l2.push(`- **${p.name}** — regex \`${p.pattern}\``);
      }
    }
    parts.push(l2.join("\n"));
  }

  return parts.join("\n");
}
