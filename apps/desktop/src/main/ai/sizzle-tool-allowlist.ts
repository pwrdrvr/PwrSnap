// The Sizzle composer chat tool catalog — the single audit surface for
// which command-bus verbs the Sizzle agent may invoke (agent-native
// parity: "bus is the floor"). Mirrors `library-tool-allowlist.ts` but
// for reel composition: search the library, read/mutate the current
// project's scenes, and render.
//
// Project scoping (locked decision #4): every mutation is bound to the
// ONE project this chat thread is anchored to. The agent never passes a
// project id — the allowlist factory resolves it from the calling
// thread's anchor (`ctx.threadId` → the thread's `anchorCaptureId`,
// which for a Sizzle thread holds the project id). The agent literally
// cannot target another project.

import { nanoid } from "nanoid";
import { z } from "zod";
import {
  type CaptureRecord,
  type CaptureEnrichment,
  type CaptureSearchRequest,
  type CommandName,
  type Req,
  type SizzleProject,
  type SizzleScene
} from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { defineTool, type ToolDispatchResult, type ToolSpec } from "./define-tool";

/** Run one bus verb and map the Result to a ToolDispatchResult. */
async function runVerb<C extends CommandName>(name: C, req: Req<C>): Promise<ToolDispatchResult> {
  const result = await bus.dispatch(name, req, { principal: "mcp" });
  if (result.ok) return { ok: true, data: result.value };
  return {
    ok: false,
    error: `${result.error.kind}/${result.error.code}: ${result.error.message}`
  };
}

/** Drop explicit-`undefined` keys so a zod `.optional()` value satisfies
 *  an `exactOptionalPropertyTypes` request type (where `key?: T` rejects
 *  a present-but-undefined value). */
function compact<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as T;
}

export type SizzleToolDeps = {
  /** Resolve the project this chat thread mutates, from the thread id.
   *  Returns null when the thread has no linked project. */
  resolveProjectId: (threadId: string) => Promise<string | null>;
};

// ── arg coercion + views ─────────────────────────────────────────────

const sceneInputSchema = z.object({
  captureId: z.string().min(1),
  scriptLine: z.string().optional(),
  transition: z.enum(["cut", "crossfade"]).optional(),
  audioSource: z.enum(["auto", "native", "voiceover", "muted"]).optional(),
  durationOverrideSec: z.number().positive().nullable().optional(),
  mediaTrim: z
    .object({ startSec: z.number().min(0), endSec: z.number().min(0) })
    .nullable()
    .optional()
});
type SceneInput = z.infer<typeof sceneInputSchema>;

function toScene(input: SceneInput): SizzleScene {
  return {
    id: `sc_${nanoid(10)}`,
    captureId: input.captureId,
    scriptLine: input.scriptLine ?? "",
    durationOverrideSec:
      typeof input.durationOverrideSec === "number" && input.durationOverrideSec > 0
        ? input.durationOverrideSec
        : null,
    mediaTrim:
      input.mediaTrim != null
        ? { startSec: input.mediaTrim.startSec, endSec: input.mediaTrim.endSec }
        : null,
    audioSource: input.audioSource ?? "auto",
    transition: input.transition ?? "crossfade"
  };
}

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

function searchRowView(row: {
  record: CaptureRecord;
  enrichment: CaptureEnrichment | null;
  matchSnippet: string | null;
}): unknown {
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
  record: CaptureRecord;
  enrichment: CaptureEnrichment | null;
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

// ── allowlist factory ────────────────────────────────────────────────

/**
 * Build the Sizzle tool allowlist. `deps.resolveProjectId` binds every
 * mutation to the calling thread's project — the agent cannot target
 * another project (no `project_id` arg exists).
 */
export function buildSizzleToolAllowlist(deps: SizzleToolDeps): ToolSpec<unknown>[] {
  /** Resolve the thread's project + load it; null when unlinked/missing. */
  const loadProject = async (threadId: string): Promise<SizzleProject | null> => {
    const projectId = await deps.resolveProjectId(threadId);
    if (projectId === null) return null;
    const r = await bus.dispatch("sizzle:list", {}, { principal: "mcp" });
    if (!r.ok) return null;
    return r.value.projects.find((p) => p.id === projectId) ?? null;
  };

  // Read the project, transform its scenes, persist, return the view.
  //
  // Read-modify-write across two bus calls (list → update). Within a turn
  // the agent's tool calls are sequential, so each sees the prior write.
  // Two chat threads on the SAME reel mutating concurrently could still
  // race (last writer wins) — acceptable: one chat per reel is the norm,
  // and a lost scene-list update is recoverable by re-asking.
  const mutateScenes = async (
    threadId: string,
    transform: (scenes: SizzleScene[], project: SizzleProject) => SizzleScene[] | { error: string }
  ): Promise<ToolDispatchResult> => {
    const project = await loadProject(threadId);
    if (project === null) {
      return { ok: false, error: "No Sizzle project is linked to this chat." };
    }
    const next = transform(project.scenes, project);
    if (!Array.isArray(next)) return { ok: false, error: next.error };
    // Return the PERSISTED project (the store sanitizes scenes on write),
    // not the locally-computed one, so the agent sees the real result.
    const r = await bus.dispatch(
      "sizzle:update",
      { id: project.id, patch: { scenes: next } },
      { principal: "mcp" }
    );
    if (!r.ok) return { ok: false, error: `${r.error.kind}/${r.error.code}: ${r.error.message}` };
    return { ok: true, data: projectView(r.value) };
  };

  const tools = [
    defineTool({
      namespace: "pwrsnap_sizzle",
      name: "library_search",
      description:
        "Search the user's whole capture library by free text (title / description / OCR / app name), source app, kind, date range, and OCR presence. Returns matching captures with id, title, description, snippet, app, and timestamp.",
      argsSchema: z.object({
        query: z.string().optional(),
        appBundleIds: z.array(z.string().nullable()).optional(),
        kinds: z.array(z.enum(["image", "video"])).optional(),
        dateRange: z.object({ start: z.string(), end: z.string() }).optional(),
        hasOcr: z.boolean().optional(),
        limit: z.number().int().positive().max(500).optional()
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
      dispatch: async (args) => {
        const r = await bus.dispatch(
          "library:search",
          compact(args) as CaptureSearchRequest,
          { principal: "mcp" }
        );
        if (!r.ok) return { ok: false, error: r.error.message };
        return { ok: true, data: { rows: r.value.rows.map(searchRowView) } };
      }
    }),
    defineTool({
      namespace: "pwrsnap_sizzle",
      name: "library_get_metadata",
      description:
        "Fetch full metadata (title, description, OCR text, tags, dimensions) for specific capture ids.",
      argsSchema: z.object({ captureIds: z.array(z.string().min(1)).min(1) }),
      annotations: { readOnlyHint: true, idempotentHint: true },
      dispatch: async (args) => {
        const r = await bus.dispatch(
          "library:listByIdsWithMetadata",
          { ids: args.captureIds },
          { principal: "mcp" }
        );
        if (!r.ok) return { ok: false, error: r.error.message };
        return { ok: true, data: { rows: r.value.rows.map(metadataRowView) } };
      }
    }),
    defineTool({
      namespace: "pwrsnap_sizzle",
      name: "project_get",
      description:
        "Read this reel's scenes, voice, resolution, and last-rendered time. Call before editing to see the current state.",
      argsSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
      dispatch: async (_args, ctx) => {
        const project = await loadProject(ctx.threadId);
        if (project === null) {
          return { ok: false, error: "No Sizzle project is linked to this chat." };
        }
        return { ok: true, data: projectView(project) };
      }
    }),
    defineTool({
      namespace: "pwrsnap_sizzle",
      name: "scenes_set",
      description:
        "Replace the reel's entire scene list (must be non-empty — use scenes_remove to delete scenes). Use when drafting a fresh reel from scratch.",
      argsSchema: z.object({ scenes: z.array(sceneInputSchema).min(1) }),
      annotations: { destructiveHint: true },
      dispatch: async (args, ctx) =>
        mutateScenes(ctx.threadId, () => args.scenes.map(toScene))
    }),
    defineTool({
      namespace: "pwrsnap_sizzle",
      name: "scenes_append",
      description: "Append one or more scenes to the end of the reel.",
      argsSchema: z.object({ scenes: z.array(sceneInputSchema).min(1) }),
      dispatch: async (args, ctx) =>
        mutateScenes(ctx.threadId, (scenes) => [...scenes, ...args.scenes.map(toScene)])
    }),
    defineTool({
      namespace: "pwrsnap_sizzle",
      name: "scenes_insert",
      description: "Insert one or more scenes at a 0-based index.",
      argsSchema: z.object({ index: z.number().int().min(0), scenes: z.array(sceneInputSchema).min(1) }),
      dispatch: async (args, ctx) =>
        mutateScenes(ctx.threadId, (scenes) => {
          const next = [...scenes];
          next.splice(Math.min(args.index, scenes.length), 0, ...args.scenes.map(toScene));
          return next;
        })
    }),
    defineTool({
      namespace: "pwrsnap_sizzle",
      name: "scenes_remove",
      description: "Remove scenes by sceneId and/or by 0-based index.",
      argsSchema: z.object({
        sceneIds: z.array(z.string()).optional(),
        indices: z.array(z.number().int().min(0)).optional()
      }),
      annotations: { destructiveHint: true },
      dispatch: async (args, ctx) =>
        mutateScenes(ctx.threadId, (scenes) => {
          const ids = new Set(args.sceneIds ?? []);
          const indices = new Set(args.indices ?? []);
          const next = scenes.filter((s, i) => !ids.has(s.id) && !indices.has(i));
          return next.length === scenes.length
            ? { error: "No matching scenes to remove." }
            : next;
        })
    }),
    defineTool({
      namespace: "pwrsnap_sizzle",
      name: "scenes_reorder",
      description:
        "Reorder scenes. Provide the full ordered list of sceneIds; any omitted scenes keep their relative order at the end.",
      argsSchema: z.object({ sceneIds: z.array(z.string()).min(1) }),
      dispatch: async (args, ctx) =>
        mutateScenes(ctx.threadId, (scenes) => {
          const byId = new Map(scenes.map((s) => [s.id, s]));
          const next: SizzleScene[] = [];
          for (const id of args.sceneIds) {
            const scene = byId.get(id);
            if (scene !== undefined) {
              next.push(scene);
              byId.delete(id);
            }
          }
          for (const s of scenes) if (byId.has(s.id)) next.push(s);
          return next;
        })
    }),
    defineTool({
      namespace: "pwrsnap_sizzle",
      name: "scene_set_script",
      description: "Set one scene's narrator script line.",
      argsSchema: z.object({ sceneId: z.string().min(1), scriptLine: z.string() }),
      dispatch: async (args, ctx) => editScene(ctx.threadId, mutateScenes, args.sceneId, (s) => ({
        ...s,
        scriptLine: args.scriptLine
      }))
    }),
    defineTool({
      namespace: "pwrsnap_sizzle",
      name: "scene_set_transition",
      description: "Set one scene's transition (cut or crossfade).",
      argsSchema: z.object({ sceneId: z.string().min(1), transition: z.enum(["cut", "crossfade"]) }),
      dispatch: async (args, ctx) => editScene(ctx.threadId, mutateScenes, args.sceneId, (s) => ({
        ...s,
        transition: args.transition
      }))
    }),
    defineTool({
      namespace: "pwrsnap_sizzle",
      name: "scene_set_audio_source",
      description: "Set one scene's audio source (auto / native / voiceover / muted).",
      argsSchema: z.object({
        sceneId: z.string().min(1),
        audioSource: z.enum(["auto", "native", "voiceover", "muted"])
      }),
      dispatch: async (args, ctx) => editScene(ctx.threadId, mutateScenes, args.sceneId, (s) => ({
        ...s,
        audioSource: args.audioSource
      }))
    }),
    defineTool({
      namespace: "pwrsnap_sizzle",
      name: "scene_set_media_trim",
      description: "Set a video scene's trim range in seconds.",
      argsSchema: z.object({
        sceneId: z.string().min(1),
        startSec: z.number().min(0),
        endSec: z.number().min(0)
      }),
      dispatch: async (args, ctx) => editScene(ctx.threadId, mutateScenes, args.sceneId, (s) => ({
        ...s,
        mediaTrim: { startSec: args.startSec, endSec: args.endSec }
      }))
    }),
    defineTool({
      namespace: "pwrsnap_sizzle",
      name: "scene_set_duration_override",
      description: "Force a specific scene duration in seconds, or null to clear the override.",
      argsSchema: z.object({ sceneId: z.string().min(1), durationSec: z.number().positive().nullable() }),
      dispatch: async (args, ctx) => editScene(ctx.threadId, mutateScenes, args.sceneId, (s) => ({
        ...s,
        durationOverrideSec: args.durationSec
      }))
    }),
    defineTool({
      namespace: "pwrsnap_sizzle",
      name: "project_render",
      description:
        "Render the current reel to an MP4. Long-running; returns the output path and total duration. Only call when the user explicitly asks to render.",
      argsSchema: z.object({}),
      annotations: { destructiveHint: true },
      dispatch: async (_args, ctx) => {
        const projectId = await deps.resolveProjectId(ctx.threadId);
        if (projectId === null) {
          return { ok: false, error: "No Sizzle project is linked to this chat." };
        }
        return runVerb("sizzle:render", { id: projectId });
      }
    })
  ] as ToolSpec<unknown>[];

  return tools;
}

/** Apply a single-scene edit by sceneId via the shared mutateScenes. */
function editScene(
  threadId: string,
  mutateScenes: (
    threadId: string,
    transform: (scenes: SizzleScene[], project: SizzleProject) => SizzleScene[] | { error: string }
  ) => Promise<ToolDispatchResult>,
  sceneId: string,
  patch: (s: SizzleScene) => SizzleScene
): Promise<ToolDispatchResult> {
  return mutateScenes(threadId, (scenes) => {
    let found = false;
    const next = scenes.map((s) => {
      if (s.id !== sceneId) return s;
      found = true;
      return patch(s);
    });
    return found ? next : { error: `Scene ${sceneId} not found.` };
  });
}
