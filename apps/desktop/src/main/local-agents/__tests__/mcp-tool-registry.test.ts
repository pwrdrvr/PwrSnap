import type { LocalAgentCapability } from "@pwrsnap/shared";
import { ok } from "@pwrsnap/shared";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { CommandContext } from "../../command-bus";
import {
  createDefaultLocalAgentMcpTools,
  type LocalAgentToolContext,
  toMcpToolResult,
  withMcpResourceLink
} from "../mcp-tool-registry";

function ctx(capabilities: readonly LocalAgentCapability[] = []): LocalAgentToolContext {
  const signal = new AbortController().signal;
  const commandContext: CommandContext = {
    principal: "mcp",
    signal,
    localAgent: {
      clientId: "lag_test",
      capabilities
    }
  };
  return {
    clientId: "lag_test",
    capabilities,
    signal,
    commandContext
  };
}

describe("createDefaultLocalAgentMcpTools", () => {
  test("preserves structured metadata while returning a typed resource link", () => {
    const result = toMcpToolResult(ok(withMcpResourceLink({
      resourceUri: "pwrsnap://capture/cap_1/composite",
      signedUrl: "http://127.0.0.1:51729/media?grant=temporary"
    }, {
      uri: "http://127.0.0.1:51729/media?grant=temporary",
      name: "composite capture",
      mimeType: "image/png",
      size: 123
    })));

    expect(result.structuredContent).toEqual({
      resourceUri: "pwrsnap://capture/cap_1/composite",
      signedUrl: "http://127.0.0.1:51729/media?grant=temporary"
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify(result.structuredContent)
      },
      {
        type: "resource_link",
        uri: "http://127.0.0.1:51729/media?grant=temporary",
        name: "composite capture",
        mimeType: "image/png",
        size: 123,
        annotations: {
          audience: ["user", "assistant"],
          priority: 1
        }
      }
    ]);
  });

  test("search and delete tools dispatch through distinct command paths", async () => {
    const calls: Array<{ name: string; input: unknown }> = [];
    const tools = createDefaultLocalAgentMcpTools({
      search: async (input) => {
        calls.push({ name: "search", input });
        return ok({ searched: input.query ?? "" });
      },
      deleteToTrash: async (input) => {
        calls.push({ name: "delete", input });
        return ok({ deleted: input.captureId });
      }
    });
    const search = tools.find((tool) => tool.name === "pwrsnap_library_search");
    const del = tools.find((tool) => tool.name === "pwrsnap_capture_delete_to_trash");
    if (search === undefined || del === undefined) throw new Error("expected default tools");

    await search.dispatch({
      query: "pairing",
      kinds: ["image"],
      hasOcr: true,
      limit: 25,
      detail: "enriched"
    }, ctx(["library.read"]));
    await del.dispatch({ captureId: "cap_123" }, ctx(["trash.write"]));

    expect(calls).toEqual([
      {
        name: "search",
        input: {
          query: "pairing",
          kinds: ["image"],
          hasOcr: true,
          limit: 25,
          detail: "enriched"
        }
      },
      { name: "delete", input: { captureId: "cap_123" } }
    ]);
  });

  test("delete-to-trash requires a capture id in its MCP schema", () => {
    const tools = createDefaultLocalAgentMcpTools({
      search: async () => ok({}),
      deleteToTrash: async () => ok({})
    });
    const del = tools.find((tool) => tool.name === "pwrsnap_capture_delete_to_trash");
    expect(del?.inputSchema).toHaveProperty("captureId");
  });

  test("search schema exposes structured library filters", () => {
    const tools = createDefaultLocalAgentMcpTools({
      search: async () => ok({}),
      deleteToTrash: async () => ok({})
    });
    const search = tools.find((tool) => tool.name === "pwrsnap_library_search");
    expect(search?.inputSchema).toEqual(expect.objectContaining({
      query: expect.anything(),
      appBundleIds: expect.anything(),
      includeCapturesWithoutSourceApp: expect.anything(),
      kinds: expect.anything(),
      dateRange: expect.anything(),
      hasOcr: expect.anything(),
      limit: expect.anything(),
      detail: expect.anything()
    }));
  });

  test("full tool set exposes media, edit, and Sizzle workflows", () => {
    const noop = async () => ok({});
    const tools = createDefaultLocalAgentMcpTools({
      search: noop,
      deleteToTrash: noop,
      metadata: noop,
      captureResource: noop,
      captureExport: noop,
      imageEditSend: noop,
      imageEditStatus: noop,
      sizzleCreate: noop,
      sizzleSend: noop,
      sizzleStatus: noop,
      sizzleRenderPreview: noop,
      sizzleRenderFull: noop
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      "pwrsnap_library_search",
      "pwrsnap_capture_delete_to_trash",
      "pwrsnap_capture_metadata",
      "pwrsnap_capture_resource",
      "pwrsnap_capture_export",
      "pwrsnap_image_edit_send",
      "pwrsnap_image_edit_status",
      "pwrsnap_sizzle_create",
      "pwrsnap_sizzle_send",
      "pwrsnap_sizzle_status",
      "pwrsnap_sizzle_render_preview",
      "pwrsnap_sizzle_render_full"
    ]);

    const resource = tools.find((tool) => tool.name === "pwrsnap_capture_resource");
    expect(resource?.requiredCapabilitiesForInput?.({
      captureId: "cap_1",
      variant: "original"
    })).toEqual(["capture.original.read"]);
    const captureExport = tools.find((tool) => tool.name === "pwrsnap_capture_export");
    expect(captureExport).toBeDefined();
    if (captureExport === undefined) return;
    expect(captureExport.requiredCapabilities).toEqual(["capture.export"]);
    expect(Object.keys(captureExport.inputSchema)).toEqual([
      "captureId",
      "variant",
      "preset",
      "format"
    ]);
    const captureExportInput = z.object(captureExport.inputSchema);
    expect(
      captureExportInput.safeParse({ captureId: "cap_1", format: "png" }).success
    ).toBe(true);
    expect(
      captureExportInput.safeParse({ captureId: "cap_1", format: "webp" }).success
    ).toBe(false);
    for (const name of ["pwrsnap_image_edit_send", "pwrsnap_image_edit_status"]) {
      expect(tools.find((tool) => tool.name === name)?.requiredCapabilities).toEqual([
        "capture.edit",
        "capture.composite.read"
      ]);
    }
  });

  test("annotations distinguish reads, artifact creation, AI access, and Trash", () => {
    const noop = async () => ok({});
    const tools = createDefaultLocalAgentMcpTools({
      search: noop,
      deleteToTrash: noop,
      metadata: noop,
      captureResource: noop,
      captureExport: noop,
      imageEditSend: noop,
      imageEditStatus: noop,
      sizzleCreate: noop,
      sizzleSend: noop,
      sizzleStatus: noop,
      sizzleRenderPreview: noop,
      sizzleRenderFull: noop
    });
    const annotations = Object.fromEntries(
      tools.map((tool) => [tool.name, tool.annotations])
    );

    for (const tool of tools) {
      expect(tool.annotations).toEqual(expect.objectContaining({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean)
      }));
    }

    expect(annotations.pwrsnap_library_search).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    });
    expect(annotations.pwrsnap_capture_export).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    });
    expect(annotations.pwrsnap_image_edit_send).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    });
    expect(annotations.pwrsnap_capture_delete_to_trash).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    });
    expect(annotations.pwrsnap_sizzle_render_full).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    });
  });
});
