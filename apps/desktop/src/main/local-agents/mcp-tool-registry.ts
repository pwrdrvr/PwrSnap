import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { LocalAgentCapability, PwrSnapError } from "@pwrsnap/shared";
import { err, ok, type Result } from "@pwrsnap/shared";
import { z } from "zod";
import type { CommandContext } from "../command-bus";
import type { LocalAgentSearchInput } from "./local-agent-search";

const IMAGE_PREVIEW_DELIVERY_GUIDANCE =
  "Returns a directly renderable, bounded image preview in the tool content plus an MCP resource URI and a five-minute signed localhost URL for the exact bytes. " +
  "Do not call MCP resources/read just to display the preview. Use the resource URI or signed URL only when the exact binary is required. " +
  "Treat the signed URL as a temporary bearer secret and do not log or share it.";

const RESOURCE_DELIVERY_GUIDANCE =
  "Returns an MCP resource URI and a five-minute signed localhost URL. " +
  "Prefer the signed URL for binary media consumers; use the resource URI with MCP resources/read. " +
  "Treat the signed URL as a temporary bearer secret and do not log or share it.";

const supplementalContent = Symbol("local-agent-mcp-supplemental-content");

type ToolValueWithSupplementalContent = {
  [supplementalContent]?: CallToolResult["content"];
};

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
  requiredCapabilitiesForInput?: (
    input: z.output<z.ZodObject<Input>>
  ) => readonly LocalAgentCapability[];
  annotations: ToolAnnotations;
  dispatch: (input: z.output<z.ZodObject<Input>>, ctx: LocalAgentToolContext) => Promise<Result<unknown, PwrSnapError>>;
};

export type AnyLocalAgentMcpTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  requiredCapabilities: readonly LocalAgentCapability[];
  requiredCapabilitiesForInput?: (input: any) => readonly LocalAgentCapability[];
  annotations: ToolAnnotations;
  dispatch: (
    input: any,
    ctx: LocalAgentToolContext
  ) => Promise<Result<unknown, PwrSnapError>>;
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
  const supplemental = supplementalContentFor(result.value);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result.value)
      },
      ...supplemental
    ],
    structuredContent:
      result.value !== null && typeof result.value === "object"
        ? (result.value as Record<string, unknown>)
        : { value: result.value }
  };
}

export function withMcpSupplementalContent<T extends Record<string, unknown>>(
  value: T,
  content: CallToolResult["content"]
): T {
  Object.defineProperty(value, supplementalContent, {
    configurable: false,
    enumerable: false,
    value: content,
    writable: false
  });
  return value;
}

function supplementalContentFor(value: unknown): CallToolResult["content"] {
  if (value === null || typeof value !== "object") return [];
  return (value as ToolValueWithSupplementalContent)[supplementalContent] ?? [];
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
  metadata?: (
    input: { captureId: string },
    ctx: LocalAgentToolContext
  ) => Promise<Result<unknown, PwrSnapError>>;
  captureResource?: (
    input: { captureId: string; variant?: "composite" | "original" | undefined },
    ctx: LocalAgentToolContext
  ) => Promise<Result<unknown, PwrSnapError>>;
  captureExport?: (
    input: {
      captureId: string;
      variant?: "composite" | "original" | undefined;
      format?: "png" | "jpeg" | "webp" | "pdf" | "heic" | undefined;
      maxWidth?: number | undefined;
      maxHeight?: number | undefined;
      scale?: number | undefined;
      quality?: number | undefined;
      background?: string | undefined;
    },
    ctx: LocalAgentToolContext
  ) => Promise<Result<unknown, PwrSnapError>>;
  imageEditSend?: (
    input: {
      captureId: string;
      instruction: string;
      provider?: string | undefined;
      model?: string | undefined;
      threadId?: string | undefined;
      reuse?: "latest-compatible" | "new" | undefined;
    },
    ctx: LocalAgentToolContext
  ) => Promise<Result<unknown, PwrSnapError>>;
  imageEditStatus?: (
    input: { captureId: string; threadId: string },
    ctx: LocalAgentToolContext
  ) => Promise<Result<unknown, PwrSnapError>>;
  sizzleCreate?: (
    input: {
      name: string;
      captureIds: string[];
      brief?: string | undefined;
      provider?: string | undefined;
      model?: string | undefined;
    },
    ctx: LocalAgentToolContext
  ) => Promise<Result<unknown, PwrSnapError>>;
  sizzleSend?: (
    input: { projectId: string; instruction: string; threadId?: string | undefined },
    ctx: LocalAgentToolContext
  ) => Promise<Result<unknown, PwrSnapError>>;
  sizzleStatus?: (
    input: { projectId: string; threadId: string },
    ctx: LocalAgentToolContext
  ) => Promise<Result<unknown, PwrSnapError>>;
  sizzleRenderPreview?: (
    input: { projectId: string },
    ctx: LocalAgentToolContext
  ) => Promise<Result<unknown, PwrSnapError>>;
  sizzleRenderFull?: (
    input: { projectId: string },
    ctx: LocalAgentToolContext
  ) => Promise<Result<unknown, PwrSnapError>>;
}): AnyLocalAgentMcpTool[] {
  const searchInputSchema = {
    query: z.string().max(1_000).describe("Text to match against indexed capture metadata and OCR.").optional(),
    appBundleIds: z.array(z.string().min(1).max(1_000)).max(100)
      .describe("Exact source application bundle IDs. An empty array matches no captures.")
      .optional(),
    includeCapturesWithoutSourceApp: z.boolean()
      .describe("Include captures whose source application bundle ID is unknown.")
      .optional(),
    kinds: z.array(z.enum(["image", "video"])).max(2)
      .describe("Capture kinds to include. An empty array matches no captures.")
      .optional(),
    dateRange: z.object({
      start: z.iso.datetime().describe("Inclusive UTC start timestamp in ISO 8601 format."),
      end: z.iso.datetime().describe("Inclusive UTC end timestamp in ISO 8601 format.")
    }).describe("Inclusive capture timestamp range.").optional(),
    hasOcr: z.boolean().describe("When true, only return captures with OCR text.").optional(),
    limit: z.number().int().min(1).max(500).describe("Maximum rows to return.").optional(),
    detail: z.enum(["summary", "enriched"])
      .describe("summary (default) omits generated text and match snippets; enriched includes title, description, tags, and matchSnippet.")
      .optional()
  } satisfies z.ZodRawShape;
  const searchTool: LocalAgentMcpTool<typeof searchInputSchema> = {
    name: "pwrsnap_library_search",
    title: "Search PwrSnap Library",
    description: "Search live, non-trashed PwrSnap captures. Results default to structural summary metadata; request enriched detail only when generated text and search snippets are needed.",
    inputSchema: searchInputSchema,
    requiredCapabilities: ["library.read"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
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
      idempotentHint: true,
      openWorldHint: false
    },
    dispatch: async (input, ctx) => deps.deleteToTrash(input, ctx)
  };
  const tools: AnyLocalAgentMcpTool[] = [searchTool, deleteTool];

  if (deps.metadata !== undefined) {
    tools.push({
      name: "pwrsnap_capture_metadata",
      title: "Read PwrSnap Capture Metadata",
      description: "Read compact metadata and available media resource classes for one live capture.",
      inputSchema: { captureId: z.string().min(1) },
      requiredCapabilities: ["library.read"],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      dispatch: deps.metadata
    });
  }
  if (deps.captureResource !== undefined) {
    tools.push({
      name: "pwrsnap_capture_resource",
      title: "Get PwrSnap Capture Resource",
      description:
        "Prepare the content-bearing current edited composite by default, or the original when separately granted. " +
        IMAGE_PREVIEW_DELIVERY_GUIDANCE,
      inputSchema: {
        captureId: z.string().min(1),
        variant: z.enum(["composite", "original"]).optional()
      },
      requiredCapabilities: [],
      requiredCapabilitiesForInput: (input) => [
        input.variant === "original"
          ? "capture.original.read"
          : "capture.composite.read"
      ],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      dispatch: deps.captureResource
    });
  }
  if (deps.captureExport !== undefined) {
    tools.push({
      name: "pwrsnap_capture_export",
      title: "Export PwrSnap Capture",
      description:
        "Resize or convert a permitted edited composite or original image to PNG, JPEG, WebP, PDF, or HEIC. " +
        IMAGE_PREVIEW_DELIVERY_GUIDANCE,
      inputSchema: {
        captureId: z.string().min(1),
        variant: z.enum(["composite", "original"]).optional(),
        format: z.enum(["png", "jpeg", "webp", "pdf", "heic"]).optional(),
        maxWidth: z.number().int().min(1).max(16_384).optional(),
        maxHeight: z.number().int().min(1).max(16_384).optional(),
        scale: z.number().min(0.05).max(4).optional(),
        quality: z.number().int().min(1).max(100).optional(),
        background: z.string().max(100).optional()
      },
      requiredCapabilities: ["capture.export"],
      requiredCapabilitiesForInput: (input) => [
        input.variant === "original"
          ? "capture.original.read"
          : "capture.composite.read"
      ],
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      dispatch: deps.captureExport
    });
  }
  if (deps.imageEditSend !== undefined) {
    tools.push({
      name: "pwrsnap_image_edit_send",
      title: "Edit PwrSnap Image",
      description: "Send an edit instruction through a PwrSnap-owned capture chat thread and its configured model access.",
      inputSchema: {
        captureId: z.string().min(1),
        instruction: z.string().trim().min(1).max(20_000),
        provider: z.string().trim().min(1).max(200).optional(),
        model: z.string().trim().min(1).max(200).optional(),
        threadId: z.string().min(1).optional(),
        reuse: z.enum(["latest-compatible", "new"]).optional()
      },
      requiredCapabilities: ["capture.edit", "capture.composite.read"],
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      },
      dispatch: deps.imageEditSend
    });
  }
  if (deps.imageEditStatus !== undefined) {
    tools.push({
      name: "pwrsnap_image_edit_status",
      title: "Check PwrSnap Image Edit",
      description:
        "Check a capture-scoped edit thread and retrieve its protected composite once the turn is complete. " +
        RESOURCE_DELIVERY_GUIDANCE,
      inputSchema: {
        captureId: z.string().min(1),
        threadId: z.string().min(1)
      },
      requiredCapabilities: ["capture.edit", "capture.composite.read"],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      dispatch: deps.imageEditStatus
    });
  }
  if (deps.sizzleCreate !== undefined) {
    tools.push({
      name: "pwrsnap_sizzle_create",
      title: "Create PwrSnap Sizzle Reel",
      description: "Create a Sizzle project from captures and optionally start its PwrSnap-owned composition chat.",
      inputSchema: {
        name: z.string().trim().min(1).max(200),
        captureIds: z.array(z.string().min(1)).min(1).max(200),
        brief: z.string().trim().min(1).max(20_000).optional(),
        provider: z.string().trim().min(1).max(200).optional(),
        model: z.string().trim().min(1).max(200).optional()
      },
      requiredCapabilities: ["sizzle.compose"],
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      },
      dispatch: deps.sizzleCreate
    });
  }
  if (deps.sizzleSend !== undefined) {
    tools.push({
      name: "pwrsnap_sizzle_send",
      title: "Continue PwrSnap Sizzle Reel",
      description: "Send a follow-up instruction to a project-scoped PwrSnap Sizzle chat.",
      inputSchema: {
        projectId: z.string().min(1),
        instruction: z.string().trim().min(1).max(20_000),
        threadId: z.string().min(1).optional()
      },
      requiredCapabilities: ["sizzle.compose"],
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      },
      dispatch: deps.sizzleSend
    });
  }
  if (deps.sizzleStatus !== undefined) {
    tools.push({
      name: "pwrsnap_sizzle_status",
      title: "Check PwrSnap Sizzle Chat",
      description: "Check the current state of a project-scoped Sizzle composition thread.",
      inputSchema: {
        projectId: z.string().min(1),
        threadId: z.string().min(1)
      },
      requiredCapabilities: ["sizzle.compose"],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      dispatch: deps.sizzleStatus
    });
  }
  if (deps.sizzleRenderPreview !== undefined) {
    tools.push({
      name: "pwrsnap_sizzle_render_preview",
      title: "Render PwrSnap Sizzle Preview",
      description:
        "Render a low-resolution Sizzle preview and return protected media. " +
        RESOURCE_DELIVERY_GUIDANCE,
      inputSchema: { projectId: z.string().min(1) },
      requiredCapabilities: ["sizzle.preview.read"],
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      },
      dispatch: deps.sizzleRenderPreview
    });
  }
  if (deps.sizzleRenderFull !== undefined) {
    tools.push({
      name: "pwrsnap_sizzle_render_full",
      title: "Render Full PwrSnap Sizzle Reel",
      description:
        "Render a full-resolution Sizzle reel and return protected media. " +
        RESOURCE_DELIVERY_GUIDANCE,
      inputSchema: { projectId: z.string().min(1) },
      requiredCapabilities: ["sizzle.full.read"],
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      },
      dispatch: deps.sizzleRenderFull
    });
  }
  return tools;
}

export function validateToolCapability<Input extends z.ZodRawShape>(
  tool: LocalAgentMcpTool<Input>,
  ctx: LocalAgentToolContext,
  input?: z.output<z.ZodObject<Input>>
): Result<void, PwrSnapError> {
  const required = [
    ...tool.requiredCapabilities,
    ...(input !== undefined ? tool.requiredCapabilitiesForInput?.(input) ?? [] : [])
  ];
  const missing = [...new Set(required)].filter(
    (capability) => !ctx.capabilities.includes(capability)
  );
  if (missing.length > 0) return capabilityDenied(tool.name, missing);
  return ok(undefined);
}
