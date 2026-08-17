// PwrSnap owns the ACP approval policy (the kit forwards every permission
// request). Pre-approve OUR configured MCP tools across agent naming
// conventions (Gemini/Qwen/Kimi/Grok differ), deny the agent's own tools.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makePooledAcpApprovalHandler,
  permissionTargetsConfiguredMcpServer
} from "../acp-approval-policy";
import {
  __clearEnrichmentThreadsForTests,
  markEnrichmentThread,
  unmarkEnrichmentThread
} from "../enrichment-sandbox";

const SERVERS = ["pwrsnap"];

function perm(toolCall: Record<string, unknown>): Record<string, unknown> {
  return { mcpServerNames: SERVERS, toolCall, threadId: "acp:kimi:t1" };
}

describe("permissionTargetsConfiguredMcpServer", () => {
  it("matches a PwrSnap MCP tool across agent naming conventions", () => {
    const cases: Record<string, unknown>[] = [
      // Gemini / Qwen
      { toolCallId: "mcp_pwrsnap_read_ocr_text__1", title: "read_ocr_text (pwrsnap MCP Server)" },
      // standard MCP double-underscore (Kimi / Claude-style)
      { toolCallId: "mcp__pwrsnap__draw_rect", title: "draw_rect" },
      // raw namespaced tool name as the id
      { toolCallId: "pwrsnap_library_draw_rect-7", title: "Draw rectangle" },
      // opaque id, namespaced name only in a `name` field
      { toolCallId: "call_abc", name: "pwrsnap_library_redact", title: "Redact a region" },
      // opaque id, namespaced name mid-title
      { toolCallId: "tc-42", title: "Calling pwrsnap_library_render_composite" }
    ];
    for (const tc of cases) {
      expect(permissionTargetsConfiguredMcpServer(perm(tc)), JSON.stringify(tc)).toBe(true);
    }
  });

  it("matches a Qwen-style call that hides the tool name (opaque id, args in title)", () => {
    // Qwen Code sends an opaque OpenAI-style id and puts the ARGS in the title —
    // no tool name or server name anywhere. The PwrSnap-distinctive `capture_id`
    // argument is the signal.
    expect(
      permissionTargetsConfiguredMcpServer(
        perm({ toolCallId: "call_a8109b06e9214d", title: '{"capture_id":"r6qkPwFrDYNErdqF"}' })
      )
    ).toBe(true);
    // Same shape but args carried in an explicit rawInput object.
    expect(
      permissionTargetsConfiguredMcpServer(
        perm({ toolCallId: "call_x", title: "Edit", rawInput: { capture_id: "r6qk", x: 0.1 } })
      )
    ).toBe(true);
  });

  it("matches the tool name in the nested content block (Qwen's real shape)", () => {
    // Exact shape from a Qwen permission request: opaque id, and the name lives
    // in content[].content.text — even a library-wide tool with no capture_id
    // is recognized, closing that gap.
    const toolCall = {
      toolCallId: "0:tool_dqy9zthnErOheuYwRB1y7IsW",
      content: [
        {
          type: "content",
          content: { type: "text", text: "Requesting approval to Call mcp__pwrsnap__library_list" }
        }
      ]
    };
    expect(permissionTargetsConfiguredMcpServer(perm(toolCall))).toBe(true);
  });

  it("matches even with no configured server names, via the arg signature", () => {
    // A pooled session whose mcpServerNames didn't propagate still recognizes
    // its own tool by the capture_id argument.
    expect(
      permissionTargetsConfiguredMcpServer({
        mcpServerNames: [],
        toolCall: { toolCallId: "call_x", title: '{"capture_id":"r6qk"}' }
      })
    ).toBe(true);
  });

  it("does NOT match the agent's own built-in tools", () => {
    for (const tc of [
      { toolCallId: "shell_1", title: "Run shell command", kind: "execute" },
      { toolCallId: "read_file_3", title: "Read file", kind: "read" },
      { toolCallId: "web_search_2", title: "Search the web" },
      // Same nested-content shape as Qwen's MCP calls, but a BUILT-IN tool —
      // no pwrsnap reference, no distinctive arg, so still denied.
      {
        toolCallId: "0:tool_z",
        content: [
          { type: "content", content: { type: "text", text: "Requesting approval to Call run_shell_command" } }
        ]
      }
    ]) {
      expect(permissionTargetsConfiguredMcpServer(perm(tc)), JSON.stringify(tc)).toBe(false);
    }
  });

  it("does not match a short server name mid-word (left boundary required)", () => {
    const params = { mcpServerNames: ["fs"], toolCall: { toolCallId: "refresh_cache", title: "refresh" } };
    expect(permissionTargetsConfiguredMcpServer(params)).toBe(false);
  });

  it("returns false when no server names are configured", () => {
    expect(
      permissionTargetsConfiguredMcpServer({ mcpServerNames: [], toolCall: { toolCallId: "mcp_pwrsnap_x" } })
    ).toBe(false);
  });
});

describe("makePooledAcpApprovalHandler", () => {
  const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    __clearEnrichmentThreadsForTests();
  });

  it("approves a configured MCP tool and denies the agent's own tools", async () => {
    const handler = makePooledAcpApprovalHandler(logger);
    await expect(
      handler("session/request_permission", perm({ toolCallId: "mcp__pwrsnap__draw_rect" }))
    ).resolves.toBe("approved");
    await expect(
      handler("session/request_permission", perm({ toolCallId: "shell_1", title: "Run shell" }))
    ).resolves.toBe("denied");
  });

  // A denial on a CHAT session is routine policy — warn, and the args are the
  // user's own text so logging them is fine.
  it("logs a chat-session denial at warn", async () => {
    const handler = makePooledAcpApprovalHandler(logger);
    await expect(
      handler("session/request_permission", {
        ...perm({ toolCallId: "shell_1", title: "Run shell" }),
        threadId: "chat-session-1"
      })
    ).resolves.toBe("denied");
    expect(logger.warn).toHaveBeenCalledWith("acp permission denied", expect.anything());
    expect(logger.error).not.toHaveBeenCalled();
  });

  // The same denial on an ENRICHMENT session is a security event: error level,
  // attributed to the capture, with the arguments redacted.
  it("escalates an enrichment-session denial to error with run + capture id", async () => {
    markEnrichmentThread("enrich-session-1", { runId: "run-9", captureId: "cap-9" });
    const handler = makePooledAcpApprovalHandler(logger);

    await expect(
      handler("session/request_permission", {
        ...perm({
          toolCallId: "shell_1",
          title: "Run shell",
          rawInput: { command: "cat ~/.aws/credentials" }
        }),
        threadId: "enrich-session-1"
      })
    ).resolves.toBe("denied");

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "capture enrichment sandbox escalation denied",
      expect.objectContaining({
        backend: "acp",
        kind: "approval",
        method: "session/request_permission",
        threadId: "enrich-session-1",
        runId: "run-9",
        captureId: "cap-9"
      })
    );
    // The screenshot-derived arguments must never reach the log.
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("credentials");
  });

  it("stops treating a session as enrichment once the run releases it", async () => {
    markEnrichmentThread("enrich-session-2", { runId: "run-1", captureId: "cap-1" });
    unmarkEnrichmentThread("enrich-session-2");
    const handler = makePooledAcpApprovalHandler(logger);

    await handler("session/request_permission", {
      ...perm({ toolCallId: "shell_1", title: "Run shell" }),
      threadId: "enrich-session-2"
    });

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});
