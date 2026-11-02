// Pure translators between PwrSnap's Codex-shaped tool types and MCP's wire
// shapes. Kept separate from the MCP server entry (which runs on import) so
// they're unit-testable.

import type {
  CallToolResult,
  Tool
} from "@modelcontextprotocol/sdk/types.js";
import type {
  DynamicToolCallResponse,
  DynamicToolNamespaceTool,
  DynamicToolSpec
} from "@pwrdrvr/codex-app-server-protocol/v2";

export type FlatDynamicTool = {
  namespace: string | null;
  spec: DynamicToolNamespaceTool;
};

type InputAudioItem = {
  type: "inputAudio";
  audioUrl: string;
};

function isInputAudioItem(item: unknown): item is InputAudioItem {
  return (
    typeof item === "object" &&
    item !== null &&
    "type" in item &&
    item.type === "inputAudio" &&
    "audioUrl" in item &&
    typeof item.audioUrl === "string"
  );
}

/**
 * MCP exposes one flat tool list, while Codex 0.144 groups namespaced dynamic
 * tools under namespace objects. Flatten the Codex catalog without losing the
 * namespace needed when forwarding an MCP call back to PwrSnap main.
 */
export function flattenDynamicToolCatalog(
  catalog: ReadonlyArray<DynamicToolSpec>
): FlatDynamicTool[] {
  const flattened: FlatDynamicTool[] = [];
  for (const entry of catalog) {
    if (entry.type === "function") {
      flattened.push({ namespace: null, spec: entry });
      continue;
    }
    for (const spec of entry.tools) {
      flattened.push({ namespace: entry.name, spec });
    }
  }
  return flattened;
}

/** Translate one flat Codex function spec into an MCP `Tool`. */
export function toMcpTool(spec: DynamicToolNamespaceTool): Tool {
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

/** Translate PwrSnap's tool response into an MCP CallToolResult. Image and
 *  audio data: URLs become MCP media content; non-data URLs degrade to a text
 *  reference so the agent still knows media was produced. */
export function toCallToolResult(response: DynamicToolCallResponse): CallToolResult {
  const content: CallToolResult["content"] = [];
  for (const item of response.contentItems) {
    if (item.type === "inputText") {
      content.push({ type: "text", text: item.text });
      continue;
    }
    if (item.type === "inputImage") {
      const dataUrl = /^data:([^;]+);base64,(.*)$/s.exec(item.imageUrl);
      if (dataUrl) {
        content.push({ type: "image", mimeType: dataUrl[1]!, data: dataUrl[2]! });
      } else {
        content.push({ type: "text", text: `[image] ${item.imageUrl}` });
      }
      continue;
    }
    if (isInputAudioItem(item)) {
      const dataUrl = /^data:([^;]+);base64,(.*)$/s.exec(item.audioUrl);
      if (dataUrl) {
        content.push({ type: "audio", mimeType: dataUrl[1]!, data: dataUrl[2]! });
      } else {
        content.push({ type: "text", text: `[audio] ${item.audioUrl}` });
      }
      continue;
    }
    const unhandledItem: never = item;
    throw new Error(`Unsupported Codex tool content type: ${unhandledItem}`);
  }
  if (content.length === 0) content.push({ type: "text", text: "(no output)" });
  return { content, isError: !response.success };
}
