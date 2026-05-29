import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineTool, toDynamicToolSpec, type ToolSpec } from "../define-tool";
import {
  LIBRARY_TOOL_ALLOWLIST
} from "../library-tool-allowlist";
import {
  buildLibraryToolCatalog,
  dispatchLibraryToolCall
} from "../library-tool-catalog";
import type { DynamicToolCallParams } from "@pwrsnap/codex-app-server-protocol/v2";

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
  it("ships empty in Phase 0 so the catalog starts empty", () => {
    expect(LIBRARY_TOOL_ALLOWLIST).toEqual([]);
    expect(buildLibraryToolCatalog()).toEqual([]);
  });
});

describe("toDynamicToolSpec", () => {
  it("derives namespace, name, description, and a JSON Schema inputSchema", () => {
    const tool = makeFixtureTool(async (args) => ({ ok: true, data: args }));
    const spec = toDynamicToolSpec(tool);

    expect(spec.namespace).toBe("pwrsnap_library");
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
    expect(catalog[0]?.name).toBe("fixture_echo");
  });
});

describe("dispatchLibraryToolCall", () => {
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

  it("accepts a null namespace from the wire", async () => {
    const tool = makeFixtureTool(async (args) => ({ ok: true, data: args }));

    const response = await dispatchLibraryToolCall(
      makeCallParams({ namespace: null, arguments: { id: "ok" } }),
      [tool]
    );

    expect(response.success).toBe(true);
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
