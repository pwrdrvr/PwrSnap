import { randomUUID } from "node:crypto";
import type { DynamicToolCallResponse, DynamicToolSpec } from "@pwrsnap/codex-app-server-protocol/v2";
import type {
  CaptureSearchRequest,
  CaptureSearchResultRow,
  PwrSnapError,
  Result,
  SizzleProject,
  SizzleScene
} from "@pwrsnap/shared";
import { bus } from "../command-bus";
import type { ChatToolDispatch } from "../ai/codex-client";

// The Sizzle chat agent's tool manifest + dispatch. Each tool is a
// JSON-schema the model can call; every mutation tool is scoped to a
// SINGLE projectId baked into the closure when the session started — the
// agent cannot target another project (locked decision #4). Read tools
// (`library_search` / `library_get_metadata`) span the whole library.
//
// Tools wrap the existing command-bus verbs (`library:search`,
// `library:listByIdsWithMetadata`, `sizzle:list`, `sizzle:update`,
// `sizzle:render`) so there is exactly one place each mutation happens
// and the renderer's live `events:sizzle:projects:changed` broadcast
// fires for free.

const NAMESPACE = "pwrsnap_sizzle";

/** Result of running one tool: the protocol reply handed back to Codex
 *  plus a short human summary for the transcript event. */
export type SizzleToolResult = {
  response: DynamicToolCallResponse;
  summary: string;
};

/** Injectable seam over the command bus so the dispatcher is unit
 *  testable without a live bus. Defaults wire to `bus.dispatch`. */
export type SizzleToolDeps = {
  search: (
    req: CaptureSearchRequest
  ) => Promise<Result<{ rows: CaptureSearchResultRow[] }, PwrSnapError>>;
  getMetadata: (
    ids: string[]
  ) => Promise<
    Result<
      { rows: Array<{ record: import("@pwrsnap/shared").CaptureRecord; enrichment: import("@pwrsnap/shared").CaptureEnrichment | null }> },
      PwrSnapError
    >
  >;
  listProjects: () => Promise<Result<{ projects: SizzleProject[] }, PwrSnapError>>;
  updateProject: (
    id: string,
    patch: Partial<Omit<SizzleProject, "id" | "createdAt">>
  ) => Promise<Result<SizzleProject, PwrSnapError>>;
  render: (
    id: string
  ) => Promise<Result<{ outputPath: string; durationSec: number }, PwrSnapError>>;
};

export type SizzleToolDispatcher = {
  tools: DynamicToolSpec[];
  dispatch: (call: ChatToolDispatch) => Promise<SizzleToolResult>;
};

function defaultDeps(): SizzleToolDeps {
  return {
    search: (req) => bus.dispatch("library:search", req, { principal: "ipc" }),
    getMetadata: (ids) =>
      bus.dispatch("library:listByIdsWithMetadata", { ids }, { principal: "ipc" }),
    listProjects: () => bus.dispatch("sizzle:list", {}, { principal: "ipc" }),
    updateProject: (id, patch) =>
      bus.dispatch("sizzle:update", { id, patch }, { principal: "ipc" }),
    render: (id) => bus.dispatch("sizzle:render", { id }, { principal: "ipc" })
  };
}

export function createSizzleToolDispatcher(
  projectId: string,
  deps: SizzleToolDeps = defaultDeps()
): SizzleToolDispatcher {
  const getProject = async (): Promise<SizzleProject | { error: string }> => {
    const r = await deps.listProjects();
    if (!r.ok) return { error: r.error.message };
    const project = r.value.projects.find((p) => p.id === projectId);
    return project ?? { error: `project ${projectId} not found` };
  };

  const writeScenes = async (
    scenes: SizzleScene[]
  ): Promise<SizzleToolResult> => {
    const r = await deps.updateProject(projectId, { scenes });
    if (!r.ok) return errorResult(r.error.message);
    return jsonResult(projectView(r.value), `Project now has ${r.value.scenes.length} scene(s)`);
  };

  const dispatch = async (call: ChatToolDispatch): Promise<SizzleToolResult> => {
    const args = (call.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (call.tool) {
        case "library_search": {
          const r = await deps.search(toSearchRequest(args));
          if (!r.ok) return errorResult(r.error.message);
          const rows = r.value.rows.map(searchRowView);
          return jsonResult({ rows }, `Found ${rows.length} capture(s)`);
        }
        case "library_get_metadata": {
          const ids = asStringArray(args.captureIds);
          if (ids.length === 0) return errorResult("captureIds is required");
          const r = await deps.getMetadata(ids);
          if (!r.ok) return errorResult(r.error.message);
          const rows = r.value.rows.map(metadataRowView);
          return jsonResult({ rows }, `Fetched metadata for ${rows.length} capture(s)`);
        }
        case "project_get": {
          const project = await getProject();
          if ("error" in project) return errorResult(project.error);
          return jsonResult(projectView(project), `Read project "${project.name}"`);
        }
        case "scenes_set": {
          const scenes = asSceneInputs(args.scenes).map(toScene);
          return writeScenes(scenes);
        }
        case "scenes_append": {
          const project = await getProject();
          if ("error" in project) return errorResult(project.error);
          const added = asSceneInputs(args.scenes).map(toScene);
          return writeScenes([...project.scenes, ...added]);
        }
        case "scenes_insert": {
          const project = await getProject();
          if ("error" in project) return errorResult(project.error);
          const index = clampIndex(asNumber(args.index), project.scenes.length);
          const added = asSceneInputs(args.scenes).map(toScene);
          const next = [...project.scenes];
          next.splice(index, 0, ...added);
          return writeScenes(next);
        }
        case "scenes_remove": {
          const project = await getProject();
          if ("error" in project) return errorResult(project.error);
          const ids = new Set(asStringArray(args.sceneIds));
          const indices = new Set(asNumberArray(args.indices));
          const next = project.scenes.filter(
            (s, i) => !ids.has(s.id) && !indices.has(i)
          );
          if (next.length === project.scenes.length) {
            return errorResult("no matching scenes to remove");
          }
          return writeScenes(next);
        }
        case "scenes_reorder": {
          const project = await getProject();
          if ("error" in project) return errorResult(project.error);
          const order = asStringArray(args.sceneIds);
          const byId = new Map(project.scenes.map((s) => [s.id, s]));
          const next: SizzleScene[] = [];
          for (const id of order) {
            const scene = byId.get(id);
            if (scene !== undefined) {
              next.push(scene);
              byId.delete(id);
            }
          }
          // Any scenes the agent didn't list keep their relative order
          // at the end, so a partial reorder never drops scenes.
          for (const scene of project.scenes) {
            if (byId.has(scene.id)) next.push(scene);
          }
          return writeScenes(next);
        }
        case "scene_set_script":
          return editScene(getProject, writeScenes, asString(args.sceneId), (s) => ({
            ...s,
            scriptLine: asString(args.scriptLine)
          }));
        case "scene_set_transition":
          return editScene(getProject, writeScenes, asString(args.sceneId), (s) => ({
            ...s,
            transition: args.transition === "cut" ? "cut" : "crossfade"
          }));
        case "scene_set_audio_source":
          return editScene(getProject, writeScenes, asString(args.sceneId), (s) => ({
            ...s,
            audioSource: asAudioSource(args.audioSource)
          }));
        case "scene_set_media_trim":
          return editScene(getProject, writeScenes, asString(args.sceneId), (s) => ({
            ...s,
            mediaTrim: { startSec: asNumber(args.startSec), endSec: asNumber(args.endSec) }
          }));
        case "scene_set_duration_override":
          return editScene(getProject, writeScenes, asString(args.sceneId), (s) => ({
            ...s,
            durationOverrideSec:
              args.durationSec === null || args.durationSec === undefined
                ? null
                : positiveOrNull(asNumber(args.durationSec))
          }));
        case "project_render": {
          const r = await deps.render(projectId);
          if (!r.ok) return errorResult(r.error.message);
          return jsonResult(
            { outputPath: r.value.outputPath, durationSec: r.value.durationSec },
            `Rendered ${r.value.durationSec.toFixed(1)}s reel`
          );
        }
        default:
          return errorResult(`unknown tool: ${call.tool}`);
      }
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  };

  return { tools: SIZZLE_TOOLS, dispatch };
}

/** Apply a single-scene edit by sceneId, then persist. */
async function editScene(
  getProject: () => Promise<SizzleProject | { error: string }>,
  writeScenes: (scenes: SizzleScene[]) => Promise<SizzleToolResult>,
  sceneId: string,
  patch: (s: SizzleScene) => SizzleScene
): Promise<SizzleToolResult> {
  if (sceneId.length === 0) return errorResult("sceneId is required");
  const project = await getProject();
  if ("error" in project) return errorResult(project.error);
  let found = false;
  const next = project.scenes.map((s) => {
    if (s.id !== sceneId) return s;
    found = true;
    return patch(s);
  });
  if (!found) return errorResult(`scene ${sceneId} not found`);
  return writeScenes(next);
}

// ── Views ────────────────────────────────────────────────────────────

function projectView(p: SizzleProject): unknown {
  return {
    id: p.id,
    name: p.name,
    voice: p.voice,
    ttsProvider: p.ttsProvider,
    resolution: p.resolution,
    lastRenderedAt: p.lastRenderedAt,
    scenes: p.scenes.map((s) => ({
      sceneId: s.id,
      captureId: s.captureId,
      scriptLine: s.scriptLine,
      transition: s.transition,
      audioSource: s.audioSource,
      durationOverrideSec: s.durationOverrideSec,
      mediaTrim: s.mediaTrim
    }))
  };
}

function searchRowView(row: CaptureSearchResultRow): unknown {
  const e = row.enrichment;
  return {
    captureId: row.record.id,
    kind: row.record.kind,
    title: e?.acceptedTitle ?? e?.suggestedTitle ?? null,
    description: e?.acceptedDescription ?? e?.suggestedDescription ?? null,
    snippet: row.matchSnippet,
    sourceAppName: row.record.source_app_name,
    capturedAt: row.record.captured_at
  };
}

function metadataRowView(row: {
  record: import("@pwrsnap/shared").CaptureRecord;
  enrichment: import("@pwrsnap/shared").CaptureEnrichment | null;
}): unknown {
  const e = row.enrichment;
  return {
    captureId: row.record.id,
    kind: row.record.kind,
    title: e?.acceptedTitle ?? e?.suggestedTitle ?? null,
    description: e?.acceptedDescription ?? e?.suggestedDescription ?? null,
    ocrText: e?.ocrText ?? null,
    tags: e?.acceptedTags ?? [],
    sourceAppName: row.record.source_app_name,
    capturedAt: row.record.captured_at,
    width: row.record.width_px,
    height: row.record.height_px
  };
}

// ── Arg coercion ───────────────────────────────────────────────────────

type AgentSceneInput = {
  captureId: string;
  scriptLine?: string | undefined;
  transition?: "cut" | "crossfade" | undefined;
  audioSource?: "auto" | "native" | "voiceover" | "muted" | undefined;
  durationOverrideSec?: number | null | undefined;
  mediaTrim?: { startSec: number; endSec: number } | null | undefined;
};

function toScene(input: AgentSceneInput): SizzleScene {
  return {
    id: `sc_${randomUUID().slice(0, 10)}`,
    captureId: input.captureId,
    scriptLine: typeof input.scriptLine === "string" ? input.scriptLine : "",
    durationOverrideSec:
      typeof input.durationOverrideSec === "number" && input.durationOverrideSec > 0
        ? input.durationOverrideSec
        : null,
    mediaTrim:
      input.mediaTrim != null
        ? { startSec: Number(input.mediaTrim.startSec), endSec: Number(input.mediaTrim.endSec) }
        : null,
    audioSource: asAudioSource(input.audioSource),
    transition: input.transition === "cut" ? "cut" : "crossfade"
  };
}

function toSearchRequest(args: Record<string, unknown>): CaptureSearchRequest {
  const req: CaptureSearchRequest = {};
  if (typeof args.query === "string") req.query = args.query;
  const apps = args.appBundleIds;
  if (Array.isArray(apps)) {
    req.appBundleIds = apps.map((a) => (typeof a === "string" ? a : null));
  }
  if (Array.isArray(args.kinds)) {
    req.kinds = args.kinds.filter(
      (k): k is "image" | "video" => k === "image" || k === "video"
    );
  }
  const range = args.dateRange as { start?: unknown; end?: unknown } | undefined;
  if (range && typeof range.start === "string" && typeof range.end === "string") {
    req.dateRange = { start: range.start, end: range.end };
  }
  if (typeof args.hasOcr === "boolean") req.hasOcr = args.hasOcr;
  if (typeof args.limit === "number") req.limit = args.limit;
  return req;
}

function asSceneInputs(v: unknown): AgentSceneInput[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
    .map(
      (s): AgentSceneInput => ({
        captureId: asString(s.captureId),
        scriptLine: typeof s.scriptLine === "string" ? s.scriptLine : undefined,
        transition: asTransitionOpt(s.transition),
        audioSource: asAudioSourceOpt(s.audioSource),
        durationOverrideSec:
          typeof s.durationOverrideSec === "number" ? s.durationOverrideSec : undefined,
        mediaTrim:
          s.mediaTrim != null && typeof s.mediaTrim === "object"
            ? {
                startSec: Number((s.mediaTrim as Record<string, unknown>).startSec),
                endSec: Number((s.mediaTrim as Record<string, unknown>).endSec)
              }
            : undefined
      })
    )
    .filter((s) => s.captureId.length > 0);
}

function asTransitionOpt(v: unknown): "cut" | "crossfade" | undefined {
  return v === "cut" || v === "crossfade" ? v : undefined;
}

function asAudioSourceOpt(v: unknown): AgentSceneInput["audioSource"] {
  return v === "auto" || v === "native" || v === "voiceover" || v === "muted" ? v : undefined;
}

function asAudioSource(v: unknown): SizzleScene["audioSource"] {
  return v === "native" || v === "voiceover" || v === "muted" ? v : "auto";
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function asNumberArray(v: unknown): number[] {
  return Array.isArray(v)
    ? v.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n >= 0)
    : [];
}

function positiveOrNull(n: number): number | null {
  return Number.isFinite(n) && n > 0 ? n : null;
}

function clampIndex(n: number, len: number): number {
  if (!Number.isInteger(n) || n < 0) return 0;
  return Math.min(n, len);
}

function jsonResult(value: unknown, summary: string): SizzleToolResult {
  return {
    response: {
      contentItems: [{ type: "inputText", text: JSON.stringify(value) }],
      success: true
    },
    summary
  };
}

function errorResult(message: string): SizzleToolResult {
  return {
    response: {
      contentItems: [{ type: "inputText", text: JSON.stringify({ error: message }) }],
      success: false
    },
    summary: message
  };
}

// ── Manifest ─────────────────────────────────────────────────────────

const SCENE_INPUT_SCHEMA = {
  type: "object",
  required: ["captureId"],
  properties: {
    captureId: { type: "string" },
    scriptLine: { type: "string" },
    transition: { type: "string", enum: ["cut", "crossfade"] },
    audioSource: { type: "string", enum: ["auto", "native", "voiceover", "muted"] },
    durationOverrideSec: { type: ["number", "null"] },
    mediaTrim: {
      type: ["object", "null"],
      properties: { startSec: { type: "number" }, endSec: { type: "number" } }
    }
  }
} as const;

function tool(name: string, description: string, properties: object, required: string[] = []): DynamicToolSpec {
  return {
    namespace: NAMESPACE,
    name,
    description,
    inputSchema: { type: "object", properties, required } as unknown as DynamicToolSpec["inputSchema"]
  };
}

export const SIZZLE_TOOLS: DynamicToolSpec[] = [
  tool(
    "library_search",
    "Search the user's whole capture library by free text (title / description / OCR / app name), source app, kind, date range, and OCR presence. Returns matching captures with id, title, description, snippet, app, and timestamp.",
    {
      query: { type: "string" },
      appBundleIds: { type: "array", items: { type: ["string", "null"] } },
      kinds: { type: "array", items: { type: "string", enum: ["image", "video"] } },
      dateRange: {
        type: "object",
        properties: { start: { type: "string" }, end: { type: "string" } }
      },
      hasOcr: { type: "boolean" },
      limit: { type: "number" }
    }
  ),
  tool(
    "library_get_metadata",
    "Fetch full metadata (title, description, OCR text, tags, dimensions) for specific capture ids.",
    { captureIds: { type: "array", items: { type: "string" } } },
    ["captureIds"]
  ),
  tool(
    "project_get",
    "Read this Sizzle project's scenes, voice, resolution, and last-rendered time.",
    {}
  ),
  tool(
    "scenes_set",
    "Replace the project's entire scene list. Use when drafting a fresh reel from scratch.",
    { scenes: { type: "array", items: SCENE_INPUT_SCHEMA } },
    ["scenes"]
  ),
  tool(
    "scenes_append",
    "Append one or more scenes to the end of the project.",
    { scenes: { type: "array", items: SCENE_INPUT_SCHEMA } },
    ["scenes"]
  ),
  tool(
    "scenes_insert",
    "Insert one or more scenes at a specific index (0-based).",
    { index: { type: "number" }, scenes: { type: "array", items: SCENE_INPUT_SCHEMA } },
    ["index", "scenes"]
  ),
  tool(
    "scenes_remove",
    "Remove scenes by sceneId and/or by 0-based index.",
    {
      sceneIds: { type: "array", items: { type: "string" } },
      indices: { type: "array", items: { type: "number" } }
    }
  ),
  tool(
    "scenes_reorder",
    "Reorder scenes. Provide the full ordered list of sceneIds; any omitted scenes keep their relative order at the end.",
    { sceneIds: { type: "array", items: { type: "string" } } },
    ["sceneIds"]
  ),
  tool(
    "scene_set_script",
    "Set one scene's narrator script line.",
    { sceneId: { type: "string" }, scriptLine: { type: "string" } },
    ["sceneId", "scriptLine"]
  ),
  tool(
    "scene_set_transition",
    "Set one scene's transition (cut or crossfade).",
    { sceneId: { type: "string" }, transition: { type: "string", enum: ["cut", "crossfade"] } },
    ["sceneId", "transition"]
  ),
  tool(
    "scene_set_audio_source",
    "Set one scene's audio source (auto / native / voiceover / muted).",
    {
      sceneId: { type: "string" },
      audioSource: { type: "string", enum: ["auto", "native", "voiceover", "muted"] }
    },
    ["sceneId", "audioSource"]
  ),
  tool(
    "scene_set_media_trim",
    "Set a video scene's trim range in seconds.",
    { sceneId: { type: "string" }, startSec: { type: "number" }, endSec: { type: "number" } },
    ["sceneId", "startSec", "endSec"]
  ),
  tool(
    "scene_set_duration_override",
    "Force a specific scene duration in seconds, or null to clear the override.",
    { sceneId: { type: "string" }, durationSec: { type: ["number", "null"] } },
    ["sceneId"]
  ),
  tool(
    "project_render",
    "Render the current project to an MP4. Long-running; returns the output path and total duration.",
    {}
  )
];
