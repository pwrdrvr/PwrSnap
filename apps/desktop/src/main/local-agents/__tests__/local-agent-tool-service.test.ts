import { ok, type CommandName, type LocalAgentCapability } from "@pwrsnap/shared";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { bus, type CommandContext } from "../../command-bus";
import { LocalAgentToolService } from "../local-agent-tool-service";
import { LocalAgentMcpResourceRegistry } from "../mcp-resource-registry";
import { LocalAgentSignedUrlService } from "../signed-url";
import {
  type LocalAgentToolContext,
  toMcpToolResult
} from "../mcp-tool-registry";

const registered: CommandName[] = [];
const grantCapabilities = new Map<string, readonly LocalAgentCapability[]>();

beforeEach(() => {
  bus.installLocalAgentAuthorizer(async (clientId) => {
    const capabilities = grantCapabilities.get(clientId);
    return capabilities === undefined ? null : { clientId, capabilities };
  });
});

afterEach(() => {
  for (const command of registered.splice(0)) bus.unregister(command);
  grantCapabilities.clear();
  bus.uninstallLocalAgentAuthorizerForTests();
});

function register(command: CommandName, handler: (req: any) => Promise<any>): void {
  bus.register(command as never, handler as never);
  registered.push(command);
}

function context(
  clientId = "lag_test",
  capabilities: readonly LocalAgentCapability[] = ["capture.edit", "sizzle.compose"]
): LocalAgentToolContext {
  grantCapabilities.set(clientId, capabilities);
  const signal = new AbortController().signal;
  const commandContext: CommandContext = {
    principal: "mcp",
    signal,
    localAgent: { clientId, capabilities }
  };
  return { clientId, capabilities, signal, commandContext };
}

function thread(args: {
  id: string;
  anchor: string;
  model?: string;
  modifiedAt: string;
  status?: { kind: "idle" } | { kind: "streaming"; turnId: string };
}): any {
  return {
    threadId: args.id,
    name: args.id,
    anchorCaptureId: args.anchor,
    model: args.model ?? null,
    provider: "codex",
    reasoning: null,
    createdAt: args.modifiedAt,
    modifiedAt: args.modifiedAt,
    archived: false,
    pinned: false,
    lastMessagePreview: "",
    status: args.status ?? { kind: "idle" }
  };
}

function service(
  resources = new LocalAgentMcpResourceRegistry(),
  baseUrl: string | null = null
): LocalAgentToolService {
  return new LocalAgentToolService(
    resources,
    new LocalAgentSignedUrlService(Buffer.alloc(32, 7)),
    () => baseUrl
  );
}

describe("LocalAgentToolService metadata", () => {
  test("does not register a competing media route from metadata", async () => {
    register("library:byId", async () =>
      ok({ id: "cap_1", kind: "image", deleted_at: null })
    );
    register("codex:enrichment", async () => ok(null));
    const resources = new LocalAgentMcpResourceRegistry();

    const result = await service(resources).metadata(
      { captureId: "cap_1" },
      context("lag_metadata", [
        "library.read",
        "capture.composite.read",
        "capture.original.read"
      ])
    );

    expect(result).toMatchObject({
      ok: true
    });
    if (!result.ok) return;
    expect(result.value).not.toHaveProperty("availableResources");
    expect(resources.get("pwrsnap://capture/cap_1/composite")).toBeUndefined();
    expect(resources.get("pwrsnap://capture/cap_1/original")).toBeUndefined();
  });
});

describe("LocalAgentToolService media delivery", () => {
  test("returns a direct resource link without embedding image bytes", async () => {
    const requests: unknown[] = [];
    register("render:captureExport", async (request) => {
      requests.push(request);
      return ok({
        captureId: "cap_1",
        variant: "composite",
        format: "png",
        path: "/tmp/capture.png",
        mimeType: "image/png",
        widthPx: 2_880,
        heightPx: 1_920,
        byteSize: 10,
        fromCache: false,
        exportId: "full"
      });
    });

    const result = await service(
      new LocalAgentMcpResourceRegistry(),
      "http://127.0.0.1:51729"
    ).captureResource(
      { captureId: "cap_1" },
      context("lag_preview", ["capture.composite.read"])
    );
    const mcpResult = toMcpToolResult(result);

    expect(requests).toEqual([
      {
        captureId: "cap_1",
        variant: "composite",
        format: "png"
      }
    ]);
    expect(mcpResult.structuredContent).toEqual(expect.objectContaining({
      resourceUri: "pwrsnap://capture/cap_1/composite",
      mimeType: "image/png",
      widthPx: 2_880,
      heightPx: 1_920,
      byteSize: 10
    }));
    expect(mcpResult.structuredContent).not.toHaveProperty("signedUrl");
    expect(mcpResult.structuredContent).not.toHaveProperty("resourceLinkExpiresAt");
    expect(mcpResult.content[1]).toMatchObject({
      type: "resource_link",
      uri: expect.stringMatching(/^http:\/\/127\.0\.0\.1:51729\/media\?/u),
      name: "composite capture",
      mimeType: "image/png",
      size: 10
    });
    expect(mcpResult.content[0]).toEqual({
      type: "text",
      text: "PwrSnap media is ready in the attached resource link. Pass that link directly to the client media handler."
    });
    expect(JSON.stringify(mcpResult.structuredContent)).not.toContain("/media?");
    expect(mcpResult.content.some((content) => content.type === "image")).toBe(false);
  });

  test("exports only through named PwrSnap sizes with owned defaults", async () => {
    const requests: unknown[] = [];
    register("render:captureExport", async (request) => {
      requests.push(request);
      return ok({
        captureId: "cap_1",
        variant: "composite",
        format: "png",
        preset: "med",
        path: "/tmp/capture-med.png",
        mimeType: "image/png",
        widthPx: 1_440,
        heightPx: 960,
        byteSize: 10,
        fromCache: false,
        exportId: "med"
      });
    });

    const result = await service().captureExport(
      { captureId: "cap_1" },
      context("lag_export", ["capture.export", "capture.composite.read"])
    );

    expect(requests).toEqual([
      {
        captureId: "cap_1",
        variant: "composite",
        format: "png",
        preset: "med"
      }
    ]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        variant: "composite",
        format: "png",
        preset: "med",
        widthPx: 1_440,
        heightPx: 960
      }
    });
  });
});

describe("LocalAgentToolService image edits", () => {
  test("reuses the latest model-compatible capture thread and reports status without a media route", async () => {
    let status: { kind: "idle" } | { kind: "streaming"; turnId: string } = {
      kind: "streaming",
      turnId: "turn_existing"
    };
    const sends: any[] = [];
    register("library:byId", async () =>
      ok({ id: "cap_1", kind: "image", deleted_at: null })
    );
    register("codex:libraryChat:list", async () =>
      ok({
        threads: [
          thread({
            id: "th_old",
            anchor: "cap_1",
            model: "gpt-5.5",
            modifiedAt: "2026-01-01T00:00:00.000Z"
          }),
          thread({
            id: "th_latest",
            anchor: "cap_1",
            model: "gpt-5.5",
            modifiedAt: "2026-02-01T00:00:00.000Z",
            status
          }),
          thread({
            id: "th_other_model",
            anchor: "cap_1",
            model: "kimi",
            modifiedAt: "2026-03-01T00:00:00.000Z"
          })
        ]
      })
    );
    register("codex:libraryChat:send", async (req) => {
      sends.push(req);
      return ok({ turnId: "turn_new" });
    });

    const toolService = service();
    const sent = await toolService.imageEditSend(
      {
        captureId: "cap_1",
        instruction: "add an arrow",
        model: "gpt-5.5"
      },
      context()
    );

    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    expect(sent.value).toMatchObject({
      threadId: "th_latest",
      turnId: "turn_new",
      status: { kind: "streaming", turnId: "turn_new" }
    });
    expect(sent.value).not.toHaveProperty("compositePreviewResourceUri");
    expect(sends).toEqual([
      {
        threadId: "th_latest",
        text: "add an arrow",
        anchorCaptureId: "cap_1"
      }
    ]);
    status = { kind: "idle" };
    const completed = await toolService.imageEditStatus(
      { captureId: "cap_1", threadId: "th_latest" },
      context()
    );
    expect(completed).toEqual(ok({
      threadId: "th_latest",
      status: { kind: "idle" }
    }));
    const completedMcp = toMcpToolResult(completed);
    expect(completedMcp.content).toEqual([
      {
        type: "text",
        text: "PwrSnap operation completed. See structuredContent for result fields."
      }
    ]);
    expect(completedMcp.structuredContent).not.toHaveProperty("resourceUri");
  });

  test("reports a trashed capture before polling its edit thread", async () => {
    register("library:byId", async () =>
      ok({ id: "cap_trashed", kind: "image", deleted_at: "2026-08-02T12:00:00.000Z" })
    );

    const result = await service().imageEditStatus(
      { captureId: "cap_trashed", threadId: "th_edit" },
      context()
    );

    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  test("rejects an explicit thread from another capture", async () => {
    register("library:byId", async () =>
      ok({ id: "cap_1", kind: "image", deleted_at: null })
    );
    register("codex:libraryChat:list", async () => ok({ threads: [] }));

    const result = await service().imageEditSend(
      {
        captureId: "cap_1",
        threadId: "th_elsewhere",
        instruction: "make it thicker"
      },
      context()
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "thread_anchor_mismatch" }
    });
  });

  test("creates a PwrSnap-owned thread with the requested provider and model", async () => {
    const creates: any[] = [];
    register("library:byId", async () =>
      ok({ id: "cap_1", kind: "image", deleted_at: null })
    );
    register("codex:libraryChat:list", async () => ok({ threads: [] }));
    register("codex:libraryChat:create", async (req) => {
      creates.push(req);
      return ok(thread({
        id: "th_kimi",
        anchor: "cap_1",
        model: "kimi-k2",
        modifiedAt: "2026-03-01T00:00:00.000Z"
      }));
    });
    register("codex:libraryChat:send", async () => ok({ turnId: "turn_kimi" }));

    const result = await service().imageEditSend(
      {
        captureId: "cap_1",
        instruction: "add an arrow",
        provider: "acp:kimi",
        model: "kimi-k2"
      },
      context()
    );

    expect(result).toMatchObject({
      ok: true,
      value: { threadId: "th_kimi", turnId: "turn_kimi" }
    });
    expect(creates).toEqual([
      expect.objectContaining({
        anchorCaptureId: "cap_1",
        provider: "acp:kimi",
        model: "kimi-k2"
      })
    ]);
  });
});

describe("LocalAgentToolService Sizzle workflows", () => {
  test("creates scenes in input order and starts a project-scoped composition turn", async () => {
    const calls: Array<{ command: string; req: any }> = [];
    let scenes: Array<{ captureId: string }> = [];
    register("library:byId", async (req) =>
      ok({ id: req.id, kind: "image", deleted_at: null })
    );
    register("sizzle:create", async (req) => {
      calls.push({ command: "create", req });
      return ok({
        id: "sz_1",
        name: req.name,
        scenes,
        outputPath: "/Users/person/private/reel.mp4"
      });
    });
    register("sizzle:toggleScene", async (req) => {
      calls.push({ command: "toggle", req });
      scenes = [...scenes, { captureId: req.captureId }];
      return ok({
        id: "sz_1",
        name: "Launch",
        scenes,
        outputPath: "/Users/person/private/reel.mp4"
      });
    });
    register("codex:sizzleChat:create", async (req) => {
      calls.push({ command: "chat-create", req });
      return ok(thread({
        id: "th_sizzle",
        anchor: "sz_1",
        model: "gpt-5.5",
        modifiedAt: "2026-03-01T00:00:00.000Z"
      }));
    });
    register("codex:sizzleChat:send", async (req) => {
      calls.push({ command: "chat-send", req });
      return ok({ turnId: "turn_1" });
    });

    const result = await service().sizzleCreate(
      {
        name: "Launch",
        captureIds: ["cap_2", "cap_1"],
        brief: "make it energetic",
        provider: "codex",
        model: "gpt-5.5"
      },
      context()
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        projectId: "sz_1",
        name: "Launch",
        sceneCount: 2,
        threadId: "th_sizzle",
        turnId: "turn_1"
      }
    });
    if (result.ok) {
      expect(result.value).not.toHaveProperty("project");
      expect(JSON.stringify(result.value)).not.toContain("/Users/person");
    }
    expect(calls.map((call) => call.command)).toEqual([
      "create",
      "toggle",
      "toggle",
      "chat-create",
      "chat-send"
    ]);
    expect(calls[3]?.req).toMatchObject({
      anchorCaptureId: "sz_1",
      provider: "codex",
      model: "gpt-5.5"
    });
  });

  test("rejects a missing capture before creating a project", async () => {
    const calls: string[] = [];
    register("library:byId", async (req) =>
      req.id === "cap_bad"
        ? ok(null)
        : ok({ id: req.id, kind: "image", deleted_at: null })
    );
    register("sizzle:create", async () => {
      calls.push("create");
      return ok({ id: "sz_1", scenes: [] });
    });

    const result = await service().sizzleCreate(
      {
        name: "Launch",
        captureIds: ["cap_1", "cap_bad"]
      },
      context()
    );

    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(calls).toEqual([]);
  });

  test("rejects a trashed capture before creating a project", async () => {
    const creates: string[] = [];
    register("library:byId", async (req) =>
      ok({ id: req.id, kind: "image", deleted_at: "2026-08-01T00:00:00.000Z" })
    );
    register("sizzle:create", async () => {
      creates.push("create");
      return ok({ id: "sz_1", scenes: [] });
    });

    const result = await service().sizzleCreate(
      { name: "Launch", captureIds: ["cap_trashed"] },
      context()
    );

    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(creates).toEqual([]);
  });

  test("keeps Sizzle follow-ups project-scoped and reports thread status", async () => {
    const sends: any[] = [];
    const current = thread({
      id: "th_sizzle",
      anchor: "sz_1",
      modifiedAt: "2026-03-01T00:00:00.000Z",
      status: { kind: "streaming", turnId: "turn_1" }
    });
    register("sizzle:list", async () =>
      ok({ projects: [{ id: "sz_1" }] })
    );
    register("codex:sizzleChat:list", async (req) => {
      expect(req).toEqual({ anchorCaptureId: "sz_1" });
      return ok({ threads: [current] });
    });
    register("codex:sizzleChat:send", async (req) => {
      sends.push(req);
      return ok({ turnId: "turn_2" });
    });

    const toolService = service();
    const sent = await toolService.sizzleSend(
      { projectId: "sz_1", instruction: "make the opening faster" },
      context()
    );
    const status = await toolService.sizzleStatus(
      { projectId: "sz_1", threadId: "th_sizzle" },
      context()
    );

    expect(sent).toEqual(ok({ threadId: "th_sizzle", turnId: "turn_2" }));
    expect(status).toEqual(
      ok({
        threadId: "th_sizzle",
        status: { kind: "streaming", turnId: "turn_1" }
      })
    );
    expect(sends).toEqual([
      {
        threadId: "th_sizzle",
        text: "make the opening faster",
        anchorCaptureId: "sz_1"
      }
    ]);
  });

  test("uses client-scoped resource URIs for identical Sizzle renders", async () => {
    register("sizzle:render", async () =>
      ok({
        outputPath: "/tmp/reel.mp4",
        durationSec: 8,
        renderId: "render_1",
        widthPx: 640,
        heightPx: 360
      })
    );
    const toolService = service(
      new LocalAgentMcpResourceRegistry(),
      "http://127.0.0.1:51729"
    );
    const first = await toolService.sizzleRender(
      { projectId: "sz_1" },
      context("lag_first", ["sizzle.preview.read"]),
      "preview"
    );
    const second = await toolService.sizzleRender(
      { projectId: "sz_1" },
      context("lag_second", ["sizzle.preview.read"]),
      "preview"
    );

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect((first.value as any).resourceUri).not.toBe(
      (second.value as any).resourceUri
    );
    const firstMcp = toMcpToolResult(first);
    expect(firstMcp.content[1]).toMatchObject({
      type: "resource_link",
      uri: expect.stringMatching(/^http:\/\/127\.0\.0\.1:51729\/media\?/u),
      mimeType: "video/mp4"
    });
    expect(firstMcp.content.some((content) => content.type === "image")).toBe(
      false
    );
  });
});
