import { describe, expect, it, vi } from "vitest";
import type { SizzleProject, SizzleScene } from "@pwrsnap/shared";
import { createSizzleToolDispatcher, SIZZLE_TOOLS, type SizzleToolDeps } from "../sizzle-tools";
import type { ChatToolDispatch } from "../../ai/codex-client";

const PROJECT_ID = "sz_demo";

function scene(patch: Partial<SizzleScene> = {}): SizzleScene {
  return {
    id: "sc_a",
    captureId: "cap_a",
    scriptLine: "",
    durationOverrideSec: null,
    mediaTrim: null,
    audioSource: "auto",
    transition: "crossfade",
    ...patch
  };
}

function project(scenes: SizzleScene[]): SizzleProject {
  return {
    id: PROJECT_ID,
    name: "Demo",
    createdAt: "2026-05-28T00:00:00.000Z",
    modifiedAt: "2026-05-28T00:00:00.000Z",
    scenes,
    voice: "onyx",
    ttsModel: "tts-1-hd",
    ttsProvider: "openai",
    resolution: "1080p",
    outputPath: null,
    lastRenderedAt: null
  };
}

function makeDeps(initial: SizzleProject): {
  deps: SizzleToolDeps;
  updateProject: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
  current: () => SizzleProject;
} {
  let current = initial;
  const updateProject = vi.fn(async (id: string, patch: Partial<SizzleProject>) => {
    current = { ...current, ...patch, id: current.id } as SizzleProject;
    return { ok: true as const, value: current };
  });
  const render = vi.fn(async () => ({
    ok: true as const,
    value: { outputPath: "/out.mp4", durationSec: 12.3 }
  }));
  const deps: SizzleToolDeps = {
    search: vi.fn(async () => ({
      ok: true as const,
      value: {
        rows: [
          {
            record: { id: "cap_x", kind: "image", source_app_name: "Telegram", captured_at: "t" } as never,
            enrichment: { acceptedTitle: "Pairing", acceptedDescription: "Code screen" } as never,
            matchSnippet: "the [hit]code[/hit]"
          }
        ]
      }
    })),
    getMetadata: vi.fn(async (ids: string[]) => ({
      ok: true as const,
      value: {
        rows: ids.map((id) => ({
          record: { id, kind: "image", source_app_name: "App", captured_at: "t", width_px: 1, height_px: 2 } as never,
          enrichment: { ocrText: "ocr", acceptedTags: ["x"] } as never
        }))
      }
    })),
    listProjects: vi.fn(async () => ({ ok: true as const, value: { projects: [current] } })),
    updateProject,
    render
  };
  return { deps, updateProject, render, current: () => current };
}

function call(tool: string, args: unknown): ChatToolDispatch {
  return { turnId: "t1", callId: "c1", tool, namespace: "pwrsnap_sizzle", arguments: args };
}

function firstText(result: { response: { contentItems: Array<{ type: string }> } }): string {
  const item = result.response.contentItems[0];
  if (item !== undefined && item.type === "inputText") {
    return (item as { type: "inputText"; text: string }).text;
  }
  throw new Error("expected an inputText content item");
}

function parse(result: { response: { contentItems: Array<{ type: string }> } }): unknown {
  return JSON.parse(firstText(result));
}

describe("createSizzleToolDispatcher", () => {
  it("exposes all 14 tools under the sizzle namespace", () => {
    expect(SIZZLE_TOOLS).toHaveLength(14);
    expect(new Set(SIZZLE_TOOLS.map((t) => t.name)).size).toBe(14);
    expect(SIZZLE_TOOLS.every((t) => t.namespace === "pwrsnap_sizzle")).toBe(true);
  });

  it("library_search wraps deps.search and returns compact rows", async () => {
    const { deps } = makeDeps(project([]));
    const { dispatch } = createSizzleToolDispatcher(PROJECT_ID, deps);
    const result = await dispatch(call("library_search", { query: "code" }));
    expect(deps.search).toHaveBeenCalledWith({ query: "code" });
    expect(result.response.success).toBe(true);
    const out = parse(result) as { rows: Array<{ captureId: string }> };
    expect(out.rows[0]?.captureId).toBe("cap_x");
  });

  it("library_get_metadata returns OCR + tags for the requested ids", async () => {
    const { deps } = makeDeps(project([]));
    const { dispatch } = createSizzleToolDispatcher(PROJECT_ID, deps);
    const result = await dispatch(call("library_get_metadata", { captureIds: ["cap_a"] }));
    const out = parse(result) as { rows: Array<{ ocrText: string }> };
    expect(out.rows[0]?.ocrText).toBe("ocr");
  });

  it("scenes_append mints scene ids and persists via updateProject(projectId)", async () => {
    const { deps, updateProject } = makeDeps(project([scene({ id: "sc_a", captureId: "cap_a" })]));
    const { dispatch } = createSizzleToolDispatcher(PROJECT_ID, deps);
    await dispatch(call("scenes_append", { scenes: [{ captureId: "cap_b", scriptLine: "hi" }] }));
    expect(updateProject).toHaveBeenCalledTimes(1);
    const [id, patch] = updateProject.mock.calls[0]!;
    expect(id).toBe(PROJECT_ID);
    expect(patch.scenes).toHaveLength(2);
    expect(patch.scenes[1].captureId).toBe("cap_b");
    expect(patch.scenes[1].id).toMatch(/^sc_/);
    expect(patch.scenes[1].scriptLine).toBe("hi");
  });

  it("scene_set_script edits the targeted scene only", async () => {
    const { deps, updateProject } = makeDeps(
      project([scene({ id: "sc_a" }), scene({ id: "sc_b", captureId: "cap_b" })])
    );
    const { dispatch } = createSizzleToolDispatcher(PROJECT_ID, deps);
    await dispatch(call("scene_set_script", { sceneId: "sc_b", scriptLine: "new line" }));
    const patch = updateProject.mock.calls[0]![1];
    expect(patch.scenes.find((s: SizzleScene) => s.id === "sc_a").scriptLine).toBe("");
    expect(patch.scenes.find((s: SizzleScene) => s.id === "sc_b").scriptLine).toBe("new line");
  });

  it("scene_set_script on an unknown scene returns an error result, no write", async () => {
    const { deps, updateProject } = makeDeps(project([scene({ id: "sc_a" })]));
    const { dispatch } = createSizzleToolDispatcher(PROJECT_ID, deps);
    const result = await dispatch(call("scene_set_script", { sceneId: "missing", scriptLine: "x" }));
    expect(result.response.success).toBe(false);
    expect(updateProject).not.toHaveBeenCalled();
  });

  it("scenes_reorder keeps unlisted scenes at the end (never drops)", async () => {
    const { deps, updateProject } = makeDeps(
      project([scene({ id: "a" }), scene({ id: "b" }), scene({ id: "c" })])
    );
    const { dispatch } = createSizzleToolDispatcher(PROJECT_ID, deps);
    await dispatch(call("scenes_reorder", { sceneIds: ["c", "a"] }));
    const patch = updateProject.mock.calls[0]![1];
    expect(patch.scenes.map((s: SizzleScene) => s.id)).toEqual(["c", "a", "b"]);
  });

  it("project_render wraps deps.render with the bound projectId", async () => {
    const { deps, render } = makeDeps(project([scene()]));
    const { dispatch } = createSizzleToolDispatcher(PROJECT_ID, deps);
    const result = await dispatch(call("project_render", {}));
    expect(render).toHaveBeenCalledWith(PROJECT_ID);
    expect(result.summary).toContain("12.3");
  });

  it("an unknown tool name returns an error result", async () => {
    const { deps } = makeDeps(project([]));
    const { dispatch } = createSizzleToolDispatcher(PROJECT_ID, deps);
    const result = await dispatch(call("definitely_not_a_tool", {}));
    expect(result.response.success).toBe(false);
  });
});
