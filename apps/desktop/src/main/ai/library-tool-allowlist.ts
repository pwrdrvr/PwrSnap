// The Library Chat tool catalog — the single audit surface for which
// command-bus verbs the agent may invoke (agent-native parity: "bus is
// the floor"). Every entry is a `defineTool` whose `dispatch` resolves
// to a command-bus dispatch and flattens the Result to the agent.
//
// Design note (plan §F8 / agent-native §F6): the layer model
// (`BundleLayerNode`) carries machine-managed fields — id, created_at,
// transform, z_index, source — that an LLM shouldn't hand-author. So
// the editing tools take the MEANINGFUL bits (the overlay shape, or a
// redaction rect) and the dispatch fills the boilerplate, exactly
// mirroring how the editor's `overlayToLayer` builds a node. This is a
// thin shim over the layer model, NOT a workflow wrapper that hides it.
//
// Coordinate spaces (load-bearing — wrong space ⇒ annotations land in
// the wrong place):
//   • VectorLayer.shape (arrow / rect / text / highlight) uses the
//     Overlay union's NORMALIZED [0,1] coords. Stored verbatim,
//     identical to a user-drawn overlay.
//   • EffectLayer.clip_rect (redaction) is CANVAS PIXELS. `add_redaction`
//     takes a normalized rect and multiplies by the capture's canvas
//     dimensions, mirroring overlayToLayer's blur branch.
//
// `render_composite` (vision grounding) is NOT yet available — the bus
// verb doesn't exist (fast-follow). Until then the agent grounds edits
// on list_layers + capture_metadata (OCR + dims) and asks when a target
// is ambiguous.

import { nanoid } from "nanoid";
import { z } from "zod";
import {
  BundleLayerNode,
  CanvasRect,
  Overlay,
  regionShapeSchema,
  type CaptureRecord,
  type CommandName,
  type Req
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

/** Fill the machine-managed CommonLayerProps for an AI-placed layer.
 *  Mirrors `overlayToLayer` but stamps `source: "codex"`. `applied_at =
 *  now` so the edit is immediately visible (Phase 1 applies directly;
 *  the accept/reject-badge gate is a Phase 2 refinement). */
function commonLayerProps(name: string): {
  id: string;
  parent_id: null;
  name: string;
  visible: true;
  locked: false;
  opacity: 1;
  blend_mode: "normal";
  transform: [number, number, number, number, number, number];
  z_index: 0;
  source: "codex";
  ai_run_id: null;
  applied_at: string;
  rejected_at: null;
  superseded_by: null;
  created_at: string;
} {
  const now = new Date().toISOString();
  return {
    id: nanoid(16),
    parent_id: null,
    name,
    visible: true,
    locked: false,
    opacity: 1,
    blend_mode: "normal",
    transform: [1, 0, 0, 1, 0, 0],
    z_index: 0,
    source: "codex",
    ai_run_id: null,
    applied_at: now,
    rejected_at: null,
    superseded_by: null,
    created_at: now
  };
}

/** Compact capture projection — keeps tool results small + token-cheap. */
function summarizeCapture(rec: CaptureRecord): Record<string, unknown> {
  return {
    id: rec.id,
    kind: rec.kind,
    captured_at: rec.captured_at,
    width_px: rec.width_px,
    height_px: rec.height_px,
    source_app: rec.source_app_name,
    bundle_format_version: rec.bundle_format_version
  };
}

// ---- read tools --------------------------------------------------------

const libraryList = defineTool({
  namespace: "pwrsnap_library",
  name: "library_list",
  description:
    "List recent captures, newest first. Returns compact summaries (id, kind, dimensions, source app, capture time). Use library_search to find by content.",
  annotations: { readOnlyHint: true },
  argsSchema: z.object({ limit: z.number().int().min(1).max(200).optional() }),
  dispatch: async (args) => {
    const result = await bus.dispatch(
      "library:list",
      { ...(args.limit !== undefined ? { limit: args.limit } : {}) },
      { principal: "mcp" }
    );
    if (!result.ok) {
      return {
        ok: false,
        error: `${result.error.kind}/${result.error.code}: ${result.error.message}`
      };
    }
    return { ok: true, data: { captures: result.value.rows.map(summarizeCapture) } };
  }
});

const librarySearch = defineTool({
  namespace: "pwrsnap_library",
  name: "library_search",
  description:
    "Full-text search captures by title, description, OCR text, and source-app name. Returns the matching rows.",
  annotations: { readOnlyHint: true },
  argsSchema: z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(50).optional()
  }),
  dispatch: async (args) => {
    const result = await bus.dispatch("library:search", { query: args.query }, { principal: "mcp" });
    if (!result.ok) {
      return {
        ok: false,
        error: `${result.error.kind}/${result.error.code}: ${result.error.message}`
      };
    }
    const limit = args.limit ?? 50;
    return { ok: true, data: { matches: result.value.rows.slice(0, limit) } };
  }
});

const captureMetadata = defineTool({
  namespace: "pwrsnap_library",
  name: "capture_metadata",
  description:
    "Get full metadata for one capture: dimensions, kind, source app, bundle format. Call this before editing so you know the canvas size for coordinate math.",
  annotations: { readOnlyHint: true },
  argsSchema: z.object({ capture_id: z.string() }),
  dispatch: async (args) => {
    const result = await bus.dispatch("library:byId", { id: args.capture_id }, { principal: "mcp" });
    if (!result.ok) {
      return {
        ok: false,
        error: `${result.error.kind}/${result.error.code}: ${result.error.message}`
      };
    }
    if (result.value === null) return { ok: false, error: `capture not found: ${args.capture_id}` };
    return { ok: true, data: result.value };
  }
});

const listLayers = defineTool({
  namespace: "pwrsnap_library",
  name: "list_layers",
  description:
    "List the annotation/effect layers on a capture (the edit tree). Refuses v1-format captures — open them in the editor first to upgrade.",
  annotations: { readOnlyHint: true },
  argsSchema: z.object({ capture_id: z.string() }),
  dispatch: async (args) => runVerb("layers:list", { captureId: args.capture_id })
});

// ---- edit tools --------------------------------------------------------

const addAnnotation = defineTool({
  namespace: "pwrsnap_library",
  name: "add_annotation",
  description:
    "Add an annotation to a capture: an arrow, rectangle, text label, or highlight. The `shape` uses NORMALIZED coordinates in [0,1] (0,0 = top-left, 1,1 = bottom-right). Stoplight colors: red=problem, green=fix, yellow=warning, blue=context. Returns the created layer including its id.",
  annotations: { destructiveHint: false },
  argsSchema: z.object({ capture_id: z.string(), shape: Overlay }),
  dispatch: async (args) => {
    const node = {
      ...commonLayerProps(`AI ${args.shape.kind}`),
      kind: "vector" as const,
      shape: args.shape
    };
    const parsed = BundleLayerNode.safeParse(node);
    if (!parsed.success) {
      return { ok: false, error: `built an invalid layer: ${parsed.error.message}` };
    }
    return runVerb("layers:upsert", {
      captureId: args.capture_id,
      layer: parsed.data,
      bumpZIndexToMax: true
    });
  }
});

const addRedaction = defineTool({
  namespace: "pwrsnap_library",
  name: "add_redaction",
  description:
    "Redact a region of a capture. `shape` is a discriminated shape; today the only `type` is \"rect\" with NORMALIZED [0,1] coords (x,y = top-left corner, w,h = size). Default style 'redact' is an OPAQUE BLACKOUT — irreversible, the correct choice for secrets (API keys, passwords, account/card/SSN numbers). 'pixelate' and 'gaussian' are REVERSIBLE — only for non-secret content (a face, a logo). Pad the shape slightly beyond the text so anti-aliased edges don't leak. Returns the created layer.",
  annotations: { destructiveHint: false },
  argsSchema: z.object({
    capture_id: z.string(),
    shape: regionShapeSchema,
    style: z.enum(["redact", "pixelate", "gaussian"]).optional(),
    radius_px: z.number().positive().max(200).optional()
  }),
  dispatch: async (args) => {
    const meta = await bus.dispatch("library:byId", { id: args.capture_id }, { principal: "mcp" });
    if (!meta.ok) {
      return { ok: false, error: `${meta.error.kind}/${meta.error.code}: ${meta.error.message}` };
    }
    if (meta.value === null) return { ok: false, error: `capture not found: ${args.capture_id}` };
    // The underlying EffectLayer clip is rectangular. `rect` is the only
    // region type today; circle/oval/triangle add cases here (and grow
    // the layer-model clip) when they ship.
    const { shape } = args;
    if (shape.type !== "rect") {
      return { ok: false, error: `redaction shape "${shape.type}" isn't supported yet — use type "rect"` };
    }
    const clip = CanvasRect.safeParse({
      x: shape.x * meta.value.width_px,
      y: shape.y * meta.value.height_px,
      w: shape.w * meta.value.width_px,
      h: shape.h * meta.value.height_px
    });
    if (!clip.success) {
      return { ok: false, error: `invalid redaction rect: ${clip.error.message}` };
    }
    const style = args.style ?? "redact";
    const node = {
      ...commonLayerProps("AI redaction"),
      kind: "effect" as const,
      effect: {
        type: "blur" as const,
        radius_px: args.radius_px ?? (style === "redact" ? 1 : 16),
        style
      },
      clip_rect: clip.data
    };
    const parsed = BundleLayerNode.safeParse(node);
    if (!parsed.success) {
      return { ok: false, error: `built an invalid redaction layer: ${parsed.error.message}` };
    }
    return runVerb("layers:upsert", {
      captureId: args.capture_id,
      layer: parsed.data,
      bumpZIndexToMax: true
    });
  }
});

const deleteLayer = defineTool({
  namespace: "pwrsnap_library",
  name: "delete_layer",
  description:
    "Remove a layer from a capture by its id (from list_layers, or the layer returned by add_*). Reversible by the user with ⌘Z.",
  annotations: { destructiveHint: true },
  argsSchema: z.object({ layer_id: z.string() }),
  dispatch: async (args) => runVerb("layers:delete", { id: args.layer_id })
});

const reorderLayer = defineTool({
  namespace: "pwrsnap_library",
  name: "reorder_layer",
  description:
    "Change a layer's z-order. Higher z_index renders on top. Use list_layers to see current ordering.",
  annotations: { idempotentHint: true },
  argsSchema: z.object({ layer_id: z.string(), z_index: z.number().int() }),
  dispatch: async (args) => runVerb("layers:reorder", { id: args.layer_id, zIndex: args.z_index })
});

const addTag = defineTool({
  namespace: "pwrsnap_library",
  name: "add_tag",
  description: "Add a content tag to a capture (e.g. 'invoice', 'bug-repro').",
  annotations: { idempotentHint: true },
  argsSchema: z.object({ capture_id: z.string(), label: z.string().min(1).max(64) }),
  dispatch: async (args) => runVerb("library:addTag", { captureId: args.capture_id, label: args.label })
});

const removeTag = defineTool({
  namespace: "pwrsnap_library",
  name: "remove_tag",
  description: "Remove a content tag from a capture by label. Idempotent.",
  annotations: { idempotentHint: true },
  argsSchema: z.object({ capture_id: z.string(), label: z.string().min(1).max(64) }),
  dispatch: async (args) =>
    runVerb("library:removeTag", { captureId: args.capture_id, label: args.label })
});

/**
 * The live catalog. Read tools first, then edits. Phase 1 ships these
 * 10; future phases add `render_composite` (vision), cross-capture
 * batch, and capture/recording verbs.
 */
export const LIBRARY_TOOL_ALLOWLIST: ToolSpec<unknown>[] = [
  libraryList,
  librarySearch,
  captureMetadata,
  listLayers,
  addAnnotation,
  addRedaction,
  deleteLayer,
  reorderLayer,
  addTag,
  removeTag
] as ToolSpec<unknown>[];
