import {
  emptyCaptureEditSummary,
  err,
  ok,
  type CommandName,
  type LocalAgentCapability
} from "@pwrsnap/shared";
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
  capabilities: readonly LocalAgentCapability[] = ["capture.edit", "sizzle.compose"],
  maxCaptureAgeDays?: number | null
): LocalAgentToolContext {
  grantCapabilities.set(clientId, capabilities);
  const signal = new AbortController().signal;
  const commandContext: CommandContext = {
    principal: "mcp",
    signal,
    localAgent: {
      clientId,
      capabilities,
      ...(maxCaptureAgeDays !== undefined ? { maxCaptureAgeDays } : {})
    }
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
  test("blocks until a batched edit finishes and can omit media for a follow-up edit", async () => {
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
            modifiedAt: "2026-02-01T00:00:00.000Z"
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
    register("codex:libraryChat:history", async () => ok({ messages: [] }));
    register("codex:libraryChat:wait", async () => ok({
      thread: thread({
        id: "th_latest",
        anchor: "cap_1",
        model: "gpt-5.5",
        modifiedAt: "2026-02-01T00:00:00.000Z"
      }),
      messages: [{
        id: "assistant_1",
        role: "assistant",
        content: [{ kind: "text", text: "Added both annotations." }],
        status: "complete",
        createdAt: "2026-02-01T00:00:00.000Z"
      }]
    }));

    const toolService = service();
    const sent = await toolService.imageEditSend(
      {
        captureId: "cap_1",
        instructions: ["add an arrow", "circle the button"],
        model: "gpt-5.5",
        returnImage: false
      },
      context()
    );

    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    expect(sent.value).toMatchObject({
      threadId: "th_latest",
      turnId: "turn_new",
      status: { kind: "idle" },
      editsApplied: 2,
      assistantSummary: "Added both annotations.",
      imageReturned: false
    });
    expect(sent.value).not.toHaveProperty("compositePreviewResourceUri");
    expect(sends).toEqual([
      {
        threadId: "th_latest",
        text: "Apply all of these edits to the current capture in one turn:\n1. add an arrow\n2. circle the button",
        anchorCaptureId: "cap_1"
      }
    ]);
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
    register("codex:libraryChat:history", async () => ok({ messages: [] }));
    register("codex:libraryChat:wait", async () => ok({
      thread: thread({
        id: "th_kimi",
        anchor: "cap_1",
        model: "kimi-k2",
        modifiedAt: "2026-03-01T00:00:00.000Z"
      }),
      messages: []
    }));
    const exports: unknown[] = [];
    register("render:captureExport", async (request) => {
      exports.push(request);
      return ok({
        captureId: "cap_1",
        variant: "composite",
        format: "png",
        preset: "high",
        path: "/tmp/capture-high.png",
        mimeType: "image/png",
        widthPx: 2_880,
        heightPx: 1_920,
        byteSize: 10,
        fromCache: false,
        exportId: "high"
      });
    });

    const result = await service().imageEditSend(
      {
        captureId: "cap_1",
        instruction: "add an arrow",
        provider: "acp:kimi",
        model: "kimi-k2",
        preset: "high"
      },
      context("lag_edit", ["capture.edit", "capture.composite.read", "capture.export"])
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        threadId: "th_kimi",
        turnId: "turn_kimi",
        imageReturned: true,
        preset: "high"
      }
    });
    expect(creates).toEqual([
      expect.objectContaining({
        anchorCaptureId: "cap_1",
        provider: "acp:kimi",
        model: "kimi-k2"
      })
    ]);
    expect(exports).toEqual([{
      captureId: "cap_1",
      variant: "composite",
      preset: "high",
      format: "png"
    }]);
    expect(toMcpToolResult(result).content[1]).toMatchObject({
      type: "resource_link",
      mimeType: "image/png"
    });
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

/** An invented capture row: only the fields the duplicate/family paths read. */
function member(
  id: string,
  args: {
    familyId?: string;
    duplicatedFrom?: string | null;
    capturedAt?: string;
    deletedAt?: string | null;
    kind?: "image" | "video";
  } = {}
): any {
  return {
    id,
    kind: args.kind ?? "image",
    captured_at: args.capturedAt ?? new Date().toISOString(),
    width_px: 1280,
    height_px: 800,
    byte_size: 4096,
    has_alpha: false,
    source_app_name: "Cereal Box Designer",
    source_app_bundle_id: null,
    deleted_at: args.deletedAt ?? null,
    family_id: args.familyId ?? null,
    duplicated_from: args.duplicatedFrom ?? null
  };
}

const daysAgo = (days: number): string =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();

describe("LocalAgentToolService duplicates", () => {
  test("returns a receipt with the copy's id and family, passing withEdits through", async () => {
    const requests: unknown[] = [];
    register("capture:duplicate", async (request) => {
      requests.push(request);
      return ok({
        record: member("cap_copy", { familyId: "cap_flakes", duplicatedFrom: "cap_flakes" })
      });
    });

    const result = await service().captureDuplicate(
      { captureId: "cap_flakes", withEdits: false },
      context("lag_dup", ["capture.edit"])
    );

    expect(requests).toEqual([{ captureId: "cap_flakes", withEdits: false }]);
    expect(result).toEqual(ok({
      captureId: "cap_copy",
      familyId: "cap_flakes",
      duplicatedFrom: "cap_flakes",
      withEdits: false,
      kind: "image",
      capturedAt: expect.any(String),
      widthPx: 1280,
      heightPx: 800
    }));
  });

  test("the bus refuses a read-only grant before the handler runs", async () => {
    let called = false;
    register("capture:duplicate", async () => {
      called = true;
      return ok({ record: member("cap_copy") });
    });

    const result = await service().captureDuplicate(
      { captureId: "cap_flakes", withEdits: true },
      context("lag_reader", ["library.read", "capture.composite.read"])
    );

    expect(called).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "local_agent_capability_denied" }
    });
  });

  test.each(["not_found", "trashed", "unsupported"])(
    "passes the handler's %s refusal through unchanged",
    async (code) => {
      register("capture:duplicate", async () =>
        err({ kind: "validation", code, message: "invented refusal" })
      );
      const result = await service().captureDuplicate(
        { captureId: "cap_flakes", withEdits: true },
        context("lag_dup", ["capture.edit"])
      );
      expect(toMcpToolResult(result)).toEqual({
        isError: true,
        content: [{ type: "text", text: `${code}: invented refusal` }]
      });
    }
  );
});

describe("LocalAgentToolService edit summary", () => {
  test("adds the readable summary line, or null when there is nothing to carry", async () => {
    register("library:byId", async (request) => ok(member(request.id)));
    register("capture:editSummary", async (request) =>
      ok(
        request.captureId === "cap_plain"
          ? emptyCaptureEditSummary()
          : { ...emptyCaptureEditSummary(), hasEdits: true, cropped: true, arrows: 2, blurs: 1 }
      )
    );

    const edited = await service().captureEditSummary(
      { captureId: "cap_edited" },
      context("lag_editor", ["capture.edit"])
    );
    expect(edited).toMatchObject({
      ok: true,
      value: {
        captureId: "cap_edited",
        kind: "image",
        hasEdits: true,
        arrows: 2,
        summary: "crop · 2 arrows · blur"
      }
    });
    const plain = await service().captureEditSummary(
      { captureId: "cap_plain" },
      context("lag_reader", ["library.read"])
    );
    expect(plain).toMatchObject({ ok: true, value: { hasEdits: false, summary: null } });
  });

  test("maps a missing capture to not_found and a trashed one to trashed", async () => {
    let summarized = 0;
    register("library:byId", async (request) =>
      ok(request.id === "cap_gone" ? null : member(request.id, { deletedAt: daysAgo(1) }))
    );
    register("capture:editSummary", async () => {
      summarized += 1;
      return ok(emptyCaptureEditSummary());
    });

    const missing = await service().captureEditSummary(
      { captureId: "cap_gone" },
      context("lag_reader", ["library.read"])
    );
    const binned = await service().captureEditSummary(
      { captureId: "cap_binned" },
      context("lag_reader", ["library.read"])
    );

    expect(missing).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(binned).toMatchObject({ ok: false, error: { code: "trashed" } });
    expect(summarized).toBe(0);
  });
});

describe("LocalAgentToolService families", () => {
  function registerFamilies(members: Record<string, any[]>): string[] {
    const walked: string[] = [];
    register("library:families", async () =>
      ok({
        families: Object.entries(members).map(([familyId, rows]) => {
          const live = rows.filter((row) => row.deleted_at === null);
          return {
            familyId,
            rootId: familyId,
            coverId: live[0]?.id ?? null,
            liveCount: live.length,
            trashedCount: rows.length - live.length,
            newestCapturedAt: live.reduce(
              (newest: string, row) => (row.captured_at > newest ? row.captured_at : newest),
              ""
            )
          };
        }).sort((a, b) => b.newestCapturedAt.localeCompare(a.newestCapturedAt))
      })
    );
    register("library:family", async (request) => {
      walked.push(request.familyId);
      return ok({ members: members[request.familyId] ?? [] });
    });
    return walked;
  }

  test("lists live members only, and a family with none disappears", async () => {
    registerFamilies({
      cap_oats: [
        member("cap_oats", { familyId: "cap_oats", deletedAt: daysAgo(1), capturedAt: daysAgo(3) }),
        member("cap_oats_copy", {
          familyId: "cap_oats",
          duplicatedFrom: "cap_oats",
          capturedAt: daysAgo(2)
        })
      ],
      cap_bran: [
        member("cap_bran", { familyId: "cap_bran", deletedAt: daysAgo(1) }),
        member("cap_bran_copy", { familyId: "cap_bran", deletedAt: daysAgo(1) })
      ]
    });

    const result = await service().captureFamilies({}, context("lag_reader", ["library.read"]));

    expect(result).toEqual(ok({
      families: [
        {
          familyId: "cap_oats",
          // The original is in Trash: the family is still named for it,
          // but nothing points the agent at a capture it cannot read.
          rootId: null,
          memberIds: ["cap_oats_copy"],
          memberCount: 1,
          newestCapturedAt: expect.any(String)
        }
      ],
      limit: 25,
      hasMore: false
    }));
  });

  test("keeps an age-limited role inside its window and stops one past the page", async () => {
    const walked = registerFamilies({
      cap_new: [
        member("cap_new", { familyId: "cap_new", capturedAt: daysAgo(20) }),
        member("cap_new_copy", { familyId: "cap_new", capturedAt: daysAgo(1) })
      ],
      cap_mid: [
        member("cap_mid", { familyId: "cap_mid", capturedAt: daysAgo(3) }),
        member("cap_mid_copy", { familyId: "cap_mid", capturedAt: daysAgo(2) })
      ],
      cap_low: [
        member("cap_low", { familyId: "cap_low", capturedAt: daysAgo(5) }),
        member("cap_low_copy", { familyId: "cap_low", capturedAt: daysAgo(4) })
      ],
      cap_old: [
        member("cap_old", { familyId: "cap_old", capturedAt: daysAgo(40) }),
        member("cap_old_copy", { familyId: "cap_old", capturedAt: daysAgo(30) })
      ]
    });

    const result = await service().captureFamilies(
      { limit: 1 },
      context("lag_week", ["library.read"], 7)
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        families: [
          { familyId: "cap_new", rootId: null, memberIds: ["cap_new_copy"], memberCount: 1 }
        ],
        limit: 1,
        hasMore: true
      }
    });
    // Two walked (the page plus one to know there is more); cap_old was never
    // opened because its newest member is already outside the window.
    expect(walked).toEqual(["cap_new", "cap_mid"]);
  });

  test("reads one family as search rows plus lineage, oldest first", async () => {
    registerFamilies({
      cap_flakes: [
        member("cap_flakes", { familyId: "cap_flakes", capturedAt: daysAgo(3) }),
        member("cap_flakes_binned", {
          familyId: "cap_flakes",
          duplicatedFrom: "cap_flakes",
          deletedAt: daysAgo(1)
        }),
        member("cap_flakes_copy", {
          familyId: "cap_flakes",
          duplicatedFrom: "cap_flakes",
          capturedAt: daysAgo(1)
        })
      ]
    });
    const asked: unknown[] = [];
    register("library:listByIdsWithMetadata", async (request) => {
      asked.push(request);
      return ok({
        rows: request.ids.map((id: string) => ({
          record: member(id, {
            familyId: "cap_flakes",
            duplicatedFrom: id === "cap_flakes" ? null : "cap_flakes"
          }),
          enrichment: {
            acceptedTitle: id === "cap_flakes" ? "Frosted flakes box" : "Frosted flakes box copy",
            acceptedTags: ["cereal"],
            ocrText: ""
          }
        }))
      });
    });

    const result = await service().captureFamily(
      { familyId: "cap_flakes", detail: "enriched" },
      context("lag_reader", ["library.read"])
    );

    expect(asked).toEqual([{ ids: ["cap_flakes", "cap_flakes_copy"] }]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        familyId: "cap_flakes",
        detail: "enriched",
        hasMore: false,
        members: [
          { id: "cap_flakes", isRoot: true, duplicatedFrom: null, title: "Frosted flakes box" },
          {
            id: "cap_flakes_copy",
            isRoot: false,
            duplicatedFrom: "cap_flakes",
            title: "Frosted flakes box copy",
            tags: ["cereal"]
          }
        ]
      }
    });
  });

  test("a family with no visible member is not_found", async () => {
    registerFamilies({
      cap_old: [
        member("cap_old", { familyId: "cap_old", capturedAt: daysAgo(40) }),
        member("cap_old_copy", { familyId: "cap_old", capturedAt: daysAgo(30) })
      ]
    });

    const outside = await service().captureFamily(
      { familyId: "cap_old" },
      context("lag_week", ["library.read"], 7)
    );
    const unknown = await service().captureFamily(
      { familyId: "cap_never" },
      context("lag_reader", ["library.read"])
    );

    expect(outside).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(unknown).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  test("an edit-only grant cannot list families at the bus floor", async () => {
    registerFamilies({});
    const result = await service().captureFamilies({}, context("lag_editor", ["capture.edit"]));
    expect(result).toMatchObject({
      ok: false,
      error: { code: "local_agent_capability_denied" }
    });
  });
});
