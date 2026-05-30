import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SizzleProject, SizzleScene } from "@pwrsnap/shared";
import type { ToolSpec } from "../define-tool";

// Mock the command bus so tool dispatches are observable without a live bus.
const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("../../command-bus", () => ({ bus: { dispatch } }));

const { buildSizzleToolAllowlist } = await import("../sizzle-tool-allowlist");

const PROJECT_ID = "sz_demo";
const CTX = { threadId: "thread-1" };

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

/** Default bus: sizzle:list returns one project; sizzle:update/render ok. */
function primeBus(current: SizzleProject): void {
  dispatch.mockImplementation(async (name: string, req: unknown) => {
    if (name === "sizzle:list") return { ok: true, value: { projects: [current] } };
    if (name === "sizzle:update") {
      return { ok: true, value: { ...current, ...(req as { patch: object }).patch } };
    }
    if (name === "sizzle:render") return { ok: true, value: { outputPath: "/o.mp4", durationSec: 9 } };
    if (name === "library:search") {
      return {
        ok: true,
        value: {
          rows: [
            {
              record: { id: "cap_x", kind: "image", source_app_name: "App", captured_at: "t" },
              enrichment: { acceptedTitle: "T", acceptedDescription: "D" },
              matchSnippet: "[hit]x[/hit]"
            }
          ]
        }
      };
    }
    if (name === "library:listByIdsWithMetadata") {
      return {
        ok: true,
        value: {
          rows: (req as { ids: string[] }).ids.map((id) => ({
            record: { id, kind: "image", source_app_name: "App", captured_at: "t", width_px: 1, height_px: 2 },
            enrichment: { ocrText: "ocr", acceptedTags: ["x"] }
          }))
        }
      };
    }
    return { ok: true, value: undefined };
  });
}

function tool(allow: ToolSpec<unknown>[], name: string): ToolSpec<unknown> {
  const t = allow.find((x) => x.name === name);
  if (t === undefined) throw new Error(`tool not found: ${name}`);
  return t;
}

/** Allowlist bound to a resolver that always returns PROJECT_ID. */
function boundAllowlist(): ToolSpec<unknown>[] {
  return buildSizzleToolAllowlist({ resolveProjectId: async () => PROJECT_ID });
}

beforeEach(() => {
  dispatch.mockReset();
});

describe("buildSizzleToolAllowlist", () => {
  it("exposes all 16 tools under the pwrsnap_sizzle namespace", () => {
    const allow = boundAllowlist();
    expect(allow).toHaveLength(16);
    expect(allow.every((t) => t.namespace === "pwrsnap_sizzle")).toBe(true);
    expect(allow.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "library_search",
        "library_get_metadata",
        "project_get",
        "scenes_set",
        "scenes_append",
        "sequence_scene_append",
        "scenes_insert",
        "scenes_remove",
        "scenes_reorder",
        "scene_set_script",
        "scene_set_transition",
        "sequence_beat_update",
        "scene_set_audio_source",
        "scene_set_media_trim",
        "scene_set_duration_override",
        "project_render"
      ])
    );
  });

  it("library_search dispatches library:search and returns compact rows", async () => {
    primeBus(project([]));
    const r = await tool(boundAllowlist(), "library_search").dispatch({ query: "x" }, CTX);
    expect(dispatch).toHaveBeenCalledWith("library:search", { query: "x" }, { principal: "mcp" });
    expect(r.ok).toBe(true);
    if (r.ok && "data" in r) {
      expect((r.data as { rows: Array<{ captureId: string }> }).rows[0]?.captureId).toBe("cap_x");
    }
  });

  it("scenes_append writes sizzle:update for the RESOLVED project (no project_id arg)", async () => {
    primeBus(project([scene({ id: "sc_a", captureId: "cap_a" })]));
    const r = await tool(boundAllowlist(), "scenes_append").dispatch(
      { scenes: [{ captureId: "cap_b", scriptLine: "hi" }] },
      CTX
    );
    expect(r.ok).toBe(true);
    const updateCall = dispatch.mock.calls.find((c) => c[0] === "sizzle:update");
    expect(updateCall?.[1]).toMatchObject({ id: PROJECT_ID });
    const scenes = (updateCall?.[1] as { patch: { scenes: SizzleScene[] } }).patch.scenes;
    expect(scenes).toHaveLength(2);
    expect(scenes[1]?.captureId).toBe("cap_b");
    expect(scenes[1]?.id).toMatch(/^sc_/);
    expect(scenes[1]?.scriptLine).toBe("hi");
  });

  it("scene_set_script edits only the targeted scene", async () => {
    primeBus(project([scene({ id: "sc_a" }), scene({ id: "sc_b", captureId: "cap_b" })]));
    await tool(boundAllowlist(), "scene_set_script").dispatch(
      { sceneId: "sc_b", scriptLine: "new" },
      CTX
    );
    const updateCall = dispatch.mock.calls.find((c) => c[0] === "sizzle:update");
    const scenes = (updateCall?.[1] as { patch: { scenes: SizzleScene[] } }).patch.scenes;
    expect(scenes.find((s) => s.id === "sc_a")?.scriptLine).toBe("");
    expect(scenes.find((s) => s.id === "sc_b")?.scriptLine).toBe("new");
  });

  it("sequence_scene_append creates one narration block with timed beats", async () => {
    primeBus(project([]));
    const r = await tool(boundAllowlist(), "sequence_scene_append").dispatch(
      {
        scene: {
          narration: "Open Settings, then enable Telegram.",
          beats: [
            {
              captureId: "cap_settings",
              timing: { kind: "phrase", phrase: "Settings", occurrence: 1 },
              transition: "cut",
              videoFit: "smart-fit"
            },
            {
              captureId: "cap_telegram",
              timing: { kind: "offset", startSec: 1.2, endSec: 2 },
              transition: { type: "push-left", durationSec: 0.18 },
              videoFit: "loop"
            }
          ]
        }
      },
      CTX
    );
    expect(r.ok).toBe(true);
    const updateCall = dispatch.mock.calls.find((c) => c[0] === "sizzle:update");
    const scenes = (updateCall?.[1] as { patch: { scenes: SizzleScene[] } }).patch.scenes;
    expect(scenes).toHaveLength(1);
    expect(scenes[0]!.kind).toBe("sequence");
    expect(scenes[0]!.scriptLine).toBe("Open Settings, then enable Telegram.");
    expect(scenes[0]!.beats).toHaveLength(2);
    expect(scenes[0]!.beats![1]!.transition).toEqual({ type: "push-left", durationSec: 0.18 });
    expect(scenes[0]!.beats![1]!.videoFit).toBe("loop");
  });

  it("sequence_beat_update changes one beat without replacing siblings", async () => {
    primeBus(project([
      scene({
        id: "sc_seq",
        kind: "sequence",
        narration: "Open Settings then enable Telegram",
        scriptLine: "Open Settings then enable Telegram",
        beats: [
          {
            id: "bt_a",
            captureId: "cap_a",
            timing: { kind: "offset", startSec: 0, endSec: 1 },
            mediaTrim: null,
            transition: "cut",
            videoFit: "smart-fit"
          },
          {
            id: "bt_b",
            captureId: "cap_b",
            timing: { kind: "offset", startSec: 1, endSec: 2 },
            mediaTrim: null,
            transition: "cut",
            videoFit: "smart-fit"
          }
        ]
      })
    ]));
    const r = await tool(boundAllowlist(), "sequence_beat_update").dispatch(
      {
        sceneId: "sc_seq",
        beatId: "bt_b",
        timing: { kind: "phrase", phrase: "Telegram", offsetSec: -0.1, durationSec: 0.5 },
        transition: { type: "dip-black", durationSec: 0.2 },
        videoFit: "speed-to-fit"
      },
      CTX
    );
    expect(r.ok).toBe(true);
    const updateCall = dispatch.mock.calls.find((c) => c[0] === "sizzle:update");
    const scenes = (updateCall?.[1] as { patch: { scenes: SizzleScene[] } }).patch.scenes;
    const beats = scenes[0]!.beats!;
    expect(beats[0]!.timing).toEqual({ kind: "offset", startSec: 0, endSec: 1 });
    expect(beats[1]!.timing).toEqual({
      kind: "phrase",
      phrase: "Telegram",
      occurrence: null,
      offsetSec: -0.1,
      durationSec: 0.5
    });
    expect(beats[1]!.transition).toEqual({ type: "dip-black", durationSec: 0.2 });
    expect(beats[1]!.videoFit).toBe("speed-to-fit");
  });

  it("scene_set_script on an unknown scene errors and does NOT write", async () => {
    primeBus(project([scene({ id: "sc_a" })]));
    const r = await tool(boundAllowlist(), "scene_set_script").dispatch(
      { sceneId: "missing", scriptLine: "x" },
      CTX
    );
    expect(r.ok).toBe(false);
    expect(dispatch.mock.calls.some((c) => c[0] === "sizzle:update")).toBe(false);
  });

  it("mutations error (no write) when the thread has no linked project", async () => {
    primeBus(project([scene()]));
    const allow = buildSizzleToolAllowlist({ resolveProjectId: async () => null });
    const r = await tool(allow, "scenes_append").dispatch(
      { scenes: [{ captureId: "cap_b" }] },
      CTX
    );
    expect(r.ok).toBe(false);
    expect(dispatch.mock.calls.some((c) => c[0] === "sizzle:update")).toBe(false);
  });

  it("project_render dispatches sizzle:render for the resolved project", async () => {
    primeBus(project([scene()]));
    const r = await tool(boundAllowlist(), "project_render").dispatch({}, CTX);
    expect(dispatch).toHaveBeenCalledWith("sizzle:render", { id: PROJECT_ID }, { principal: "mcp" });
    expect(r.ok).toBe(true);
  });
});
