import { err, ok, type CommandName, type LocalAgentCapability } from "@pwrsnap/shared";
import { afterEach, describe, expect, test } from "vitest";
import { bus, type CommandContext } from "../../command-bus";
import { LocalAgentToolService } from "../local-agent-tool-service";
import { LocalAgentMcpResourceRegistry } from "../mcp-resource-registry";
import { LocalAgentSignedUrlService } from "../signed-url";
import type { LocalAgentToolContext } from "../mcp-tool-registry";

const registered: CommandName[] = [];

afterEach(() => {
  for (const command of registered.splice(0)) bus.unregister(command);
});

function register(command: CommandName, handler: (req: any) => Promise<any>): void {
  bus.register(command as never, handler as never);
  registered.push(command);
}

function context(
  clientId = "lag_test",
  capabilities: readonly LocalAgentCapability[] = ["capture.edit", "sizzle.compose"]
): LocalAgentToolContext {
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

function service(resources = new LocalAgentMcpResourceRegistry()): LocalAgentToolService {
  return new LocalAgentToolService(
    resources,
    new LocalAgentSignedUrlService(Buffer.alloc(32, 7)),
    () => null
  );
}

describe("LocalAgentToolService image edits", () => {
  test("reuses the latest model-compatible capture thread and exposes completion status", async () => {
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

    const resources = new LocalAgentMcpResourceRegistry();
    const toolService = service(resources);
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
    expect(sends).toEqual([
      {
        threadId: "th_latest",
        text: "add an arrow",
        anchorCaptureId: "cap_1"
      }
    ]);
    const previewUri = (sent.value as any).compositePreviewResourceUri as string;
    await expect(resources.resolve(previewUri, {
      clientId: "lag_test",
      capabilities: ["capture.edit"]
    })).rejects.toThrow("edit is not complete");

    status = { kind: "idle" };
    const completed = await toolService.imageEditStatus(
      { captureId: "cap_1", threadId: "th_latest" },
      context()
    );
    expect(completed).toEqual(
      ok(expect.objectContaining({
        threadId: "th_latest",
        status: { kind: "idle" },
        compositePreviewResourceUri: expect.stringContaining("/edit/")
      }))
    );
    register("render:captureExport", async () =>
      err({
        kind: "validation",
        code: "not_found",
        message: "capture moved to Trash"
      })
    );
    await expect(resources.resolve(previewUri, {
      clientId: "lag_test",
      capabilities: ["capture.edit"]
    })).rejects.toThrow("capture moved to Trash");
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
    register("sizzle:create", async (req) => {
      calls.push({ command: "create", req });
      return ok({ id: "sz_1", name: req.name, scenes });
    });
    register("sizzle:toggleScene", async (req) => {
      calls.push({ command: "toggle", req });
      scenes = [...scenes, { captureId: req.captureId }];
      return ok({ id: "sz_1", name: "Launch", scenes });
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
        project: {
          scenes: [{ captureId: "cap_2" }, { captureId: "cap_1" }]
        },
        threadId: "th_sizzle",
        turnId: "turn_1"
      }
    });
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

  test("rolls back a partially-created project when a scene cannot be added", async () => {
    const calls: string[] = [];
    register("sizzle:create", async () => {
      calls.push("create");
      return ok({ id: "sz_1", scenes: [] });
    });
    register("sizzle:toggleScene", async (req) => {
      calls.push(`toggle:${req.captureId}`);
      if (req.captureId === "cap_bad") {
        return err({
          kind: "validation",
          code: "not_found",
          message: "capture missing"
        });
      }
      return ok({ id: "sz_1", scenes: [{ captureId: req.captureId }] });
    });
    register("sizzle:delete", async () => {
      calls.push("delete");
      return ok(undefined);
    });

    const result = await service().sizzleCreate(
      {
        name: "Launch",
        captureIds: ["cap_1", "cap_bad"]
      },
      context()
    );

    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(calls).toEqual(["create", "toggle:cap_1", "toggle:cap_bad", "delete"]);
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
    const toolService = service();
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
  });
});
