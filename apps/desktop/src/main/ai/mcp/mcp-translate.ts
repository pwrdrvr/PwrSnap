// Pure translators between PwrSnap's Codex-shaped tool types and MCP's wire
// shapes. Kept separate from the MCP server entry (which runs on import) so
// they're unit-testable.

import type {
  CallToolResult,
  Tool
} from "@modelcontextprotocol/sdk/types.js";
import type {
  DynamicToolCallResponse,
  DynamicToolSpec
} from "@pwrdrvr/codex-app-server-protocol/v2";

/** Translate a PwrSnap `DynamicToolSpec` into an MCP `Tool`. */
export function toMcpTool(spec: DynamicToolSpec): Tool {
  const schema = spec.inputSchema as Record<string, unknown> | undefined;
  return {
    name: spec.name,
    description: spec.description,
    inputSchema:
      schema && typeof schema === "object"
        ? (schema as Tool["inputSchema"])
        : { type: "object" }
  };
}

/** Translate PwrSnap's tool response into an MCP CallToolResult. `inputImage`
 *  data: URLs become MCP image content; non-data URLs degrade to a text
 *  reference so the agent still knows an image was produced. */
export function toCallToolResult(response: DynamicToolCallResponse): CallToolResult {
  const content: CallToolResult["content"] = [];
  for (const item of response.contentItems) {
    if (item.type === "inputText") {
      content.push({ type: "text", text: item.text });
    } else {
      const dataUrl = /^data:([^;]+);base64,(.*)$/s.exec(item.imageUrl);
      if (dataUrl) {
        content.push({ type: "image", mimeType: dataUrl[1]!, data: dataUrl[2]! });
      } else {
        content.push({ type: "text", text: `[image] ${item.imageUrl}` });
      }
    }
  }
  if (content.length === 0) content.push({ type: "text", text: "(no output)" });
  return { content, isError: !response.success };
}
