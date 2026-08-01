import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { toDynamicToolFunctionSpec } from "@pwrdrvr/agent-client";
import { defineTool, type ToolSpec } from "../define-tool";
import {
  LIBRARY_TOOL_ALLOWLIST
} from "../library-tool-allowlist";
import {
  buildLibraryToolCatalog,
  dispatchLibraryToolCall
} from "../library-tool-catalog";
import type { DynamicToolCallParams } from "@pwrdrvr/codex-app-server-protocol/v2";
import { currentChatToolCommandContext } from "../chat-tool-command-context";

function makeCallParams(
  overrides: Partial<DynamicToolCallParams>
): DynamicToolCallParams {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-1",
    namespace: "pwrsnap_library",
    tool: "fixture_echo",
    arguments: {},
    ...overrides
  };
}

/** Locally-defined fixture tool — the real allowlist is empty (Phase 1). */
function makeFixtureTool(
  dispatch: ToolSpec<{ id: string }>["dispatch"]
): ToolSpec<unknown> {
  return defineTool({
    namespace: "pwrsnap_library",
    name: "fixture_echo",
    description: "Echo the given id back. Test fixture only.",
    argsSchema: z.object({ id: z.string().min(1) }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    dispatch
  }) as ToolSpec<unknown>;
}

describe("library tool allowlist", () => {
  it("ships the Phase 1 read + edit + redaction tools", () => {
    const names = LIBRARY_TOOL_ALLOWLIST.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "library_list",
        "library_search",
        "capture_metadata",
        "read_ocr_text",
        "list_layers",
        "editing_capabilities",
        "render_composite",
        "open_in_library",
        "open_editor",
        "draw_arrow",
        "draw_text",
        "draw_highlight",
        "draw_rect",
        "draw_square",
        "draw_circle",
        "draw_oval",
        "draw_parallelogram",
        "redact",
        "blur",
        "crop",
        "update_layer",
        "delete_layer",
        "reorder_layer",
        "reorder_layers",
        "add_tag",
        "remove_tag"
      ])
    );
  });

  it("every entry builds a valid DynamicToolSpec (exercises z.toJSONSchema on the real arg schemas incl. the Overlay union)", () => {
    const catalog = buildLibraryToolCatalog();
    expect(catalog).toHaveLength(1);
    const namespace = catalog[0];
    expect(namespace?.type).toBe("namespace");
    if (namespace?.type !== "namespace") {
      throw new Error("expected the library catalog to contain one namespace");
    }
    expect(namespace.name).toBe("pwrsnap_library");
    expect(namespace.tools).toHaveLength(LIBRARY_TOOL_ALLOWLIST.length);
    for (const spec of namespace.tools) {
      expect(spec.type).toBe("function");
      expect(typeof spec.name).toBe("string");
      expect(spec.description.length).toBeGreaterThan(0);
      // inputSchema must be a non-null JSON-Schema object — this is the
      // line that throws if z.toJSONSchema can't serialize a tool's
      // argsSchema (e.g. the draw_* tools' flat shape schemas).
      expect(spec.inputSchema).toBeTruthy();
      expect(typeof spec.inputSchema).toBe("object");
    }
  });

  it("namespaces every tool under pwrsnap_library", () => {
    for (const tool of LIBRARY_TOOL_ALLOWLIST) {
      expect(tool.namespace).toBe("pwrsnap_library");
    }
  });
});

describe("toDynamicToolFunctionSpec", () => {
  it("derives the nested function wire shape and a JSON Schema inputSchema", () => {
    const tool = makeFixtureTool(async (args) => ({ ok: true, data: args }));
    const spec = toDynamicToolFunctionSpec(tool);

    expect(spec.type).toBe("function");
    expect(spec.name).toBe("fixture_echo");
    expect(spec.description).toContain("Echo the given id");
    expect(spec.inputSchema).toMatchObject({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"]
    });
  });
});

describe("buildLibraryToolCatalog", () => {
  it("projects a fixture allowlist to DynamicToolSpec entries", () => {
    const tool = makeFixtureTool(async (args) => ({ ok: true, data: args }));
    const catalog = buildLibraryToolCatalog([tool]);

    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({
      type: "namespace",
      name: "pwrsnap_library",
      tools: [
        {
          type: "function",
          name: "fixture_echo"
        }
      ]
    });
  });
});

describe("dispatchLibraryToolCall", () => {
  it("retains the originating authenticated local-agent context", async () => {
    const dispatch = vi.fn(async () => ({
      ok: true as const,
      data: currentChatToolCommandContext()
    }));
    const tool = makeFixtureTool(dispatch);
    const commandContext = {
      principal: "mcp" as const,
      localAgent: {
        clientId: "lag_one",
        capabilities: ["capture.edit"] as const
      }
    };

    const response = await dispatchLibraryToolCall(
      makeCallParams({ arguments: { id: "cap-42" } }),
      [tool],
      commandContext
    );

    expect(response.success).toBe(true);
    expect(response.contentItems).toEqual([{
      type: "inputText",
      text: JSON.stringify(commandContext)
    }]);
  });

  it("validates args + runs dispatch + wraps data on success", async () => {
    const dispatch = vi.fn(async (args: { id: string }) => ({
      ok: true as const,
      data: { echoed: args.id }
    }));
    const tool = makeFixtureTool(dispatch);

    const response = await dispatchLibraryToolCall(
      makeCallParams({ arguments: { id: "cap-42" } }),
      [tool]
    );

    expect(dispatch).toHaveBeenCalledWith({ id: "cap-42" }, { threadId: "thread-1" });
    expect(response.success).toBe(true);
    expect(response.contentItems).toEqual([
      { type: "inputText", text: JSON.stringify({ echoed: "cap-42" }) }
    ]);
  });

  it("returns success:false (no throw) when arguments fail validation", async () => {
    const dispatch = vi.fn(async (args: { id: string }) => ({
      ok: true as const,
      data: args
    }));
    const tool = makeFixtureTool(dispatch);

    const response = await dispatchLibraryToolCall(
      makeCallParams({ arguments: { id: "" } }),
      [tool]
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(response.success).toBe(false);
    expect(response.contentItems[0]?.type).toBe("inputText");
    if (response.contentItems[0]?.type === "inputText") {
      expect(response.contentItems[0].text).toContain("Invalid arguments");
    }
  });

  it("returns success:false for an unknown tool, never throwing", async () => {
    const tool = makeFixtureTool(async (args) => ({ ok: true, data: args }));

    const response = await dispatchLibraryToolCall(
      makeCallParams({ tool: "does_not_exist" }),
      [tool]
    );

    expect(response.success).toBe(false);
    if (response.contentItems[0]?.type === "inputText") {
      expect(response.contentItems[0].text).toContain("Unknown tool");
    }
  });

  it("returns success:false on an explicit namespace mismatch", async () => {
    const tool = makeFixtureTool(async (args) => ({ ok: true, data: args }));

    const response = await dispatchLibraryToolCall(
      makeCallParams({ namespace: "some_other_ns", arguments: { id: "x" } }),
      [tool]
    );

    expect(response.success).toBe(false);
  });

  it("rejects a null namespace for a namespaced tool", async () => {
    const tool = makeFixtureTool(async (args) => ({ ok: true, data: args }));

    const response = await dispatchLibraryToolCall(
      makeCallParams({ namespace: null, arguments: { id: "ok" } }),
      [tool]
    );

    expect(response.success).toBe(false);
    if (response.contentItems[0]?.type === "inputText") {
      expect(response.contentItems[0].text).toContain("not a top-level tool");
    }
  });

  it("maps a dispatch error result to success:false", async () => {
    const tool = makeFixtureTool(async () => ({
      ok: false,
      error: "capture not found"
    }));

    const response = await dispatchLibraryToolCall(
      makeCallParams({ arguments: { id: "missing" } }),
      [tool]
    );

    expect(response.success).toBe(false);
    if (response.contentItems[0]?.type === "inputText") {
      expect(response.contentItems[0].text).toBe("capture not found");
    }
  });

  it("catches a thrown dispatch and reports success:false", async () => {
    const tool = makeFixtureTool(async () => {
      throw new Error("boom");
    });

    const response = await dispatchLibraryToolCall(
      makeCallParams({ arguments: { id: "x" } }),
      [tool]
    );

    expect(response.success).toBe(false);
    if (response.contentItems[0]?.type === "inputText") {
      expect(response.contentItems[0].text).toContain("boom");
    }
  });
});
