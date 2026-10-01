import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { LocalAgentCapability, PwrSnapError } from "@pwrsnap/shared";
import {
  err,
  ok,
  VIDEO_ACTIVITY_GUIDANCE,
  VIDEO_EDIT_MODEL_GUIDANCE,
  type Result
} from "@pwrsnap/shared";
import { z } from "zod";
import type { CommandContext } from "../command-bus";
import {
  LOCAL_AGENT_MCP_DEFAULT_LIMIT,
  LOCAL_AGENT_MCP_MAX_LIMIT,
  type LocalAgentSearchInput
} from "./local-agent-search";

const MEDIA_DELIVERY_GUIDANCE =
  "Returns an attached typed MCP resource link for media delivery. Pass it directly to the client's media handler; use resourceUri only in clients that explicitly support MCP resource reads.";

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

export type LocalAgentCaptureExportInput = {
  captureId: string;
  variant?: "composite" | "original" | undefined;
  preset?: "low" | "med" | "high" | undefined;
  format?: "png" | "jpeg" | "pdf" | "heic" | undefined;
};

export type LocalAgentVideoSpan = { start: number; end: number };

export type LocalAgentVideoInspectInput = {
  captureId: string;
  minStillSec?: number | undefined;
  treatMinorAsStill?: boolean | undefined;
  includeTrack?: boolean | undefined;
};

export type LocalAgentVideoEditInput = {
  captureId: string;
  keep?: LocalAgentVideoSpan[] | undefined;
  cut?: LocalAgentVideoSpan[] | undefined;
  cutStill?:
    | {
        minStillSec?: number | undefined;
        paddingSec?: number | undefined;
        treatMinorAsStill?: boolean | undefined;
      }
    | undefined;
  reset?: boolean | undefined;
};

export type LocalAgentMcpTool<Input extends z.ZodRawShape> = {
  name: string;
  title: string;
  description: string;
  inputSchema: Input;
  requiredCapabilities: readonly LocalAgentCapability[];
  /** At least one of these, on top of `requiredCapabilities`. For a read an
   *  editor needs as much as a librarian does. */
  requiredAnyCapabilities?: readonly LocalAgentCapability[];
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
  requiredAnyCapabilities?: readonly LocalAgentCapability[];
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
  // `structuredContent` must be a JSON object on the wire — the SDK client
  // parses it as a record and fails the whole call on an array — so anything
  // else is wrapped.
  const structuredContent =
    result.value !== null && typeof result.value === "object" && !Array.isArray(result.value)
      ? (result.value as Record<string, unknown>)
      : { value: result.value };
  return {
    content: [
      {
        type: "text",
        text: successSummary(result.value, supplemental)
      },
      ...supplemental,
      // MCP: a tool returning `structuredContent` SHOULD also serialize it into
      // a text block, for hosts that read only `content`. Last, so a media
      // tool's resource_link stays beside the sentence introducing it; never
      // the signed media URL, which lives only in that link. See
      // docs/mcp-third-party-agents.md §"Tool results carry their data twice".
      { type: "text", text: JSON.stringify(structuredContent) }
    ],
    structuredContent
  };
}

function withMcpSupplementalContent<T extends Record<string, unknown>>(
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

export function withMcpResourceLink<T extends Record<string, unknown>>(
  value: T,
  link: {
    uri: string;
    name: string;
    mimeType: string;
    size?: number;
  }
): T {
  return withMcpSupplementalContent(value, [
    {
      type: "resource_link",
      uri: link.uri,
      name: link.name,
      description:
        "Pass this link directly to the client media fetch/render path. Do not copy or reconstruct its URI.",
      mimeType: link.mimeType,
      ...(link.size !== undefined ? { size: link.size } : {}),
      annotations: {
        audience: ["user", "assistant"],
        priority: 1
      }
    }
  ]);
}

function supplementalContentFor(value: unknown): CallToolResult["content"] {
  if (value === null || typeof value !== "object") return [];
  return (value as ToolValueWithSupplementalContent)[supplementalContent] ?? [];
}

/** The first line of a result: what happened, in a sentence. The data itself
 *  follows in the JSON block, so this never has to point at it. */
function successSummary(
  value: unknown,
  supplemental: CallToolResult["content"]
): string {
  if (supplemental.some((content) => content.type === "resource_link")) {
    return "PwrSnap media is ready in the attached resource link. Pass that link directly to the client media handler.";
  }
  if (value !== null && typeof value === "object" && "rows" in value) {
    const rows = (value as { rows?: unknown }).rows;
    if (Array.isArray(rows)) {
      return `PwrSnap returned ${rows.length} capture${rows.length === 1 ? "" : "s"}.`;
    }
  }
  return "PwrSnap operation completed.";
}

export function capabilityDenied(
  toolName: string,
  missing: readonly LocalAgentCapability[],
  missingAnyOf: readonly LocalAgentCapability[] = []
): Result<never, PwrSnapError> {
  const parts = [
    ...(missing.length > 0 ? [missing.join(", ")] : []),
    ...(missingAnyOf.length > 0 ? [`one of ${missingAnyOf.join(", ")}`] : [])
  ];
  return err({
    kind: "validation",
    code: "missing_capability",
    message: `local agent cannot call ${toolName}; missing ${parts.join("; ")}`
  });
}

export function createDefaultLocalAgentMcpTools(deps: {
  search: (
    input: LocalAgentSearchInput,
    ctx: LocalAgentToolContext
  ) => Promise<Result<unknown, PwrSnapError>>;
  discovery?: (
    input: { limit?: number | undefined },
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
    input: LocalAgentCaptureExportInput,
    ctx: LocalAgentToolContext
  ) => Promise<Result<unknown, PwrSnapError>>;
  imageEditSend?: (
    input: {
      captureId: string;
      instruction?: string | undefined;
      instructions?: string[] | undefined;
      provider?: string | undefined;
      model?: string | undefined;
      threadId?: string | undefined;
      reuse?: "latest-compatible" | "new" | undefined;
      returnImage?: boolean | undefined;
      preset?: "low" | "med" | "high" | undefined;
    },
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
  videoInspect?: (
    input: LocalAgentVideoInspectInput,
    ctx: LocalAgentToolContext
  ) => Promise<Result<unknown, PwrSnapError>>;
  videoEdit?: (
    input: LocalAgentVideoEditInput,
    ctx: LocalAgentToolContext
  ) => Promise<Result<unknown, PwrSnapError>>;
  captureDuplicate?: (
    input: { captureId: string; withEdits: boolean },
    ctx: LocalAgentToolContext
  ) => Promise<Result<unknown, PwrSnapError>>;
  captureEditSummary?: (
    input: { captureId: string },
    ctx: LocalAgentToolContext
  ) => Promise<Result<unknown, PwrSnapError>>;
  captureFamilies?: (
    input: { limit?: number | undefined },
    ctx: LocalAgentToolContext
  ) => Promise<Result<unknown, PwrSnapError>>;
  captureFamily?: (
    input: {
      familyId: string;
      limit?: number | undefined;
      detail?: "summary" | "enriched" | undefined;
    },
    ctx: LocalAgentToolContext
  ) => Promise<Result<unknown, PwrSnapError>>;
}): AnyLocalAgentMcpTool[] {
  const searchInputSchema = {
    query: z.string().max(1_000).describe("Text to match against indexed capture metadata, accepted tags, and OCR. Query searches default to relevance order.").optional(),
    sourceAppNames: z.array(z.string().trim().min(1).max(1_000)).max(100)
      .describe("Exact human source application names, for example ['Claude']. Reuse applications[].name from pwrsnap_library_discover. An empty array matches no captures.")
      .optional(),
    tagFilter: z.object({
      labels: z.array(z.string().trim().min(1).max(1_000)).min(1).max(100)
        .describe("Exact accepted-tag labels. Reuse tags[].label from pwrsnap_library_discover."),
      match: z.enum(["any", "all"])
        .describe("any returns captures with at least one label; all requires every label.")
    }).describe("Exact accepted-tag filter. match is required so multiple-tag semantics are explicit.").optional(),
    kinds: z.array(z.enum(["image", "video"])).max(2)
      .describe("Capture kinds to include. An empty array matches no captures.")
      .optional(),
    dateRange: z.object({
      start: z.iso.datetime().describe("Inclusive UTC start timestamp in ISO 8601 format."),
      end: z.iso.datetime().describe("Inclusive UTC end timestamp in ISO 8601 format.")
    }).describe("Inclusive capture timestamp range.").optional(),
    hasOcr: z.boolean().describe("When true, only return captures with OCR text.").optional(),
    order: z.enum(["relevance", "newest", "oldest"])
      .describe("Result order. Defaults to relevance with query, newest without query. relevance requires query.")
      .optional(),
    limit: z.number().int().min(1).max(LOCAL_AGENT_MCP_MAX_LIMIT)
      .describe(`Maximum rows to return. Defaults to ${LOCAL_AGENT_MCP_DEFAULT_LIMIT}.`)
      .optional(),
    detail: z.enum(["summary", "enriched"])
      .describe("summary (default) omits generated text and match snippets; enriched includes title, description, tags, and matchSnippet.")
      .optional()
  } satisfies z.ZodRawShape;
  const searchTool: LocalAgentMcpTool<typeof searchInputSchema> = {
    name: "pwrsnap_library_search",
    title: "Search PwrSnap Library",
    description: "Search live, non-trashed PwrSnap captures by text, human source application name, exact accepted tags, kind, date, and OCR presence. No-query searches default to newest first; query searches default to relevance. Results default to structural summary metadata; request enriched detail only when generated text and search snippets are needed. Results report whether narrower filters could return more matches.",
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
  const discoveryTool: LocalAgentMcpTool<{ limit: z.ZodOptional<z.ZodNumber> }> = {
    name: "pwrsnap_library_discover",
    title: "Discover PwrSnap Library Filters",
    description: "List live human source applications and accepted tags that can be reused in pwrsnap_library_search. Both lists exclude Trash and are ordered by capture count descending, then most recent capture. Application names are the reusable sourceAppNames values; bundleId is optional read-only metadata when known unambiguously. Results report whether either list has more entries.",
    inputSchema: {
      limit: z.number().int().min(1).max(LOCAL_AGENT_MCP_MAX_LIMIT)
        .describe(`Maximum applications and tags to return per list. Defaults to ${LOCAL_AGENT_MCP_DEFAULT_LIMIT}.`)
        .optional()
    },
    requiredCapabilities: ["library.read"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    dispatch: async (input, ctx) => {
      if (deps.discovery === undefined) {
        return err({
          kind: "validation",
          code: "tool_unavailable",
          message: "library discovery is unavailable"
        });
      }
      return deps.discovery(input, ctx);
    }
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
  const tools: AnyLocalAgentMcpTool[] = [searchTool];
  if (deps.discovery !== undefined) tools.push(discoveryTool);
  tools.push(deleteTool);

  if (deps.metadata !== undefined) {
    tools.push({
      name: "pwrsnap_capture_metadata",
      title: "Read PwrSnap Capture Metadata",
      description: "Read compact metadata for one live capture. Use pwrsnap_capture_resource when media bytes are needed.",
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
        MEDIA_DELIVERY_GUIDANCE,
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
        "Export a permitted edited composite or original using PwrSnap's Low, Med, or High baked size. " +
        "Defaults to Med PNG. PNG is preferred for screenshots; JPEG is a compact lossy image, PDF is a single-page document, and HEIC is available on supported macOS installations. " +
        MEDIA_DELIVERY_GUIDANCE,
      inputSchema: {
        captureId: z.string().min(1),
        variant: z.enum(["composite", "original"])
          .describe("Export the edited composite by default, or the original when separately granted.")
          .optional(),
        preset: z.enum(["low", "med", "high"])
          .describe("PwrSnap's baked output-size ladder. Defaults to med and never upscales.")
          .optional(),
        format: z.enum(["png", "jpeg", "pdf", "heic"])
          .describe("Output format. Defaults to png; PwrSnap owns lossy quality settings.")
          .optional()
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
      description: "Apply one or more image-edit instructions in a single blocking PwrSnap turn. By default, the completed response includes the current edited composite as an MCP resource link; set returnImage=false when another edit will follow.",
      inputSchema: {
        captureId: z.string().min(1),
        instruction: z.string().trim().min(1).max(20_000).optional(),
        instructions: z.array(z.string().trim().min(1).max(20_000)).min(1).max(20).optional(),
        provider: z.string().trim().min(1).max(200).optional(),
        model: z.string().trim().min(1).max(200).optional(),
        threadId: z.string().min(1).optional(),
        reuse: z.enum(["latest-compatible", "new"]).optional(),
        returnImage: z.boolean().default(true).optional(),
        preset: z.enum(["low", "med", "high"]).default("med").optional()
      },
      // The PwrSnap-owned Editor Chat agent must render the current composite
      // to ground its edits. Requiring the read capability at this outer
      // boundary prevents an edit-only Session from starting a turn whose
      // nested render_composite calls will inevitably be denied.
      requiredCapabilities: ["capture.edit", "capture.composite.read"],
      requiredCapabilitiesForInput: (input) => input.returnImage === false
        ? ["capture.edit", "capture.composite.read"]
        : ["capture.edit", "capture.composite.read", "capture.export"],
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      },
      dispatch: deps.imageEditSend
    });
  }
  const videoSpanSchema = z.object({
    start: z.number().min(0).describe("Span start, source seconds."),
    end: z.number().min(0).describe("Span end, source seconds; must be greater than start.")
  });
  if (deps.videoInspect !== undefined) {
    tools.push({
      name: "pwrsnap_video_inspect",
      title: "Inspect PwrSnap Video",
      description:
        "Read a video capture's duration, current edit (kept spans, cuts, exported length) and an on-screen activity summary: " +
        "run-length encoded activity levels plus the still stretches, so you can plan cuts without watching the video. " +
        VIDEO_EDIT_MODEL_GUIDANCE + " " + VIDEO_ACTIVITY_GUIDANCE,
      inputSchema: {
        captureId: z.string().min(1),
        minStillSec: z.number().min(0.2).max(3600)
          .describe("Only list still stretches at least this long. Defaults to 3.")
          .optional(),
        treatMinorAsStill: z.boolean()
          .describe("Count cursor movement and typing (level 1) as still. Defaults to false.")
          .optional(),
        includeTrack: z.boolean()
          .describe("Also return track: one digit (0–3) per sample at sampleHz. Dense; usually unnecessary.")
          .optional()
      },
      requiredCapabilities: ["library.read"],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      dispatch: deps.videoInspect
    });
  }
  if (deps.videoEdit !== undefined) {
    tools.push({
      name: "pwrsnap_video_edit",
      title: "Edit PwrSnap Video Cuts",
      description:
        "Change which parts of a video capture export. Set exactly one of: " +
        "keep (replace the edit with exactly these kept spans), " +
        "cut (remove spans from the current edit; composes with existing cuts), " +
        "cutStill (cut every stretch where nothing on screen changes for at least minStillSec, default 3, keeping paddingSec, default 0.5, next to each change), " +
        "or reset (restore the whole clip). Returns the resulting edit. " +
        VIDEO_EDIT_MODEL_GUIDANCE,
      inputSchema: {
        captureId: z.string().min(1),
        keep: z.array(videoSpanSchema).min(1).max(200)
          .describe("Kept spans, source seconds. Order and overlaps are normalized.")
          .optional(),
        cut: z.array(videoSpanSchema).min(1).max(200)
          .describe("Spans to remove, source seconds.")
          .optional(),
        cutStill: z.object({
          minStillSec: z.number().min(0.5).max(3600).optional(),
          paddingSec: z.number().min(0).max(10).optional(),
          treatMinorAsStill: z.boolean().optional()
        }).describe("Cut the still stretches found by pwrsnap_video_inspect.").optional(),
        reset: z.boolean().describe("true restores the whole clip.").optional()
      },
      requiredCapabilities: ["capture.edit"],
      annotations: {
        readOnlyHint: false,
        // Non-destructive: the recording is untouched and every edit is
        // reversible (reset, or undo in the Library).
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      dispatch: deps.videoEdit
    });
  }
  if (deps.captureDuplicate !== undefined) {
    tools.push({
      name: "pwrsnap_capture_duplicate",
      title: "Duplicate PwrSnap Capture",
      description:
        "Make an independent copy of a live capture: a new captureId with its own bundle, in the same duplicate family as the source. " +
        "withEdits is required. true carries the current edit (image: crop and annotations; video: trim and cuts); false copies only the original pixels or the full recording. " +
        "Title, description, tags and OCR are copied, with the title numbered within the family (\"… copy 2\"). The source is never changed. " +
        "Returns the copy's captureId and familyId; edit the copy with pwrsnap_image_edit_send or pwrsnap_video_edit. " +
        "pwrsnap_capture_edit_summary says what withEdits=true would carry.",
      inputSchema: {
        captureId: z.string().min(1),
        // No default: the Library remembers the user's last choice, and
        // that preference must never silently decide for an agent.
        withEdits: z.boolean()
          .describe("Required. true copies the current edit with the capture; false copies the unedited capture.")
      },
      requiredCapabilities: ["capture.edit"],
      annotations: {
        readOnlyHint: false,
        // Adds a capture; changes nothing that exists.
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      dispatch: deps.captureDuplicate
    });
  }
  if (deps.captureEditSummary !== undefined) {
    tools.push({
      name: "pwrsnap_capture_edit_summary",
      title: "Summarize PwrSnap Capture Edits",
      description:
        "Read what a capture's current edit consists of — crop, trim, cuts, and counts of arrows, shapes, highlights, blurs, texts, steps, pasted images and cursors — " +
        "which is exactly what pwrsnap_capture_duplicate with withEdits=true would carry. summary is a short readable line such as \"crop · 2 arrows · blur\", or null when hasEdits is false.",
      inputSchema: { captureId: z.string().min(1) },
      requiredCapabilities: [],
      requiredAnyCapabilities: ["library.read", "capture.edit"],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      dispatch: deps.captureEditSummary
    });
  }
  if (deps.captureFamilies !== undefined) {
    tools.push({
      name: "pwrsnap_capture_families",
      title: "List PwrSnap Capture Families",
      description:
        "List duplicate families — a capture and the copies made from it share a familyId, which is the original's captureId. " +
        "Only live captures are counted or listed. Ordered by each family's newest member, newest first. rootId is null when the original is no longer live. " +
        "Use pwrsnap_capture_family for one family's members with metadata.",
      inputSchema: {
        limit: z.number().int().min(1).max(LOCAL_AGENT_MCP_MAX_LIMIT)
          .describe(`Maximum families to return. Defaults to ${LOCAL_AGENT_MCP_DEFAULT_LIMIT}.`)
          .optional()
      },
      requiredCapabilities: ["library.read"],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      dispatch: deps.captureFamilies
    });
  }
  if (deps.captureFamily !== undefined) {
    tools.push({
      name: "pwrsnap_capture_family",
      title: "Read PwrSnap Capture Family",
      description:
        "List one duplicate family's live members, oldest first, as pwrsnap_library_search rows plus isRoot and duplicatedFrom (the capture each copy was made from). " +
        "familyId comes from pwrsnap_capture_families or pwrsnap_capture_duplicate.",
      inputSchema: {
        familyId: z.string().min(1).max(64),
        limit: z.number().int().min(1).max(LOCAL_AGENT_MCP_MAX_LIMIT)
          .describe(`Maximum members to return. Defaults to ${LOCAL_AGENT_MCP_DEFAULT_LIMIT}.`)
          .optional(),
        detail: z.enum(["summary", "enriched"])
          .describe("summary (default) omits generated text; enriched includes title, description and tags.")
          .optional()
      },
      requiredCapabilities: ["library.read"],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      dispatch: deps.captureFamily
    });
  }
  if (deps.sizzleCreate !== undefined) {
    tools.push({
      name: "pwrsnap_sizzle_create",
      title: "Create PwrSnap Sizzle Reel",
      description: "Create a Sizzle project from captures and optionally start its PwrSnap-owned composition chat. Returns a compact project receipt for follow-up tools.",
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
        MEDIA_DELIVERY_GUIDANCE,
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
        MEDIA_DELIVERY_GUIDANCE,
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
  const anyOf = tool.requiredAnyCapabilities ?? [];
  const missingAnyOf =
    anyOf.length > 0 && !anyOf.some((capability) => ctx.capabilities.includes(capability))
      ? anyOf
      : [];
  if (missing.length > 0 || missingAnyOf.length > 0) {
    return capabilityDenied(tool.name, missing, missingAnyOf);
  }
  return ok(undefined);
}
