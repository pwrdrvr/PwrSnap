import {
  err,
  formatCaptureEditSummary,
  ok,
  type CaptureExportRequest,
  type CaptureExportVariant,
  type CaptureRecord,
  type ChatMessage,
  type LocalAgentCapability,
  type PwrSnapError,
  type Result
} from "@pwrsnap/shared";
import { createHash } from "node:crypto";
import { duplicateAndAwaitCommit } from "../capture/await-duplicate";
import { bus } from "../command-bus";
import {
  LocalAgentMcpResourceRegistry,
  type LocalAgentMcpResource,
  type LocalAgentResourceReadContext
} from "./mcp-resource-registry";
import {
  captureNotBefore,
  isCapturedAtOrAfter,
  localAgentMcpResultLimit,
  pageLocalAgentMcpList,
  projectLocalAgentCapture,
  projectLocalAgentSearchRows
} from "./local-agent-search";
import { LocalAgentSignedUrlService } from "./signed-url";
import {
  type LocalAgentCaptureExportInput,
  type LocalAgentToolContext,
  withMcpResourceLink
} from "./mcp-tool-registry";

export class LocalAgentToolService {
  constructor(
    private readonly resources: LocalAgentMcpResourceRegistry,
    private readonly signedUrls: LocalAgentSignedUrlService,
    private readonly getBaseUrl: () => string | null,
    private readonly options: { duplicatePollMs?: number } = {}
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
    return ok({
      capture: projectLocalAgentCapture({
        record: capture.value,
        enrichment: enrichment.value,
        matchSnippet: null
      }),
      ocrLength: enrichment.value?.ocrText?.length ?? 0
    });
  }

  /** A receipt, not the record: the copy's id and family are what the
   *  agent needs to edit it next. Its title and tags are catalog metadata,
   *  read with `metadata` under `library.read` like any other capture. */
  async captureDuplicate(
    input: { captureId: string; withEdits: boolean },
    ctx: LocalAgentToolContext
  ): Promise<Result<unknown, PwrSnapError>> {
    // The handler maps not_found / trashed / unsupported / in_progress
    // itself, and broadcasts the commit so an open Library shows the copy.
    // A byte-copied video is waited out: the agent's next call edits it.
    const duplicated = await duplicateAndAwaitCommit(
      { captureId: input.captureId, withEdits: input.withEdits },
      ctx.commandContext,
      {
        signal: ctx.signal,
        ...(this.options.duplicatePollMs !== undefined
          ? { pollMs: this.options.duplicatePollMs }
          : {})
      }
    );
    if (!duplicated.ok) return duplicated;
    const { record } = duplicated.value;
    return ok({
      captureId: record.id,
      familyId: record.family_id ?? null,
      duplicatedFrom: record.duplicated_from ?? input.captureId,
      withEdits: input.withEdits,
      kind: record.kind,
      capturedAt: record.captured_at,
      widthPx: record.width_px,
      heightPx: record.height_px
    });
  }

  async captureEditSummary(
    input: { captureId: string },
    ctx: LocalAgentToolContext
  ): Promise<Result<unknown, PwrSnapError>> {
    const capture = await bus.dispatch(
      "library:byId",
      { id: input.captureId },
      ctx.commandContext
    );
    if (!capture.ok) return capture;
    if (capture.value === null) return notFound(input.captureId);
    // `capture:editSummary` answers for a trashed capture too; over MCP
    // it is the question "what would a duplicate carry", and a trashed
    // capture cannot be duplicated — say so with the duplicate's code.
    if (capture.value.deleted_at !== null) return trashed(input.captureId);
    const summary = await bus.dispatch(
      "capture:editSummary",
      { captureId: input.captureId },
      ctx.commandContext
    );
    if (!summary.ok) return summary;
    const text = formatCaptureEditSummary(summary.value);
    return ok({
      captureId: input.captureId,
      kind: capture.value.kind,
      ...summary.value,
      summary: text.length === 0 ? null : text
    });
  }

  async captureFamilies(
    input: { limit?: number | undefined; offset?: number | undefined },
    ctx: LocalAgentToolContext
  ): Promise<Result<unknown, PwrSnapError>> {
    const listed = await bus.dispatch("library:families", {}, ctx.commandContext);
    if (!listed.ok) return listed;
    const notBefore = captureNotBefore(ctx.commandContext.localAgent?.maxCaptureAgeDays);
    const end = (input.offset ?? 0) + localAgentMcpResultLimit(input);
    const families: Array<{
      familyId: string;
      rootId: string | null;
      memberIds: string[];
      memberCount: number;
      newestCapturedAt: string;
    }> = [];
    // `library:families` sorts by each family's newest LIVE member. That
    // member is also the newest one this role can see, or none of them is
    // visible, so filtering keeps the order and the walk can stop one past
    // the page. Families are rare (one per duplicated snap).
    for (const family of listed.value.families) {
      if (families.length > end) break;
      if (family.liveCount === 0) continue;
      if (notBefore !== undefined && !isCapturedAtOrAfter(family.newestCapturedAt, notBefore)) {
        continue;
      }
      const members = await this.visibleFamilyMembers(family.familyId, ctx, notBefore);
      if (!members.ok) return members;
      if (members.value.length === 0) continue;
      families.push({
        familyId: family.familyId,
        rootId: members.value.some((member) => member.id === family.familyId)
          ? family.familyId
          : null,
        memberIds: members.value.map((member) => member.id),
        memberCount: members.value.length,
        // Oldest first, so the last member is the newest.
        newestCapturedAt: members.value[members.value.length - 1]?.captured_at ?? ""
      });
    }
    const page = pageLocalAgentMcpList(families, input);
    return ok({ families: page.items, ...page.cursor });
  }

  async captureFamily(
    input: {
      familyId: string;
      limit?: number | undefined;
      offset?: number | undefined;
      detail?: "summary" | "enriched" | undefined;
    },
    ctx: LocalAgentToolContext
  ): Promise<Result<unknown, PwrSnapError>> {
    const notBefore = captureNotBefore(ctx.commandContext.localAgent?.maxCaptureAgeDays);
    const members = await this.visibleFamilyMembers(input.familyId, ctx, notBefore);
    if (!members.ok) return members;
    // A family whose every member is trashed or outside the role's window
    // is indistinguishable from one that does not exist, on purpose.
    if (members.value.length === 0) {
      return err({
        kind: "validation",
        code: "not_found",
        message: `capture family not found: ${input.familyId}`
      });
    }
    const page = pageLocalAgentMcpList(members.value, input);
    const detail = input.detail ?? "summary";
    const withMetadata = await bus.dispatch(
      "library:listByIdsWithMetadata",
      { ids: page.items.map((member) => member.id) },
      ctx.commandContext
    );
    if (!withMetadata.ok) return withMetadata;
    const byId = new Map(withMetadata.value.rows.map((row) => [row.record.id, row]));
    const rows = page.items.flatMap((member) => {
      const row = byId.get(member.id);
      return row === undefined ? [] : [{ ...row, matchSnippet: null }];
    });
    const projected = projectLocalAgentSearchRows(rows, detail);
    return ok({
      familyId: input.familyId,
      detail,
      ...page.cursor,
      members: projected.map((row, index) => ({
        ...row,
        isRoot: row.id === input.familyId,
        duplicatedFrom: rows[index]?.record.duplicated_from ?? null
      }))
    });
  }

  /** Live members this role may see, oldest first. */
  private async visibleFamilyMembers(
    familyId: string,
    ctx: LocalAgentToolContext,
    notBefore: string | undefined
  ): Promise<Result<CaptureRecord[], PwrSnapError>> {
    const family = await bus.dispatch("library:family", { familyId }, ctx.commandContext);
    if (!family.ok) return family;
    return ok(
      family.value.members.filter(
        (member) =>
          member.deleted_at === null &&
          (notBefore === undefined || isCapturedAtOrAfter(member.captured_at, notBefore))
      )
    );
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
      const resource = this.registerExportedResource({
        uri: `pwrsnap://capture/${encodeURIComponent(input.captureId)}/${variant}`,
        name: `${variant} capture`,
        mimeType: exported.mimeType,
        captureId: input.captureId,
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
      const deliveryUri = this.deliveryUri(resource, ctx.clientId);
      return ok(
        withMcpResourceLink(
          {
            variant,
            resourceUri: resource.uri,
            mimeType: exported.mimeType,
            widthPx: exported.widthPx,
            heightPx: exported.heightPx,
            byteSize: exported.byteSize
          },
          {
            uri: deliveryUri,
            name: resource.name,
            mimeType: resource.mimeType,
            size: exported.byteSize
          }
        )
      );
    } catch (cause) {
      return unexpectedError("capture_resource_failed", cause);
    }
  }

  async captureExport(
    input: LocalAgentCaptureExportInput,
    ctx: LocalAgentToolContext
  ): Promise<Result<unknown, PwrSnapError>> {
    const preset = input.preset ?? "med";
    const request: CaptureExportRequest = {
      captureId: input.captureId,
      variant: input.variant ?? "composite",
      format: input.format ?? "png",
      preset
    };
    const exportedResult = await bus.dispatch(
      "render:captureExport",
      request,
      ctx.commandContext
    );
    if (!exportedResult.ok) return exportedResult;
    const exported = exportedResult.value;
    try {
      const clientExportId = clientScopedId(exported.exportId, ctx.clientId);
      const resource = this.registerExportedResource({
        uri:
          `pwrsnap://capture/${encodeURIComponent(input.captureId)}` +
          `/export/${clientExportId}`,
        name: `${exported.format} capture export`,
        mimeType: exported.mimeType,
        captureId: input.captureId,
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
      const deliveryUri = this.deliveryUri(resource, ctx.clientId);
      return ok(
        withMcpResourceLink(
          {
            resourceUri: resource.uri,
            variant: exported.variant,
            format: exported.format,
            preset: exported.preset ?? preset,
            mimeType: exported.mimeType,
            widthPx: exported.widthPx,
            heightPx: exported.heightPx,
            byteSize: exported.byteSize,
            fromCache: exported.fromCache
          },
          {
            uri: deliveryUri,
            name: resource.name,
            mimeType: resource.mimeType,
            size: exported.byteSize
          }
        )
      );
    } catch (cause) {
      return unexpectedError("capture_export_failed", cause);
    }
  }

  async imageEditSend(
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
  ): Promise<Result<unknown, PwrSnapError>> {
    const instructions = [
      ...(input.instruction === undefined ? [] : [input.instruction]),
      ...(input.instructions ?? [])
    ].map((instruction) => instruction.trim()).filter((instruction) => instruction.length > 0);
    if (instructions.length === 0) {
      return err({
        kind: "validation",
        code: "missing_edit_instruction",
        message: "Provide instruction or instructions with at least one image edit."
      });
    }
    if (instructions.length > 20 || instructions.join("\n").length > 100_000) {
      return err({
        kind: "validation",
        code: "edit_instruction_limit",
        message: "Provide at most 20 image edits totaling no more than 100,000 characters."
      });
    }
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
    const historyBefore = await bus.dispatch(
      "codex:libraryChat:history",
      { threadId: thread.threadId },
      ctx.commandContext
    );
    if (!historyBefore.ok) return historyBefore;
    const sent = await bus.dispatch(
      "codex:libraryChat:send",
      {
        threadId: thread.threadId,
        text: editInstructionPrompt(instructions),
        anchorCaptureId: input.captureId
      },
      ctx.commandContext
    );
    if (!sent.ok) return sent;
    const completed = await bus.dispatch(
      "codex:libraryChat:wait",
      { threadId: thread.threadId, timeoutMs: 600_000 },
      ctx.commandContext
    );
    if (!completed.ok) return completed;
    const receipt = {
      threadId: thread.threadId,
      turnId: sent.value.turnId,
      status: completed.value.thread.status,
      provider: thread.provider,
      model: thread.model,
      editsApplied: instructions.length,
      assistantSummary: lastAssistantText(
        completed.value.messages.slice(historyBefore.value.messages.length)
      ),
      imageReturned: input.returnImage !== false
    };
    if (input.returnImage === false) return ok(receipt);
    const exported = await this.captureExport(
      {
        captureId: input.captureId,
        variant: "composite",
        preset: input.preset ?? "med",
        format: "png"
      },
      ctx
    );
    if (!exported.ok) return exported;
    if (exported.value === null || typeof exported.value !== "object") {
      return unexpectedError("image_edit_export_failed", "capture export returned no media");
    }
    return ok(Object.assign(exported.value, receipt));
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
        return ok({
          projectId: project.id,
          name: project.name,
          sceneCount: project.scenes.length,
          threadId: chat.value.threadId,
          turnId: null
        });
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
        projectId: project.id,
        name: project.name,
        sceneCount: project.scenes.length,
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
    const deliveryUri = this.deliveryUri(resource, ctx.clientId);
    return ok(
      withMcpResourceLink(
        {
          resourceUri: resource.uri,
          durationSec: rendered.value.durationSec,
          widthPx: rendered.value.widthPx,
          heightPx: rendered.value.heightPx,
          mimeType: "video/mp4"
        },
        {
          uri: deliveryUri,
          name: resource.name,
          mimeType: resource.mimeType
        }
      )
    );
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
    captureId: string;
    ownerClientId?: string;
    audit?: LocalAgentMcpResource["audit"];
    refresh: (context: LocalAgentResourceReadContext) => Promise<string>;
  }): LocalAgentMcpResource {
    return this.resources.register({
      uri: args.uri,
      name: args.name,
      mimeType: args.mimeType,
      requiredCapabilities: args.requiredCapabilities,
      captureId: args.captureId,
      ...(args.ownerClientId !== undefined
        ? { ownerClientId: args.ownerClientId }
        : {}),
      ...(args.audit !== undefined ? { audit: args.audit } : {}),
      resolvePath: args.refresh
    });
  }

  private deliveryUri(
    resource: LocalAgentMcpResource,
    clientId: string
  ): string {
    const baseUrl = this.getBaseUrl();
    if (baseUrl === null) return resource.uri;
    const signed = this.signedUrls.mint({
      baseUrl,
      resourceUri: resource.uri,
      clientId
    });
    return signed.url;
  }
}

function clientScopedId(resourceId: string, clientId: string): string {
  return createHash("sha256")
    .update(`${resourceId}\0${clientId}`)
    .digest("hex")
    .slice(0, 32);
}

function editInstructionPrompt(instructions: readonly string[]): string {
  if (instructions.length === 1) return instructions[0];
  return [
    "Apply all of these edits to the current capture in one turn:",
    ...instructions.map((instruction, index) => `${index + 1}. ${instruction}`)
  ].join("\n");
}

function lastAssistantText(messages: readonly ChatMessage[]): string | null {
  const message = [...messages].reverse().find((candidate) => candidate.role === "assistant");
  if (message === undefined) return null;
  const text = message.content
    .map((content) => content.kind === "text" ? content.text : "")
    .filter((content) => content.length > 0)
    .join("\n")
    .trim();
  return text.length === 0 ? null : text;
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

function trashed(captureId: string): Result<never, PwrSnapError> {
  return err({
    kind: "validation",
    code: "trashed",
    message: `capture is in Trash: ${captureId}`
  });
}
