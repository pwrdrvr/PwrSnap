// Ownership table for the two-process split (§D4). These tests pin
// the routing decisions that are easy to get subtly wrong: the chat
// surfaces ride a codex: prefix but live in the library; settings:open
// is a window verb owned by the library while the rest of settings:*
// is the agent-side substrate.

import { describe, expect, test } from "vitest";
import { commandOwner, peerOwnsCommand } from "../process-split/command-routing";

describe("commandOwner", () => {
  test("capture surface belongs to the agent", () => {
    expect(commandOwner("capture:interactive")).toBe("agent");
    expect(commandOwner("recording:start")).toBe("agent");
    expect(commandOwner("float-over:dismiss")).toBe("agent");
    expect(commandOwner("clipboard:copy")).toBe("agent");
    expect(commandOwner("permissions:request")).toBe("agent");
    expect(commandOwner("app:update:check")).toBe("agent");
    // video:* registers in recording-handlers next to the recorder —
    // the library grid's video chips forward to the agent.
    expect(commandOwner("video:prepareDrag")).toBe("agent");
    expect(commandOwner("video:presetMetrics")).toBe("agent");
    expect(peerOwnsCommand("library", "video:export")).toBe(true);
  });

  test("settings substrate is agent-owned except the window verb", () => {
    expect(commandOwner("settings:read")).toBe("agent");
    expect(commandOwner("settings:write")).toBe("agent");
    expect(commandOwner("settings:replaceSecret")).toBe("agent");
    expect(commandOwner("settings:open")).toBe("library");
  });

  test("chat surfaces route to the library despite the codex: prefix", () => {
    expect(commandOwner("codex:enrich")).toBe("agent");
    expect(commandOwner("codex:libraryChat:send")).toBe("library");
    expect(commandOwner("codex:sizzleChat:create")).toBe("library");
  });

  test("library WINDOW verbs and editor/render surfaces belong to the library", () => {
    expect(commandOwner("library:openInLibrary")).toBe("library");
    expect(commandOwner("library:focus")).toBe("library");
    expect(commandOwner("library:export")).toBe("library");
    expect(commandOwner("editor:open")).toBe("library");
    expect(commandOwner("layers:upsert")).toBe("library");
    expect(commandOwner("render:composite")).toBe("library");
    expect(commandOwner("app:openDocumentWindow")).toBe("library");
    // Exact override beats the clipboard: → agent prefix: copyText is
    // registered with its only callers, the library surfaces.
    expect(commandOwner("clipboard:copyText")).toBe("library");
  });

  test("library DATA verbs have no owner — both processes answer locally", () => {
    // The agent's tray/float-over read + mutate captures; forwarding
    // these would resurrect the library process for a thumbnail.
    expect(commandOwner("library:list")).toBeNull();
    expect(commandOwner("library:byId")).toBeNull();
    expect(commandOwner("library:search")).toBeNull();
    expect(commandOwner("library:delete")).toBeNull();
    expect(commandOwner("library:addTag")).toBeNull();
    expect(peerOwnsCommand("agent", "library:byId")).toBe(false);
    expect(peerOwnsCommand("library", "library:byId")).toBe(false);
  });

  test("register-in-both commands have no owner", () => {
    expect(commandOwner("app:version")).toBeNull();
    expect(commandOwner("system:listDisplays")).toBeNull();
    expect(commandOwner("app:readDocument")).toBeNull();
    expect(commandOwner("app:openExternal")).toBeNull();
    expect(commandOwner("not:aCommand")).toBeNull();
  });
});

describe("peerOwnsCommand", () => {
  test("agent forwards library-owned commands and keeps its own", () => {
    expect(peerOwnsCommand("agent", "library:focus")).toBe(true);
    expect(peerOwnsCommand("agent", "settings:open")).toBe(true);
    expect(peerOwnsCommand("agent", "capture:interactive")).toBe(false);
    expect(peerOwnsCommand("agent", "app:version")).toBe(false);
  });

  test("library forwards agent-owned commands and keeps its own", () => {
    expect(peerOwnsCommand("library", "settings:read")).toBe(true);
    expect(peerOwnsCommand("library", "capture:pasteFromClipboard")).toBe(true);
    expect(peerOwnsCommand("library", "codex:libraryChat:send")).toBe(false);
    expect(peerOwnsCommand("library", "library:list")).toBe(false);
  });

  test("combined never forwards", () => {
    expect(peerOwnsCommand("combined", "settings:read")).toBe(false);
    expect(peerOwnsCommand("combined", "library:list")).toBe(false);
  });
});
