import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { LocalAgentCapability, PwrSnapError } from "@pwrsnap/shared";
import { err, ok, type Result } from "@pwrsnap/shared";
import { z } from "zod";
import type { CommandContext } from "../command-bus";
import type { LocalAgentSearchInput } from "./local-agent-search";

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
  search: (
    input: LocalAgentSearchInput,
    ctx: LocalAgentToolContext
  ) => Promise<Result<unknown, PwrSnapError>>;
  deleteToTrash: (
    input: { captureId: string },
    ctx: LocalAgentToolContext
  ) => Promise<Result<unknown, PwrSnapError>>;
}): LocalAgentMcpTool<z.ZodRawShape>[] {
  const searchInputSchema = {
    query: z.string().max(1_000).optional(),
    appBundleIds: z.array(z.string().max(1_000).nullable()).max(100).optional(),
    kinds: z.array(z.enum(["image", "video"])).max(2).optional(),
    dateRange: z.object({
      start: z.string().min(1).max(100),
      end: z.string().min(1).max(100)
    }).optional(),
    hasOcr: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).optional()
  } satisfies z.ZodRawShape;
  const searchTool: LocalAgentMcpTool<typeof searchInputSchema> = {
    name: "pwrsnap_library_search",
    title: "Search PwrSnap Library",
    description: "Search live, non-trashed PwrSnap captures and return compact metadata rows.",
    inputSchema: searchInputSchema,
    requiredCapabilities: ["library.read"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false
    },
    dispatch: async (input, ctx) => deps.search(input, ctx)
  };
  const deleteTool: LocalAgentMcpTool<{ captureId: z.ZodString }> = {
    name: "pwrsnap_capture_delete_to_trash",
    title: "Move PwrSnap Capture To Trash",
    description: "Move a capture to PwrSnap Trash. Permanent purge is not exposed.",
    inputSchema: {
      captureId: z.string().min(1)
    },
    requiredCapabilities: ["trash.write"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false
    },
    dispatch: async (input, ctx) => deps.deleteToTrash(input, ctx)
  };
  return [searchTool, deleteTool] as LocalAgentMcpTool<z.ZodRawShape>[];
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
