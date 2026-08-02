import {
  err,
  ok,
  type CaptureExportFormat,
  type CaptureExportRequest,
  type CaptureExportVariant,
  type LocalAgentCapability,
  type PwrSnapError,
  type Result
} from "@pwrsnap/shared";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { bus } from "../command-bus";
import {
  LocalAgentMcpResourceRegistry,
  type LocalAgentMcpResource,
  type LocalAgentResourceReadContext
} from "./mcp-resource-registry";
import { projectLocalAgentCapture } from "./local-agent-search";
import { LocalAgentSignedUrlService } from "./signed-url";
import {
  type LocalAgentToolContext,
  withMcpSupplementalContent
} from "./mcp-tool-registry";

const INLINE_PREVIEW_MAX_EDGE_PX = 1_024;
const INLINE_PREVIEW_QUALITY = 72;

export class LocalAgentToolService {
  constructor(
    private readonly resources: LocalAgentMcpResourceRegistry,
    private readonly signedUrls: LocalAgentSignedUrlService,
    private readonly getBaseUrl: () => string | null
  ) {}

  async metadata(
    input: { captureId: string },
    ctx: LocalAgentToolContext
  ): Promise<Result<unknown, PwrSnapError>> {
    const [capture, enrichment] = await Promise.all([
      bus.dispatch("library:byId", { id: input.captureId }, ctx.commandContext),
      bus.dispatch("codex:enrichment", { captureId: input.captureId }, ctx.commandContext)
    ]);
    if (!capture.ok) return capture;
    if (!enrichment.ok) return enrichment;
    if (capture.value === null || capture.value.deleted_at !== null) {
      return notFound(input.captureId);
    }
    const availableResources: Array<{ variant: CaptureExportVariant; uri: string }> = [];
    if (capture.value.kind === "image" && ctx.capabilities.includes("capture.composite.read")) {
      const resource = this.registerCaptureResource(
        input.captureId,
        "composite"
      );
      availableResources.push({ variant: "composite", uri: resource.uri });
    }
    if (capture.value.kind === "image" && ctx.capabilities.includes("capture.original.read")) {
      const resource = this.registerCaptureResource(
        input.captureId,
        "original"
      );
      availableResources.push({ variant: "original", uri: resource.uri });
    }
    return ok({
      capture: projectLocalAgentCapture({
        record: capture.value,
        enrichment: enrichment.value,
        matchSnippet: null
      }),
      ocrLength: enrichment.value?.ocrText?.length ?? 0,
      availableResources
    });
  }

  async captureResource(
    input: { captureId: string; variant?: CaptureExportVariant | undefined },
    ctx: LocalAgentToolContext
  ): Promise<Result<unknown, PwrSnapError>> {
    const variant = input.variant ?? "composite";
    const exportedResult = await bus.dispatch(
      "render:captureExport",
      {
        captureId: input.captureId,
        variant,
        format: "png"
      },
      ctx.commandContext
    );
    if (!exportedResult.ok) return exportedResult;
    const exported = exportedResult.value;
    try {
      const preview = await this.renderInlinePreview(
        input.captureId,
        variant,
        exported.widthPx,
        exported.heightPx,
        ctx
      );
      if (!preview.ok) return preview;
      const resource = this.registerExportedResource({
        uri: `pwrsnap://capture/${encodeURIComponent(input.captureId)}/${variant}`,
        name: `${variant} capture`,
        mimeType: exported.mimeType,
        requiredCapabilities: [readCapabilityForVariant(variant)],
        ...(variant === "original"
          ? {
              audit: {
                action: "capture.original.read" as const,
                capability: "capture.original.read" as const,
                subjectKind: "capture" as const,
                subjectId: input.captureId
              }
            }
          : {}),
        refresh: (readContext) => this.refreshExport(
          { captureId: input.captureId, variant, format: "png" },
          toolContextForRead(readContext)
        )
      });
      return ok(withMcpSupplementalContent({
        variant,
        resourceUri: resource.uri,
        ...this.signedDescriptor(resource, ctx.clientId),
        mimeType: exported.mimeType,
        widthPx: exported.widthPx,
        heightPx: exported.heightPx,
        byteSize: exported.byteSize,
        inlinePreview: preview.value.descriptor
      }, [preview.value.content]));
    } catch (cause) {
      return unexpectedError("capture_resource_failed", cause);
    }
  }

  async captureExport(
    input: {
      captureId: string;
      variant?: CaptureExportVariant | undefined;
      format?: CaptureExportFormat | undefined;
      maxWidth?: number | undefined;
      maxHeight?: number | undefined;
      scale?: number | undefined;
      quality?: number | undefined;
      background?: string | undefined;
    },
    ctx: LocalAgentToolContext
  ): Promise<Result<unknown, PwrSnapError>> {
    const request: CaptureExportRequest = {
      captureId: input.captureId,
      ...(input.variant !== undefined ? { variant: input.variant } : {}),
      ...(input.format !== undefined ? { format: input.format } : {}),
      ...(input.maxWidth !== undefined ? { maxWidth: input.maxWidth } : {}),
      ...(input.maxHeight !== undefined ? { maxHeight: input.maxHeight } : {}),
      ...(input.scale !== undefined ? { scale: input.scale } : {}),
      ...(input.quality !== undefined ? { quality: input.quality } : {}),
      ...(input.background !== undefined ? { background: input.background } : {})
    };
    const exportedResult = await bus.dispatch(
      "render:captureExport",
      request,
      ctx.commandContext
    );
    if (!exportedResult.ok) return exportedResult;
    const exported = exportedResult.value;
    try {
      const preview = await this.renderInlinePreview(
        input.captureId,
        exported.variant,
        exported.widthPx,
        exported.heightPx,
        ctx,
        input.background
      );
      if (!preview.ok) return preview;
      const clientExportId = clientScopedId(exported.exportId, ctx.clientId);
      const resource = this.registerExportedResource({
        uri:
          `pwrsnap://capture/${encodeURIComponent(input.captureId)}` +
          `/export/${clientExportId}`,
        name: `${exported.format} capture export`,
        mimeType: exported.mimeType,
        requiredCapabilities: [
          "capture.export",
          readCapabilityForVariant(exported.variant)
        ],
        ownerClientId: ctx.clientId,
        ...(exported.variant === "original"
          ? {
              audit: {
                action: "capture.original.read" as const,
                capability: "capture.original.read" as const,
                subjectKind: "capture" as const,
                subjectId: input.captureId
              }
            }
          : {}),
        refresh: (readContext) =>
          this.refreshExport(request, toolContextForRead(readContext))
      });
      return ok(withMcpSupplementalContent({
        resourceUri: resource.uri,
        ...this.signedDescriptor(resource, ctx.clientId),
        variant: exported.variant,
        format: exported.format,
        mimeType: exported.mimeType,
        widthPx: exported.widthPx,
        heightPx: exported.heightPx,
        byteSize: exported.byteSize,
        fromCache: exported.fromCache,
        inlinePreview: preview.value.descriptor
      }, [preview.value.content]));
    } catch (cause) {
      return unexpectedError("capture_export_failed", cause);
    }
  }

  private async renderInlinePreview(
    captureId: string,
    variant: CaptureExportVariant,
    widthPx: number,
    heightPx: number,
    ctx: LocalAgentToolContext,
    background?: string
  ): Promise<Result<{
    descriptor: {
      mimeType: "image/jpeg";
      widthPx: number;
      heightPx: number;
      byteSize: number;
    };
    content: {
      type: "image";
      data: string;
      mimeType: "image/jpeg";
    };
  }, PwrSnapError>> {
    const previewResult = await bus.dispatch(
      "render:captureExport",
      {
        captureId,
        variant,
        format: "jpeg",
        maxWidth: Math.min(widthPx, INLINE_PREVIEW_MAX_EDGE_PX),
        maxHeight: Math.min(heightPx, INLINE_PREVIEW_MAX_EDGE_PX),
        quality: INLINE_PREVIEW_QUALITY,
        ...(background !== undefined ? { background } : {})
      },
      ctx.commandContext
    );
    if (!previewResult.ok) return previewResult;
    try {
      const bytes = await readFile(previewResult.value.path);
      return ok({
        descriptor: {
          mimeType: "image/jpeg",
          widthPx: previewResult.value.widthPx,
          heightPx: previewResult.value.heightPx,
          byteSize: bytes.byteLength
        },
        content: {
          type: "image",
          data: bytes.toString("base64"),
          mimeType: "image/jpeg"
        }
      });
    } catch (cause) {
      return unexpectedError("inline_preview_failed", cause);
    }
  }

  async imageEditSend(
    input: {
      captureId: string;
      instruction: string;
      provider?: string | undefined;
      model?: string | undefined;
      threadId?: string | undefined;
      reuse?: "latest-compatible" | "new" | undefined;
    },
    ctx: LocalAgentToolContext
  ): Promise<Result<unknown, PwrSnapError>> {
    const capture = await bus.dispatch(
      "library:byId",
      { id: input.captureId },
      ctx.commandContext
    );
    if (!capture.ok) return capture;
    if (capture.value === null || capture.value.deleted_at !== null) {
      return notFound(input.captureId);
    }
    if (capture.value.kind !== "image") {
      return err({
        kind: "validation",
        code: "not_an_image",
        message: "image edit requests require an image capture"
      });
    }
    const listed = await bus.dispatch(
      "codex:libraryChat:list",
      { anchorCaptureId: input.captureId },
      ctx.commandContext
    );
    if (!listed.ok) return listed;
    let thread = input.threadId === undefined
      ? undefined
      : listed.value.threads.find((candidate) => candidate.threadId === input.threadId);
    if (input.threadId !== undefined && thread === undefined) {
      return err({
        kind: "validation",
        code: "thread_anchor_mismatch",
        message: "the requested thread is not anchored to this capture"
      });
    }
    if (
      thread !== undefined &&
      input.provider !== undefined &&
      thread.provider !== input.provider
    ) {
      return err({
        kind: "validation",
        code: "thread_provider_mismatch",
        message: `thread uses ${thread.provider ?? "an unspecified provider"}, not ${input.provider}`
      });
    }
    if (
      thread !== undefined &&
      input.model !== undefined &&
      thread.model !== input.model
    ) {
      return err({
        kind: "validation",
        code: "thread_model_mismatch",
        message: `thread uses ${thread.model}, not ${input.model}`
      });
    }
    if (thread === undefined && (input.reuse ?? "latest-compatible") !== "new") {
      thread = listed.value.threads
        .filter((candidate) =>
          (input.provider === undefined || candidate.provider === input.provider) &&
          (input.model === undefined || candidate.model === input.model)
        )
        .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))[0];
    }
    if (thread === undefined) {
      const created = await bus.dispatch(
        "codex:libraryChat:create",
        {
          name: `External edit ${new Date().toLocaleDateString()}`,
          anchorCaptureId: input.captureId,
          ...(input.provider !== undefined ? { provider: input.provider } : {}),
          ...(input.model !== undefined ? { model: input.model } : {})
        },
        ctx.commandContext
      );
      if (!created.ok) return created;
      thread = created.value;
    }
    const sent = await bus.dispatch(
      "codex:libraryChat:send",
      {
        threadId: thread.threadId,
        text: input.instruction,
        anchorCaptureId: input.captureId
      },
      ctx.commandContext
    );
    if (!sent.ok) return sent;
    const preview = this.registerEditPreviewResource(
      input.captureId,
      thread.threadId,
      ctx
    );
    return ok({
      threadId: thread.threadId,
      turnId: sent.value.turnId,
      status: { kind: "streaming", turnId: sent.value.turnId },
      provider: thread.provider,
      model: thread.model,
      compositePreviewResourceUri: preview.uri,
      ...this.signedDescriptor(preview, ctx.clientId)
    });
  }

  async imageEditStatus(
    input: { captureId: string; threadId: string },
    ctx: LocalAgentToolContext
  ): Promise<Result<unknown, PwrSnapError>> {
    const listed = await bus.dispatch(
      "codex:libraryChat:list",
      { anchorCaptureId: input.captureId },
      ctx.commandContext
    );
    if (!listed.ok) return listed;
    const thread = listed.value.threads.find(
      (candidate) => candidate.threadId === input.threadId
    );
    if (thread === undefined) {
      return err({
        kind: "validation",
        code: "thread_anchor_mismatch",
        message: "the requested thread is not anchored to this capture"
      });
    }
    const preview = this.registerEditPreviewResource(
      input.captureId,
      thread.threadId,
      ctx
    );
    return ok({
      threadId: thread.threadId,
      status: thread.status,
      compositePreviewResourceUri: preview.uri,
      ...(thread.status.kind === "idle"
        ? this.signedDescriptor(preview, ctx.clientId)
        : {})
    });
  }

  async sizzleCreate(
    input: {
      name: string;
      captureIds: string[];
      brief?: string | undefined;
      provider?: string | undefined;
      model?: string | undefined;
    },
    ctx: LocalAgentToolContext
  ): Promise<Result<unknown, PwrSnapError>> {
    const captureIds = [...new Set(input.captureIds)];
    for (const captureId of captureIds) {
      const capture = await bus.dispatch(
        "library:byId",
        { id: captureId },
        ctx.commandContext
      );
      if (!capture.ok) return capture;
      if (capture.value === null || capture.value.deleted_at !== null) {
        return notFound(captureId);
      }
    }
    const created = await bus.dispatch(
      "sizzle:create",
      { name: input.name },
      ctx.commandContext
    );
    if (!created.ok) return created;
    let project = created.value;
    try {
      for (const captureId of captureIds) {
        const toggled = await bus.dispatch(
          "sizzle:toggleScene",
          { projectId: project.id, captureId },
          ctx.commandContext
        );
        if (!toggled.ok) {
          await bus.dispatch("sizzle:delete", { id: project.id }, ctx.commandContext);
          return toggled;
        }
        project = toggled.value;
      }
      const chat = await bus.dispatch(
        "codex:sizzleChat:create",
        {
          name: `${input.name} composition`,
          anchorCaptureId: project.id,
          ...(input.provider !== undefined ? { provider: input.provider } : {}),
          ...(input.model !== undefined ? { model: input.model } : {})
        },
        ctx.commandContext
      );
      if (!chat.ok) {
        await bus.dispatch("sizzle:delete", { id: project.id }, ctx.commandContext);
        return chat;
      }
      if (input.brief === undefined) {
        return ok({ project, threadId: chat.value.threadId, turnId: null });
      }
      const sent = await bus.dispatch(
        "codex:sizzleChat:send",
        {
          threadId: chat.value.threadId,
          text: input.brief,
          anchorCaptureId: project.id
        },
        ctx.commandContext
      );
      if (!sent.ok) {
        await bus.dispatch("sizzle:delete", { id: project.id }, ctx.commandContext);
        return sent;
      }
      return ok({
        project,
        threadId: chat.value.threadId,
        turnId: sent.value.turnId
      });
    } catch (cause) {
      await bus.dispatch("sizzle:delete", { id: project.id }, ctx.commandContext);
      return err({
        kind: "unknown",
        code: "sizzle_create_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
    }
  }

  async sizzleSend(
    input: { projectId: string; instruction: string; threadId?: string | undefined },
    ctx: LocalAgentToolContext
  ): Promise<Result<unknown, PwrSnapError>> {
    const projects = await bus.dispatch("sizzle:list", {}, ctx.commandContext);
    if (!projects.ok) return projects;
    if (!projects.value.projects.some((project) => project.id === input.projectId)) {
      return err({
        kind: "validation",
        code: "not_found",
        message: `Sizzle project not found: ${input.projectId}`
      });
    }
    const listed = await bus.dispatch(
      "codex:sizzleChat:list",
      { anchorCaptureId: input.projectId },
      ctx.commandContext
    );
    if (!listed.ok) return listed;
    let thread = input.threadId === undefined
      ? listed.value.threads
          .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))[0]
      : listed.value.threads.find((candidate) => candidate.threadId === input.threadId);
    if (input.threadId !== undefined && thread === undefined) {
      return err({
        kind: "validation",
        code: "thread_anchor_mismatch",
        message: "the requested Sizzle thread is not anchored to this project"
      });
    }
    if (thread === undefined) {
      const created = await bus.dispatch(
        "codex:sizzleChat:create",
        {
          name: "External Sizzle composition",
          anchorCaptureId: input.projectId
        },
        ctx.commandContext
      );
      if (!created.ok) return created;
      thread = created.value;
    }
    const sent = await bus.dispatch(
      "codex:sizzleChat:send",
      {
        threadId: thread.threadId,
        text: input.instruction,
        anchorCaptureId: input.projectId
      },
      ctx.commandContext
    );
    if (!sent.ok) return sent;
    return ok({ threadId: thread.threadId, turnId: sent.value.turnId });
  }

  async sizzleStatus(
    input: { projectId: string; threadId: string },
    ctx: LocalAgentToolContext
  ): Promise<Result<unknown, PwrSnapError>> {
    const listed = await bus.dispatch(
      "codex:sizzleChat:list",
      { anchorCaptureId: input.projectId },
      ctx.commandContext
    );
    if (!listed.ok) return listed;
    const thread = listed.value.threads.find(
      (candidate) => candidate.threadId === input.threadId
    );
    if (thread === undefined) {
      return err({
        kind: "validation",
        code: "thread_anchor_mismatch",
        message: "the requested Sizzle thread is not anchored to this project"
      });
    }
    return ok({ threadId: thread.threadId, status: thread.status });
  }

  async sizzleRender(
    input: { projectId: string },
    ctx: LocalAgentToolContext,
    mode: "preview" | "full"
  ): Promise<Result<unknown, PwrSnapError>> {
    const rendered = await bus.dispatch(
      "sizzle:render",
      { id: input.projectId, mode },
      ctx.commandContext
    );
    if (!rendered.ok) return rendered;
    const capability: LocalAgentCapability =
      mode === "preview" ? "sizzle.preview.read" : "sizzle.full.read";
    const uri =
      `pwrsnap://sizzle/${encodeURIComponent(input.projectId)}/` +
      `${mode}/${encodeURIComponent(
        clientScopedId(rendered.value.renderId, ctx.clientId)
      )}`;
    const resource = this.resources.register({
      uri,
      name: `${mode} Sizzle render`,
      mimeType: "video/mp4",
      requiredCapabilities: [capability],
      ownerClientId: ctx.clientId,
      resolvePath: async () => rendered.value.outputPath
    });
    return ok({
      resourceUri: resource.uri,
      ...this.signedDescriptor(resource, ctx.clientId),
      durationSec: rendered.value.durationSec,
      widthPx: rendered.value.widthPx,
      heightPx: rendered.value.heightPx,
      mimeType: "video/mp4"
    });
  }

  private registerCaptureResource(
    captureId: string,
    variant: CaptureExportVariant
  ): LocalAgentMcpResource {
    return this.resources.register({
      uri: `pwrsnap://capture/${encodeURIComponent(captureId)}/${variant}`,
      name: `${variant} capture`,
      mimeType: "image/png",
      requiredCapabilities: [readCapabilityForVariant(variant)],
      ...(variant === "original"
        ? {
            audit: {
              action: "capture.original.read" as const,
              capability: "capture.original.read" as const,
              subjectKind: "capture" as const,
              subjectId: captureId
            }
          }
        : {}),
      resolvePath: (readContext) =>
        this.refreshExport(
          { captureId, variant, format: "png" },
          toolContextForRead(readContext)
        )
    });
  }

  private registerEditPreviewResource(
    captureId: string,
    threadId: string,
    ctx: LocalAgentToolContext
  ): LocalAgentMcpResource {
    const uri =
      `pwrsnap://capture/${encodeURIComponent(captureId)}/edit/` +
      `${clientScopedId(threadId, ctx.clientId)}/composite`;
    return this.resources.register({
      uri,
      name: "completed image edit composite",
      mimeType: "image/png",
      requiredCapabilities: ["capture.edit", "capture.composite.read"],
      ownerClientId: ctx.clientId,
      resolvePath: async (readContext) => {
        const readCtx = toolContextForRead(readContext);
        const listed = await bus.dispatch(
          "codex:libraryChat:list",
          { anchorCaptureId: captureId },
          readCtx.commandContext
        );
        if (!listed.ok) throw new Error(listed.error.message);
        const thread = listed.value.threads.find(
          (candidate) => candidate.threadId === threadId
        );
        if (thread === undefined) {
          throw new Error("edit thread is no longer anchored to this capture");
        }
        if (thread.status.kind !== "idle") {
          throw new Error("edit is not complete");
        }
        return this.refreshExport({
          captureId,
          variant: "composite",
          format: "png"
        }, readCtx);
      }
    });
  }

  private async refreshExport(
    request: CaptureExportRequest,
    ctx: LocalAgentToolContext
  ): Promise<string> {
    const result = await bus.dispatch(
      "render:captureExport",
      request,
      ctx.commandContext
    );
    if (!result.ok) throw new Error(result.error.message);
    return result.value.path;
  }

  private registerExportedResource(args: {
    uri: string;
    name: string;
    mimeType: string;
    requiredCapabilities: readonly LocalAgentCapability[];
    ownerClientId?: string;
    audit?: LocalAgentMcpResource["audit"];
    refresh: (context: LocalAgentResourceReadContext) => Promise<string>;
  }): LocalAgentMcpResource {
    return this.resources.register({
      uri: args.uri,
      name: args.name,
      mimeType: args.mimeType,
      requiredCapabilities: args.requiredCapabilities,
      ...(args.ownerClientId !== undefined
        ? { ownerClientId: args.ownerClientId }
        : {}),
      ...(args.audit !== undefined ? { audit: args.audit } : {}),
      resolvePath: args.refresh
    });
  }

  private signedDescriptor(
    resource: LocalAgentMcpResource,
    clientId: string
  ): { signedUrl?: string; signedUrlExpiresAt?: string } {
    const baseUrl = this.getBaseUrl();
    if (baseUrl === null) return {};
    const signed = this.signedUrls.mint({
      baseUrl,
      resourceUri: resource.uri,
      clientId
    });
    return {
      signedUrl: signed.url,
      signedUrlExpiresAt: signed.expiresAt
    };
  }
}

function clientScopedId(resourceId: string, clientId: string): string {
  return createHash("sha256")
    .update(`${resourceId}\0${clientId}`)
    .digest("hex")
    .slice(0, 32);
}

function toolContextForRead(
  context: LocalAgentResourceReadContext
): LocalAgentToolContext {
  const signal = new AbortController().signal;
  return {
    clientId: context.clientId,
    capabilities: context.capabilities,
    signal,
    commandContext: {
      principal: "mcp",
      signal,
      localAgent: {
        clientId: context.clientId,
        capabilities: context.capabilities
      }
    }
  };
}

function readCapabilityForVariant(
  variant: CaptureExportVariant
): LocalAgentCapability {
  return variant === "original"
    ? "capture.original.read"
    : "capture.composite.read";
}

function unexpectedError(
  code: string,
  cause: unknown
): Result<never, PwrSnapError> {
  return err({
    kind: "unknown",
    code,
    message: cause instanceof Error ? cause.message : String(cause),
    cause
  });
}

function notFound(captureId: string): Result<never, PwrSnapError> {
  return err({
    kind: "validation",
    code: "not_found",
    message: `capture not found: ${captureId}`
  });
}
