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
// Coordinate spaces (load-bearing — wrong space ⇒ marks land in the
// wrong place):
//   • VectorLayer.shape (draw_arrow / draw_text / draw_highlight /
//     draw_rect) uses the Overlay union's NORMALIZED [0,1] coords,
//     stored verbatim — identical to a user-drawn overlay. The draw
//     tools pass the agent's normalized coords straight through.
//   • EffectLayer.clip_rect (redact / blur) is CANVAS PIXELS. Those
//     tools take a normalized rect and multiply by the capture's
//     canvas dimensions (upsertEffectRect), mirroring overlayToLayer's
//     blur branch.
//
// `render_composite` (vision grounding) renders the live canvas to a
// downscaled PNG (via the `render:composite` bus verb) and hands it
// back as an `inputImage` so the agent can SEE the canvas before it
// places a redaction / annotation. It still complements list_layers +
// capture_metadata (OCR + dims) for grounding when a target is
// ambiguous.

import { nanoid } from "nanoid";
import { z } from "zod";
import {
  BundleLayerNode,
  CanvasRect,
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

const renderComposite = defineTool({
  namespace: "pwrsnap_library",
  name: "render_composite",
  description:
    "Render the current canvas (source image + your applied edits) to a picture so you can SEE it. Call this BEFORE placing a redaction or annotation that depends on what's on screen (e.g. to locate a credit-card field), and again AFTER to verify the result landed where you intended. `max_edge_px` (default 720, max 1440) bounds the resolution. Image captures only.",
  annotations: { readOnlyHint: true },
  argsSchema: z.object({
    capture_id: z.string(),
    max_edge_px: z.number().int().min(64).max(1440).optional()
  }),
  dispatch: async (args) => {
    const result = await bus.dispatch(
      "render:composite",
      {
        captureId: args.capture_id,
        ...(args.max_edge_px !== undefined ? { maxEdgePx: args.max_edge_px } : {})
      },
      { principal: "mcp" }
    );
    if (!result.ok) {
      return {
        ok: false,
        error: `${result.error.kind}/${result.error.code}: ${result.error.message}`
      };
    }
    const { base64, mimeType, widthPx, heightPx } = result.value;
    return {
      ok: true,
      contentItems: [
        { type: "inputImage", imageUrl: `data:${mimeType};base64,${base64}` },
        {
          type: "inputText",
          text: `Canvas composite shown at ${widthPx}x${heightPx}px (downscaled preview). When you place an annotation or redaction, give coordinates NORMALIZED to [0,1] of the FULL canvas — (0,0) top-left, (1,1) bottom-right — not these preview pixels.`
        }
      ]
    };
  }
});

const openInLibrary = defineTool({
  namespace: "pwrsnap_library",
  name: "open_in_library",
  description:
    "Bring the Library window forward and scroll to / select a capture in inline Focus mode. A read-only navigation aid (no data changes).",
  annotations: { readOnlyHint: true },
  argsSchema: z.object({ capture_id: z.string() }),
  dispatch: async (args) => runVerb("library:openInLibrary", { captureId: args.capture_id })
});

const openEditor = defineTool({
  namespace: "pwrsnap_library",
  name: "open_editor",
  description:
    "Open an IMAGE capture in its own editor window. Use when the user wants to hand-edit; for AI edits you can use draw_arrow / draw_text / draw_rect / redact / blur etc. directly without opening anything. Video captures aren't editable here — don't open them.",
  annotations: {},
  argsSchema: z.object({ capture_id: z.string() }),
  dispatch: async (args) => {
    // The still-image editor can't render a video (it shows a broken
    // image). Refuse video captures so the agent doesn't open one.
    const meta = await bus.dispatch("library:byId", { id: args.capture_id }, { principal: "mcp" });
    if (!meta.ok) {
      return { ok: false, error: `${meta.error.kind}/${meta.error.code}: ${meta.error.message}` };
    }
    if (meta.value === null) return { ok: false, error: `capture not found: ${args.capture_id}` };
    if (meta.value.kind !== "image") {
      return {
        ok: false,
        error: `open_editor only supports image captures (this is a ${meta.value.kind}). View it in the Library instead.`
      };
    }
    return runVerb("editor:open", { captureId: args.capture_id });
  }
});

const listLayerCapabilities = defineTool({
  namespace: "pwrsnap_library",
  name: "list_layer_capabilities",
  description:
    "Describe what you can place on a capture: the draw tools (draw_arrow / draw_text / draw_highlight / draw_rect), the effect tools (redact / blur), and the coordinate convention. Call this if you're unsure what's available.",
  annotations: { readOnlyHint: true },
  argsSchema: z.object({}),
  dispatch: async () => ({
    ok: true,
    data: {
      coordinate_system: "normalized [0,1] of the canvas; (0,0)=top-left, (1,1)=bottom-right",
      draw_tools: ["draw_arrow", "draw_text", "draw_highlight", "draw_rect"],
      planned_draw_tools: ["draw_circle", "draw_oval", "draw_square", "draw_triangle"],
      effect_tools: {
        redact: "opaque blackout over a rect — IRREVERSIBLE, use for secrets",
        blur: "soften a rect (gaussian, or pixelate=true for mosaic) — REVERSIBLE, non-secret content only"
      },
      stoplight_colors: {
        red: "problem / failure",
        green: "fix / confirmation",
        yellow: "warning",
        blue: "neutral context"
      },
      vision: "call render_composite to see the current canvas"
    }
  })
});

// ---- edit tools --------------------------------------------------------
//
// One tool per primitive (draw_arrow / draw_text / draw_highlight /
// draw_rect / redact / blur) rather than a single polymorphic
// add_annotation taking a discriminated union. Rationale: models are
// reliable at PICKING a named tool but weaker at correctly pairing a
// discriminator with its matching fields — so the agent picks
// `draw_highlight` and sees only highlight's flat settings. Still
// primitives (the agent composes novel results from them), NOT
// workflow wrappers. New shapes (circle/oval/square/triangle) land as
// new draw_* tools.

/** Shared fragments — flat, normalized [0,1] coords. Points allow
 *  values slightly outside [0,1] so an arrow can come in from off-
 *  canvas (matches the Overlay schema's finite-scalar tolerance + the
 *  system prompt's artistic-license guidance). */
const hexColor = z.string().regex(/^#[0-9a-f]{6}$/i);
const normPoint = z.object({ x: z.number().finite(), y: z.number().finite() });
const normRect = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().positive(),
  h: z.number().finite().positive()
});

/** Build + upsert a VectorLayer wrapping a plain Overlay shape. The
 *  shape object is validated by BundleLayerNode.safeParse. */
async function upsertVector(
  captureId: string,
  shape: Record<string, unknown>,
  name: string
): Promise<ToolDispatchResult> {
  const node = { ...commonLayerProps(name), kind: "vector" as const, shape };
  const parsed = BundleLayerNode.safeParse(node);
  if (!parsed.success) {
    return { ok: false, error: `built an invalid ${name}: ${parsed.error.message}` };
  }
  return runVerb("layers:upsert", { captureId, layer: parsed.data, bumpZIndexToMax: true });
}

/** Build + upsert an EffectLayer (blur/redact) clipped to a NORMALIZED
 *  rect. Fetches the capture's canvas dims to convert normalized →
 *  pixel clip_rect. */
async function upsertEffectRect(
  captureId: string,
  rect: { x: number; y: number; w: number; h: number },
  effect: { type: "blur"; radius_px: number; style: "redact" | "pixelate" | "gaussian" },
  name: string
): Promise<ToolDispatchResult> {
  const meta = await bus.dispatch("library:byId", { id: captureId }, { principal: "mcp" });
  if (!meta.ok) {
    return { ok: false, error: `${meta.error.kind}/${meta.error.code}: ${meta.error.message}` };
  }
  if (meta.value === null) return { ok: false, error: `capture not found: ${captureId}` };
  const clip = CanvasRect.safeParse({
    x: rect.x * meta.value.width_px,
    y: rect.y * meta.value.height_px,
    w: rect.w * meta.value.width_px,
    h: rect.h * meta.value.height_px
  });
  if (!clip.success) return { ok: false, error: `invalid rect: ${clip.error.message}` };
  const node = {
    ...commonLayerProps(name),
    kind: "effect" as const,
    effect,
    clip_rect: clip.data
  };
  const parsed = BundleLayerNode.safeParse(node);
  if (!parsed.success) {
    return { ok: false, error: `built an invalid ${name}: ${parsed.error.message}` };
  }
  return runVerb("layers:upsert", { captureId, layer: parsed.data, bumpZIndexToMax: true });
}

const drawArrow = defineTool({
  namespace: "pwrsnap_library",
  name: "draw_arrow",
  description:
    "Draw an arrow. `from`/`to` are NORMALIZED points — (0,0)=top-left, (1,1)=bottom-right. Endpoints MAY sit slightly outside [0,1] for an arrow coming in from off-canvas. `color` is #rrggbb (omit = auto). Optional `label` rides at the tail. Stoplight: red=problem, green=fix, yellow=warning, blue=context.",
  annotations: { destructiveHint: false },
  argsSchema: z.object({
    capture_id: z.string(),
    from: normPoint,
    to: normPoint,
    color: hexColor.optional(),
    label: z.string().max(80).optional(),
    double_ended: z.boolean().optional()
  }),
  dispatch: async (args) =>
    upsertVector(
      args.capture_id,
      {
        kind: "arrow",
        from: args.from,
        to: args.to,
        color: args.color ?? "auto",
        ...(args.label !== undefined ? { label: args.label } : {}),
        ...(args.double_ended !== undefined ? { doubleEnded: args.double_ended } : {})
      },
      "AI arrow"
    )
});

const drawText = defineTool({
  namespace: "pwrsnap_library",
  name: "draw_text",
  description:
    "Place a text label. `at` is a NORMALIZED anchor point [0,1] — keep labels fully on-canvas so they're readable. `color` is #rrggbb (omit = auto). `size` small|medium|large, `weight` regular|bold.",
  annotations: { destructiveHint: false },
  argsSchema: z.object({
    capture_id: z.string(),
    at: normPoint,
    body: z.string().min(1).max(2000),
    color: hexColor.optional(),
    size: z.enum(["small", "medium", "large"]).optional(),
    weight: z.enum(["regular", "bold"]).optional()
  }),
  dispatch: async (args) =>
    upsertVector(
      args.capture_id,
      {
        kind: "text",
        point: args.at,
        body: args.body,
        color: args.color ?? "auto",
        size: args.size ?? "medium",
        ...(args.weight !== undefined ? { weight: args.weight } : {})
      },
      "AI text"
    )
});

const drawHighlight = defineTool({
  namespace: "pwrsnap_library",
  name: "draw_highlight",
  description:
    "Draw a translucent highlight over a region — like a marker. `rect` is NORMALIZED [0,1] {x,y,w,h}. `color` #rrggbb (omit = yellow). `opacity` 0–1 (omit = sensible default).",
  annotations: { destructiveHint: false },
  argsSchema: z.object({
    capture_id: z.string(),
    rect: normRect,
    color: hexColor.optional(),
    opacity: z.number().min(0).max(1).optional()
  }),
  dispatch: async (args) =>
    upsertVector(
      args.capture_id,
      {
        kind: "highlight",
        rect: args.rect,
        ...(args.color !== undefined ? { color: args.color } : {}),
        ...(args.opacity !== undefined ? { opacity: args.opacity } : {})
      },
      "AI highlight"
    )
});

const drawRect = defineTool({
  namespace: "pwrsnap_library",
  name: "draw_rect",
  description:
    "Draw a rectangle. `rect` is NORMALIZED [0,1] {x,y,w,h} (x,y = top-left, w,h = size). `color` #rrggbb (omit = auto). `filled` true = solid fill, false/omit = outline only. (Circles, ovals, squares, and triangles will arrive as their own draw_* tools.)",
  annotations: { destructiveHint: false },
  argsSchema: z.object({
    capture_id: z.string(),
    rect: normRect,
    color: hexColor.optional(),
    filled: z.boolean().optional()
  }),
  dispatch: async (args) =>
    upsertVector(
      args.capture_id,
      {
        kind: "rect",
        rect: args.rect,
        color: args.color ?? "auto",
        ...(args.filled !== undefined ? { filled: args.filled } : {})
      },
      "AI rect"
    )
});

const redact = defineTool({
  namespace: "pwrsnap_library",
  name: "redact",
  description:
    "Black out a rectangular region — OPAQUE and IRREVERSIBLE. The correct tool for secrets (API keys, passwords, account/card/SSN numbers). `rect` is NORMALIZED [0,1] {x,y,w,h}; pad it slightly beyond the text so anti-aliased edges don't leak. For non-secret softening (a face, a logo) use `blur` instead.",
  annotations: { destructiveHint: false },
  argsSchema: z.object({ capture_id: z.string(), rect: normRect }),
  dispatch: async (args) =>
    upsertEffectRect(
      args.capture_id,
      args.rect,
      { type: "blur", radius_px: 1, style: "redact" },
      "AI redaction"
    )
});

const blur = defineTool({
  namespace: "pwrsnap_library",
  name: "blur",
  description:
    "Soften a rectangular region — REVERSIBLE (deconvolution can recover it). Use ONLY for non-secret content like a face or a logo; for secrets use `redact` (opaque blackout). `rect` is NORMALIZED [0,1] {x,y,w,h}. `pixelate` true = chunky mosaic, false/omit = gaussian smear. `radius_px` controls strength (default 16).",
  annotations: { destructiveHint: false },
  argsSchema: z.object({
    capture_id: z.string(),
    rect: normRect,
    pixelate: z.boolean().optional(),
    radius_px: z.number().positive().max(200).optional()
  }),
  dispatch: async (args) =>
    upsertEffectRect(
      args.capture_id,
      args.rect,
      {
        type: "blur",
        radius_px: args.radius_px ?? 16,
        style: args.pixelate === true ? "pixelate" : "gaussian"
      },
      "AI blur"
    )
});

const deleteLayer = defineTool({
  namespace: "pwrsnap_library",
  name: "delete_layer",
  description:
    "Remove a layer from a capture by its id (from list_layers, or the layer returned by a draw_* / redact / blur call). Reversible by the user with ⌘Z.",
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
 * The live catalog — 18 tools. Read / introspect / navigate first, then
 * the per-primitive edit tools. Future phases add cross-capture batch,
 * paste-image, and capture/recording verbs.
 */
export const LIBRARY_TOOL_ALLOWLIST: ToolSpec<unknown>[] = [
  // read / introspect / navigate
  libraryList,
  librarySearch,
  captureMetadata,
  listLayers,
  listLayerCapabilities,
  renderComposite,
  openInLibrary,
  openEditor,
  // edit — one tool per primitive
  drawArrow,
  drawText,
  drawHighlight,
  drawRect,
  redact,
  blur,
  deleteLayer,
  reorderLayer,
  addTag,
  removeTag
] as ToolSpec<unknown>[];
