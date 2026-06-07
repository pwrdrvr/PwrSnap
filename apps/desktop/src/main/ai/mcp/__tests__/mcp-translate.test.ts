import { describe, expect, test } from "vitest";
import type {
  DynamicToolCallResponse,
  DynamicToolSpec
} from "@pwrdrvr/codex-app-server-protocol/v2";
import { toCallToolResult, toMcpTool } from "../mcp-translate";

describe("toMcpTool", () => {
  test("carries name/description and the inputSchema through", () => {
    const spec = {
      namespace: "library",
      name: "draw_arrow",
      description: "Draw an arrow",
      inputSchema: { type: "object", properties: { capture_id: { type: "string" } } }
    } as unknown as DynamicToolSpec;
    const tool = toMcpTool(spec);
    expect(tool.name).toBe("draw_arrow");
    expect(tool.description).toBe("Draw an arrow");
    expect(tool.inputSchema).toMatchObject({
      type: "object",
      properties: { capture_id: { type: "string" } }
    });
  });

  test("falls back to an object schema when inputSchema is missing", () => {
    const spec = { name: "x", description: "y" } as unknown as DynamicToolSpec;
    expect(toMcpTool(spec).inputSchema).toEqual({ type: "object" });
  });
});

describe("toCallToolResult", () => {
  test("maps inputText items to MCP text content; success → not isError", () => {
    const res = {
      success: true,
      contentItems: [{ type: "inputText", text: "did the thing" }]
    } as unknown as DynamicToolCallResponse;
    expect(toCallToolResult(res)).toEqual({
      content: [{ type: "text", text: "did the thing" }],
      isError: false
    });
  });

  test("flags failures as isError", () => {
    const res = {
      success: false,
      contentItems: [{ type: "inputText", text: "Unknown tool" }]
    } as unknown as DynamicToolCallResponse;
    expect(toCallToolResult(res).isError).toBe(true);
  });

  test("decodes a data: image URL into MCP image content", () => {
    const res = {
      success: true,
      contentItems: [{ type: "inputImage", imageUrl: "data:image/png;base64,QUJD" }]
    } as unknown as DynamicToolCallResponse;
    expect(toCallToolResult(res).content[0]).toEqual({
      type: "image",
      mimeType: "image/png",
      data: "QUJD"
    });
  });

  test("degrades a non-data image URL to a text reference", () => {
    const res = {
      success: true,
      contentItems: [{ type: "inputImage", imageUrl: "file:///tmp/x.png" }]
    } as unknown as DynamicToolCallResponse;
    expect(toCallToolResult(res).content[0]).toEqual({
      type: "text",
      text: "[image] file:///tmp/x.png"
    });
  });

  test("never returns empty content", () => {
    const res = { success: true, contentItems: [] } as unknown as DynamicToolCallResponse;
    expect(toCallToolResult(res).content).toEqual([{ type: "text", text: "(no output)" }]);
  });
});
