import type { LocalAgentCapability } from "@pwrsnap/shared";
import { err, ok } from "@pwrsnap/shared";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { CommandContext } from "../../command-bus";
import {
  createDefaultLocalAgentMcpTools,
  type LocalAgentToolContext,
  toMcpToolResult,
  validateToolCapability,
  withMcpResourceLink
} from "../mcp-tool-registry";

function ctx(capabilities: readonly LocalAgentCapability[] = []): LocalAgentToolContext {
  const signal = new AbortController().signal;
  const commandContext: CommandContext = {
    principal: "mcp",
    signal,
    localAgent: {
      clientId: "lag_test",
      capabilities
    }
  };
  return {
    clientId: "lag_test",
    capabilities,
    signal,
    commandContext
  };
}

describe("createDefaultLocalAgentMcpTools", () => {
  test("keeps bearer URLs out of model-facing metadata while returning a typed resource link", () => {
    const result = toMcpToolResult(ok(withMcpResourceLink({
      resourceUri: "pwrsnap://capture/cap_1/composite"
    }, {
      uri: "http://127.0.0.1:51729/media?grant=temporary",
      name: "composite capture",
      mimeType: "image/png",
      size: 123
    })));

    expect(result.structuredContent).toEqual({
      resourceUri: "pwrsnap://capture/cap_1/composite"
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: "PwrSnap media is ready in the attached resource link. Pass that link directly to the client media handler."
      },
      {
        type: "resource_link",
        uri: "http://127.0.0.1:51729/media?grant=temporary",
        name: "composite capture",
        description:
          "Pass this link directly to the client media fetch/render path. Do not copy or reconstruct its URI.",
        mimeType: "image/png",
        size: 123,
        annotations: {
          audience: ["user", "assistant"],
          priority: 1
        }
      },
      {
        type: "text",
        text: JSON.stringify({ resourceUri: "pwrsnap://capture/cap_1/composite" })
      }
    ]);
    expect(JSON.stringify(result.structuredContent)).not.toContain("/media?");
    // The signed URL belongs to the resource link alone. Serializing
    // structuredContent must not smuggle a copy of it into a text block the
    // model reads and might then reconstruct.
    for (const content of result.content) {
      if (content.type === "resource_link") continue;
      expect(JSON.stringify(content)).not.toContain("/media?");
    }
  });

  // This used to assert the opposite — one summary block and nothing else, to
  // avoid paying for the payload twice. MCP says a tool returning
  // structuredContent SHOULD also serialize it, for hosts that read only
  // `content`; without the block such a host is handed "PwrSnap returned 1
  // capture" and no capture. (Claude Code and Codex read structuredContent
  // and drop the text copy, so for them this costs nothing either way.)
  test("serializes structured content into a text block a content-only host can read", () => {
    const result = toMcpToolResult(ok({
      detail: "enriched",
      rows: [{ id: "cap_1" }]
    }));

    expect(result.content).toEqual([
      { type: "text", text: "PwrSnap returned 1 capture." },
      { type: "text", text: JSON.stringify({ detail: "enriched", rows: [{ id: "cap_1" }] }) }
    ]);
    expect(result.structuredContent).toEqual({
      detail: "enriched",
      rows: [{ id: "cap_1" }]
    });
    // The summary is a sentence about what happened, not a pointer to where
    // the data went.
    expect(result.content[0]).not.toEqual(expect.objectContaining({
      text: expect.stringContaining("structuredContent")
    }));
  });

  test("wraps non-object values so structuredContent is always a JSON object", () => {
    // The SDK client parses structuredContent as a record and rejects the
    // whole call otherwise; an array reaching the wire would read like a
    // broken server. No tool returns one today — this pins the wrapper.
    expect(toMcpToolResult(ok([1, 2])).structuredContent).toEqual({ value: [1, 2] });
    expect(toMcpToolResult(ok("done")).structuredContent).toEqual({ value: "done" });
    expect(toMcpToolResult(ok(null)).structuredContent).toEqual({ value: null });
  });

  test("search, discovery, and delete tools dispatch through distinct command paths", async () => {
    const calls: Array<{ name: string; input: unknown }> = [];
    const tools = createDefaultLocalAgentMcpTools({
      search: async (input) => {
        calls.push({ name: "search", input });
        return ok({ searched: input.query ?? "" });
      },
      discovery: async (input) => {
        calls.push({ name: "discovery", input });
        return ok({ applications: [], tags: [] });
      },
      deleteToTrash: async (input) => {
        calls.push({ name: "delete", input });
        return ok({ deleted: input.captureId });
      }
    });
    const search = tools.find((tool) => tool.name === "pwrsnap_library_search");
    const discovery = tools.find((tool) => tool.name === "pwrsnap_library_discover");
    const del = tools.find((tool) => tool.name === "pwrsnap_capture_delete_to_trash");
    if (search === undefined || discovery === undefined || del === undefined) {
      throw new Error("expected default tools");
    }

    await search.dispatch({
      query: "pairing",
      sourceAppNames: ["Claude"],
      tagFilter: { labels: ["Important"], match: "all" },
      kinds: ["image"],
      hasOcr: true,
      order: "newest",
      limit: 25,
      detail: "enriched"
    }, ctx(["library.read"]));
    await discovery.dispatch({ limit: 10 }, ctx(["library.read"]));
    await del.dispatch({ captureId: "cap_123" }, ctx(["trash.write"]));

    expect(calls).toEqual([
      {
        name: "search",
        input: {
          query: "pairing",
          sourceAppNames: ["Claude"],
          tagFilter: { labels: ["Important"], match: "all" },
          kinds: ["image"],
          hasOcr: true,
          order: "newest",
          limit: 25,
          detail: "enriched"
        }
      },
      { name: "discovery", input: { limit: 10 } },
      { name: "delete", input: { captureId: "cap_123" } }
    ]);
  });

  test("delete-to-trash requires a capture id in its MCP schema", () => {
    const tools = createDefaultLocalAgentMcpTools({
      search: async () => ok({}),
      deleteToTrash: async () => ok({})
    });
    const del = tools.find((tool) => tool.name === "pwrsnap_capture_delete_to_trash");
    expect(del?.inputSchema).toHaveProperty("captureId");
  });

  test("search schema exposes structured library filters", () => {
    const tools = createDefaultLocalAgentMcpTools({
      search: async () => ok({}),
      deleteToTrash: async () => ok({})
    });
    const search = tools.find((tool) => tool.name === "pwrsnap_library_search");
    expect(search?.inputSchema).toEqual(expect.objectContaining({
      query: expect.anything(),
      sourceAppNames: expect.anything(),
      tagFilter: expect.anything(),
      kinds: expect.anything(),
      dateRange: expect.anything(),
      hasOcr: expect.anything(),
      order: expect.anything(),
      limit: expect.anything(),
      detail: expect.anything()
    }));
    expect(search?.inputSchema).not.toHaveProperty("appBundleIds");
    expect(search?.inputSchema).not.toHaveProperty("includeCapturesWithoutSourceApp");
    expect(search?.description).toContain("newest");

    if (search === undefined) throw new Error("expected search tool");
    const parsed = z.object(search.inputSchema).safeParse({
      sourceAppNames: ["Claude"],
      tagFilter: { labels: ["Important"], match: "all" },
      order: "oldest"
    });
    expect(parsed.success).toBe(true);
    expect(z.object(search.inputSchema).safeParse({ limit: 51 }).success).toBe(false);
  });

  test("discovery is a read-only library.read tool with an intentionally small schema", () => {
    const tools = createDefaultLocalAgentMcpTools({
      search: async () => ok({}),
      discovery: async () => ok({ applications: [], tags: [] }),
      deleteToTrash: async () => ok({})
    });
    const discovery = tools.find((tool) => tool.name === "pwrsnap_library_discover");

    expect(discovery?.requiredCapabilities).toEqual(["library.read"]);
    expect(discovery?.annotations).toMatchObject({ readOnlyHint: true });
    expect(Object.keys(discovery?.inputSchema ?? {})).toEqual(["limit"]);
    expect(discovery?.description).toContain("bundleId");
    if (discovery === undefined) throw new Error("expected discovery tool");
    expect(z.object(discovery.inputSchema).safeParse({ limit: 51 }).success).toBe(false);
  });

  test("full tool set exposes media, edit, and Sizzle workflows", () => {
    const noop = async () => ok({});
    const tools = createDefaultLocalAgentMcpTools({
      search: noop,
      discovery: noop,
      deleteToTrash: noop,
      metadata: noop,
      captureResource: noop,
      captureExport: noop,
      imageEditSend: noop,
      sizzleCreate: noop,
      sizzleSend: noop,
      sizzleStatus: noop,
      sizzleRenderPreview: noop,
      sizzleRenderFull: noop,
      videoInspect: noop,
      videoEdit: noop,
      captureDuplicate: noop,
      captureEditSummary: noop,
      captureFamilies: noop,
      captureFamily: noop
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      "pwrsnap_library_search",
      "pwrsnap_library_discover",
      "pwrsnap_capture_delete_to_trash",
      "pwrsnap_capture_metadata",
      "pwrsnap_capture_resource",
      "pwrsnap_capture_export",
      "pwrsnap_image_edit_send",
      "pwrsnap_video_inspect",
      "pwrsnap_video_edit",
      "pwrsnap_capture_duplicate",
      "pwrsnap_capture_edit_summary",
      "pwrsnap_capture_families",
      "pwrsnap_capture_family",
      "pwrsnap_sizzle_create",
      "pwrsnap_sizzle_send",
      "pwrsnap_sizzle_status",
      "pwrsnap_sizzle_render_preview",
      "pwrsnap_sizzle_render_full"
    ]);

    const resource = tools.find((tool) => tool.name === "pwrsnap_capture_resource");
    expect(resource?.requiredCapabilitiesForInput?.({
      captureId: "cap_1",
      variant: "original"
    })).toEqual(["capture.original.read"]);
    const captureExport = tools.find((tool) => tool.name === "pwrsnap_capture_export");
    expect(captureExport).toBeDefined();
    if (captureExport === undefined) return;
    expect(captureExport.requiredCapabilities).toEqual(["capture.export"]);
    expect(Object.keys(captureExport.inputSchema)).toEqual([
      "captureId",
      "variant",
      "preset",
      "format"
    ]);
    const captureExportInput = z.object(captureExport.inputSchema);
    expect(
      captureExportInput.safeParse({ captureId: "cap_1", format: "png" }).success
    ).toBe(true);
    expect(
      captureExportInput.safeParse({ captureId: "cap_1", format: "webp" }).success
    ).toBe(false);
    expect(
      tools.find((tool) => tool.name === "pwrsnap_image_edit_send")
        ?.requiredCapabilities
    ).toEqual(["capture.edit", "capture.composite.read"]);
    const imageEdit = tools.find((tool) => tool.name === "pwrsnap_image_edit_send");
    expect(imageEdit?.requiredCapabilitiesForInput?.({
      captureId: "cap_1",
      instruction: "crop tighter",
      returnImage: true
    })).toEqual(["capture.edit", "capture.composite.read", "capture.export"]);
    expect(imageEdit?.requiredCapabilitiesForInput?.({
      captureId: "cap_1",
      instructions: ["crop tighter", "add an arrow"],
      returnImage: false
    })).toEqual(["capture.edit", "capture.composite.read"]);
  });

  test("annotations distinguish reads, artifact creation, AI access, and Trash", () => {
    const noop = async () => ok({});
    const tools = createDefaultLocalAgentMcpTools({
      search: noop,
      discovery: noop,
      deleteToTrash: noop,
      metadata: noop,
      captureResource: noop,
      captureExport: noop,
      imageEditSend: noop,
      sizzleCreate: noop,
      sizzleSend: noop,
      sizzleStatus: noop,
      sizzleRenderPreview: noop,
      sizzleRenderFull: noop,
      videoInspect: noop,
      videoEdit: noop,
      captureDuplicate: noop,
      captureEditSummary: noop,
      captureFamilies: noop,
      captureFamily: noop
    });
    const annotations = Object.fromEntries(
      tools.map((tool) => [tool.name, tool.annotations])
    );

    for (const tool of tools) {
      expect(tool.annotations).toEqual(expect.objectContaining({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean)
      }));
    }

    expect(annotations.pwrsnap_library_search).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    });
    expect(annotations.pwrsnap_library_discover).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    });
    expect(annotations.pwrsnap_capture_export).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    });
    expect(annotations.pwrsnap_image_edit_send).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    });
    expect(annotations.pwrsnap_capture_delete_to_trash).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    });
    // Adds a capture and changes nothing that exists; a second call adds a
    // second copy.
    expect(annotations.pwrsnap_capture_duplicate).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    });
    for (const name of [
      "pwrsnap_capture_edit_summary",
      "pwrsnap_capture_families",
      "pwrsnap_capture_family"
    ]) {
      expect(annotations[name]).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      });
    }
    expect(annotations.pwrsnap_sizzle_render_full).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    });
  });
});

describe("video tools", () => {
  const noop = async () => ok({});
  const tools = createDefaultLocalAgentMcpTools({
    search: noop,
    deleteToTrash: noop,
    videoInspect: noop,
    videoEdit: noop
  });
  const inspect = tools.find((tool) => tool.name === "pwrsnap_video_inspect");
  const edit = tools.find((tool) => tool.name === "pwrsnap_video_edit");

  test("inspect is a library read; edit needs capture.edit and is not destructive", () => {
    expect(inspect?.requiredCapabilities).toEqual(["library.read"]);
    expect(inspect?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(edit?.requiredCapabilities).toEqual(["capture.edit"]);
    // The recording is never modified and every edit is undoable, so the
    // client should not treat a cut like a delete.
    expect(edit?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  test("teach the kept-span model and the activity levels", () => {
    expect(inspect?.description).toContain("source seconds");
    expect(inspect?.description).toContain("stillSpans");
    expect(edit?.description).toContain("cutStill");
  });

  test("edit schema accepts each operation and rejects junk spans", () => {
    if (edit === undefined) throw new Error("expected edit tool");
    const schema = z.object(edit.inputSchema);
    expect(schema.safeParse({ captureId: "c", keep: [{ start: 1, end: 4 }] }).success).toBe(true);
    expect(schema.safeParse({ captureId: "c", cut: [{ start: 5, end: 12 }] }).success).toBe(true);
    expect(schema.safeParse({ captureId: "c", cutStill: { minStillSec: 5 } }).success).toBe(true);
    expect(schema.safeParse({ captureId: "c", reset: true }).success).toBe(true);
    expect(schema.safeParse({ captureId: "c", keep: [] }).success).toBe(false);
    expect(schema.safeParse({ captureId: "c", cut: [{ start: -1, end: 2 }] }).success).toBe(false);
    expect(schema.safeParse({ captureId: "c", cutStill: { minStillSec: 0.1 } }).success).toBe(false);
  });
});

describe("duplicate and family tools", () => {
  const noop = async () => ok({});
  const tools = createDefaultLocalAgentMcpTools({
    search: noop,
    deleteToTrash: noop,
    captureDuplicate: noop,
    captureEditSummary: noop,
    captureFamilies: noop,
    captureFamily: noop
  });
  function tool(name: string) {
    const found = tools.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(`expected ${name}`);
    return found;
  }
  const duplicate = tool("pwrsnap_capture_duplicate");
  const editSummary = tool("pwrsnap_capture_edit_summary");
  const families = tool("pwrsnap_capture_families");
  const family = tool("pwrsnap_capture_family");

  test("are omitted when their dispatchers are not wired", () => {
    const minimal = createDefaultLocalAgentMcpTools({ search: noop, deleteToTrash: noop });
    expect(minimal.map((candidate) => candidate.name)).not.toContain("pwrsnap_capture_duplicate");
  });

  test("duplicate requires withEdits — there is no implicit default", () => {
    const schema = z.object(duplicate.inputSchema);
    expect(Object.keys(duplicate.inputSchema)).toEqual(["captureId", "withEdits"]);
    expect(schema.safeParse({ captureId: "cap_1", withEdits: true }).success).toBe(true);
    expect(schema.safeParse({ captureId: "cap_1", withEdits: false }).success).toBe(true);
    // The Library remembers the user's last choice; an agent never inherits it.
    expect(schema.safeParse({ captureId: "cap_1" }).success).toBe(false);
    expect(schema.safeParse({ captureId: "cap_1", withEdits: "true" }).success).toBe(false);
    expect(schema.safeParse({ captureId: "", withEdits: true }).success).toBe(false);
    expect(schema.parse({ captureId: "cap_1", withEdits: false })).toEqual({
      captureId: "cap_1",
      withEdits: false
    });
  });

  test("teach the duplicate-then-edit workflow", () => {
    expect(duplicate.description).toContain("familyId");
    expect(duplicate.description).toContain("pwrsnap_image_edit_send");
    expect(duplicate.description).toContain("pwrsnap_capture_edit_summary");
    expect(editSummary.description).toContain("withEdits=true");
  });

  test("family schemas bound their ids, pages, and detail", () => {
    expect(z.object(editSummary.inputSchema).safeParse({ captureId: "cap_1" }).success).toBe(true);
    expect(z.object(families.inputSchema).safeParse({}).success).toBe(true);
    expect(z.object(families.inputSchema).safeParse({ limit: 51 }).success).toBe(false);
    const familySchema = z.object(family.inputSchema);
    expect(familySchema.safeParse({ familyId: "fam_1", detail: "enriched", limit: 10 }).success)
      .toBe(true);
    expect(familySchema.safeParse({}).success).toBe(false);
    expect(familySchema.safeParse({ familyId: "x".repeat(65) }).success).toBe(false);
    expect(familySchema.safeParse({ familyId: "fam_1", detail: "full" }).success).toBe(false);
  });

  test("duplicate is a capture.edit write that a read-only grant cannot call", () => {
    expect(duplicate.requiredCapabilities).toEqual(["capture.edit"]);
    const input = { captureId: "cap_1", withEdits: true };
    expect(validateToolCapability(duplicate, ctx(["capture.edit"]), input)).toEqual(ok(undefined));
    for (const readOnly of [
      ["library.read"],
      ["library.read", "capture.composite.read", "capture.original.read", "capture.export"]
    ] as const) {
      const denied = validateToolCapability(duplicate, ctx(readOnly), input);
      expect(denied).toMatchObject({
        ok: false,
        error: { code: "missing_capability", message: expect.stringContaining("capture.edit") }
      });
    }
  });

  test("the edit summary admits a reader or an editor, and nobody else", () => {
    const input = { captureId: "cap_1" };
    expect(validateToolCapability(editSummary, ctx(["library.read"]), input).ok).toBe(true);
    expect(validateToolCapability(editSummary, ctx(["capture.edit"]), input).ok).toBe(true);
    expect(validateToolCapability(editSummary, ctx(["trash.write"]), input)).toMatchObject({
      ok: false,
      error: {
        code: "missing_capability",
        message: "local agent cannot call pwrsnap_capture_edit_summary; missing one of library.read, capture.edit"
      }
    });
  });

  test("family reads need library.read", () => {
    expect(families.requiredCapabilities).toEqual(["library.read"]);
    expect(family.requiredCapabilities).toEqual(["library.read"]);
    expect(validateToolCapability(families, ctx(["capture.edit"]), {}).ok).toBe(false);
    expect(validateToolCapability(family, ctx(["library.read"]), { familyId: "fam_1" }).ok)
      .toBe(true);
  });

  test("a duplicate receipt carries its data twice and a refusal maps to its code", () => {
    const receipt = {
      captureId: "cap_copy",
      familyId: "cap_1",
      duplicatedFrom: "cap_1",
      withEdits: true,
      kind: "image",
      capturedAt: "2026-06-07T12:00:00.000Z",
      widthPx: 1280,
      heightPx: 800
    };
    const result = toMcpToolResult(ok(receipt));
    expect(result.structuredContent).toEqual(receipt);
    expect(result.content).toEqual([
      { type: "text", text: "PwrSnap operation completed." },
      { type: "text", text: JSON.stringify(receipt) }
    ]);

    for (const code of ["not_found", "trashed", "unsupported"]) {
      expect(toMcpToolResult(err({ kind: "validation", code, message: "nope" }))).toEqual({
        isError: true,
        content: [{ type: "text", text: `${code}: nope` }]
      });
    }
  });
});
