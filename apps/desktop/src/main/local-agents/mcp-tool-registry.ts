import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { LocalAgentCapability, PwrSnapError } from "@pwrsnap/shared";
import { err, ok, type Result } from "@pwrsnap/shared";
import type { z } from "zod";
import type { CommandContext } from "../command-bus";

export type LocalAgentToolContext = {
  clientId: string;
  capabilities: readonly LocalAgentCapability[];
  signal: AbortSignal;
  commandContext: CommandContext;
};

export type LocalAgentMcpTool<Input extends z.ZodRawShape> = {
  name: string;
  title: string;
  description: string;
  inputSchema: Input;
  requiredCapabilities: readonly LocalAgentCapability[];
  annotations: ToolAnnotations;
  dispatch: (input: z.output<z.ZodObject<Input>>, ctx: LocalAgentToolContext) => Promise<Result<unknown, PwrSnapError>>;
};

export function hasEveryCapability(
  granted: readonly LocalAgentCapability[],
  required: readonly LocalAgentCapability[]
): boolean {
  return required.every((capability) => granted.includes(capability));
}

export function toMcpToolResult(result: Result<unknown, PwrSnapError>): CallToolResult {
  if (!result.ok) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `${result.error.code}: ${result.error.message}`
        }
      ]
    };
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result.value)
      }
    ],
    structuredContent:
      result.value !== null && typeof result.value === "object"
        ? (result.value as Record<string, unknown>)
        : { value: result.value }
  };
}

export function capabilityDenied(
  toolName: string,
  missing: readonly LocalAgentCapability[]
): Result<never, PwrSnapError> {
  return err({
    kind: "validation",
    code: "missing_capability",
    message: `local agent cannot call ${toolName}; missing ${missing.join(", ")}`
  });
}

export function createDefaultLocalAgentMcpTools(deps: {
  dispatch: (ctx: LocalAgentToolContext) => Promise<Result<unknown, PwrSnapError>>;
}): LocalAgentMcpTool<z.ZodRawShape>[] {
  return [
    {
      name: "pwrsnap_library_search",
      title: "Search PwrSnap Library",
      description: "Search live, non-trashed PwrSnap captures and return compact metadata rows.",
      inputSchema: {},
      requiredCapabilities: ["library.read"],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      },
      dispatch: async (_input, ctx) => deps.dispatch(ctx)
    },
    {
      name: "pwrsnap_capture_delete_to_trash",
      title: "Move PwrSnap Capture To Trash",
      description: "Move a capture to PwrSnap Trash. Permanent purge is not exposed.",
      inputSchema: {},
      requiredCapabilities: ["trash.write"],
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false
      },
      dispatch: async (_input, ctx) => deps.dispatch(ctx)
    }
  ];
}

export function validateToolCapability<Input extends z.ZodRawShape>(
  tool: LocalAgentMcpTool<Input>,
  ctx: LocalAgentToolContext
): Result<void, PwrSnapError> {
  const missing = tool.requiredCapabilities.filter(
    (capability) => !ctx.capabilities.includes(capability)
  );
  if (missing.length > 0) return capabilityDenied(tool.name, missing);
  return ok(undefined);
}
