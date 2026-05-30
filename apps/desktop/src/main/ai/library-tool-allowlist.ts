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
import {
  ArrowEndStyle,
  ArrowStemStyle,
  OverlayThickness,
  ShapeKind
} from "@pwrsnap/shared/overlay";
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

/** Char cap on OCR text returned to the agent — bounds token cost.
 *  Most screenshots OCR to far less; `read_ocr_text` flags truncation. */
const OCR_MAX_CHARS = 16_000;

const captureMetadata = defineTool({
  namespace: "pwrsnap_library",
  name: "capture_metadata",
  description:
    "Get full metadata for one capture: dimensions, kind, source app, bundle format, PLUS PwrSnap's AI title + description + tags and whether OCR text is available. Call this before editing so you know the canvas size for coordinate math and what the capture is about. Use read_ocr_text to read the full OCR'd text.",
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
    // Merge in the enrichment (AI title/description/tags + OCR presence).
    // Best-effort: a capture with no enrichment row just reports nulls.
    const enr = await bus.dispatch(
      "codex:enrichment",
      { captureId: args.capture_id },
      { principal: "mcp" }
    );
    const e = enr.ok ? enr.value : null;
    const ocrLen = e?.ocrText?.length ?? 0;
    return {
      ok: true,
      data: {
        ...result.value,
        title: e ? (e.acceptedTitle ?? e.suggestedTitle) : null,
        description: e ? (e.acceptedDescription ?? e.suggestedDescription) : null,
        tags: e?.acceptedTags ?? [],
        has_ocr_text: ocrLen > 0,
        ocr_text_chars: ocrLen
      }
    };
  }
});

const readOcrText = defineTool({
  namespace: "pwrsnap_library",
  name: "read_ocr_text",
  description:
    "Read the text PwrSnap OCR'd out of an image capture. Use it to FIND text to redact (secrets, account / card / SSN numbers, emails) or to answer questions about what the capture says — read the text rather than guessing from the picture. Returns up to 16000 characters; `truncated` is true when the OCR was longer.",
  annotations: { readOnlyHint: true },
  argsSchema: z.object({ capture_id: z.string() }),
  dispatch: async (args) => {
    const enr = await bus.dispatch(
      "codex:enrichment",
      { captureId: args.capture_id },
      { principal: "mcp" }
    );
    if (!enr.ok) {
      return { ok: false, error: `${enr.error.kind}/${enr.error.code}: ${enr.error.message}` };
    }
    const ocr = enr.value?.ocrText ?? "";
    if (ocr.length === 0) {
      return {
        ok: true,
        data: {
          capture_id: args.capture_id,
          ocr_text: "",
          length: 0,
          truncated: false,
          note: "No OCR text for this capture (it may be a non-text image, or enrichment hasn't run yet)."
        }
      };
    }
    const truncated = ocr.length > OCR_MAX_CHARS;
    return {
      ok: true,
      data: {
        capture_id: args.capture_id,
        ocr_text: truncated ? ocr.slice(0, OCR_MAX_CHARS) : ocr,
        length: ocr.length,
        truncated
      }
    };
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
    "Open an IMAGE capture in the Library Focus editor. Use when the user wants to hand-edit; for AI edits you can use draw_arrow / draw_text / draw_rect / redact / blur etc. directly without opening anything. Video captures aren't editable here — don't open them.",
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
    "Describe what you can place or update on a capture: draw tools, effect tools, update_layer, and the coordinate/style conventions. Call this if you're unsure what's available.",
  annotations: { readOnlyHint: true },
  argsSchema: z.object({}),
  dispatch: async () => ({
    ok: true,
    data: {
      coordinate_system: "normalized [0,1] of the canvas; (0,0)=top-left, (1,1)=bottom-right",
      draw_tools: [
        "draw_arrow",
        "draw_text",
        "draw_highlight",
        "draw_rect",
        "draw_square",
        "draw_circle",
        "draw_oval",
        "draw_parallelogram"
      ],
      shape_note:
        "rect/square/circle/oval/parallelogram share a normalized bounding rect; keep w==h for a true square or circle. filled=true for solid, omit for outline.",
      text_tools:
        "capture_metadata returns the AI title/description/tags + whether OCR exists; read_ocr_text returns the OCR'd text — use it to locate secrets/text to redact rather than guessing from the picture.",
      effect_tools: {
        redact: "opaque blackout over a rect — IRREVERSIBLE, use for secrets",
        blur: "soften a rect (gaussian, or pixelate=true for mosaic) — REVERSIBLE, non-secret content only"
      },
      update_tool:
        "update_layer edits an existing layer in place. Use it for style-only changes like thickness=large/x-large, color, arrow endpoints, text body/weight, shape rect/fill, or blur radius.",
      thickness:
        "arrow and shape tools accept thickness auto|small|medium|large|x-large or a normalized numeric stroke fraction",
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
// draw_rect / draw_square / draw_circle / draw_oval /
// draw_parallelogram / redact / blur) rather than a single polymorphic
// add_annotation taking a discriminated union. Rationale: models are
// reliable at PICKING a named tool but weaker at correctly pairing a
// discriminator with its matching fields — so the agent picks
// `draw_highlight` and sees only highlight's flat settings. The five
// shape tools all build main's v2 `ShapeOverlay` (kind: "shape" + a
// `shape` discriminator) under the hood via `upsertShape`. Still
// primitives (the agent composes novel results from them), NOT
// workflow wrappers.

/** Shared fragments — flat, normalized [0,1] coords. Points allow
 *  values slightly outside [0,1] so an arrow can come in from off-
 *  canvas (matches the Overlay schema's finite-scalar tolerance + the
 *  system prompt's artistic-license guidance). */
const hexColor = z.string().regex(/^#[0-9a-f]{6}$/i);
const toolColor = z.union([z.literal("auto"), hexColor]);
const overlayThickness = OverlayThickness;
const arrowEndStyle = ArrowEndStyle;
const arrowStemStyle = ArrowStemStyle;
const shapeKind = ShapeKind;
const normPoint = z.object({ x: z.number().finite(), y: z.number().finite() });
const normRect = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().positive(),
  h: z.number().finite().positive()
});

type BundleLayerNodeValue = z.infer<typeof BundleLayerNode>;

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

async function getCaptureDims(
  captureId: string
): Promise<
  | { ok: true; widthPx: number; heightPx: number }
  | { ok: false; error: string }
> {
  const meta = await bus.dispatch("library:byId", { id: captureId }, { principal: "mcp" });
  if (!meta.ok) {
    return { ok: false, error: `${meta.error.kind}/${meta.error.code}: ${meta.error.message}` };
  }
  if (meta.value === null) return { ok: false, error: `capture not found: ${captureId}` };
  return { ok: true, widthPx: meta.value.width_px, heightPx: meta.value.height_px };
}

function canvasRectFromNormalized(
  rect: { x: number; y: number; w: number; h: number },
  dims: { widthPx: number; heightPx: number }
): z.infer<typeof CanvasRect> | string {
  const clip = CanvasRect.safeParse({
    x: rect.x * dims.widthPx,
    y: rect.y * dims.heightPx,
    w: rect.w * dims.widthPx,
    h: rect.h * dims.heightPx
  });
  return clip.success ? clip.data : `invalid rect: ${clip.error.message}`;
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
  const dims = await getCaptureDims(captureId);
  if (!dims.ok) return { ok: false, error: dims.error };
  const clip = canvasRectFromNormalized(rect, dims);
  if (typeof clip === "string") return { ok: false, error: clip };
  const node = {
    ...commonLayerProps(name),
    kind: "effect" as const,
    effect,
    clip_rect: clip
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
    "Draw an arrow. `from`/`to` are NORMALIZED points — (0,0)=top-left, (1,1)=bottom-right. Endpoints MAY sit slightly outside [0,1] for an arrow coming in from off-canvas. `color` is #rrggbb (omit = auto). `thickness` is auto|small|medium|large|x-large or a normalized numeric stroke fraction; use this for heavier/thicker arrows, NOT multiple overlapping arrows. Optional `label` rides at the tail. `end_style` filled-triangle|open-triangle|line|dot, `stem_style` solid|dashed|dotted. Stoplight: red=problem, green=fix, yellow=warning, blue=context.",
  annotations: { destructiveHint: false },
  argsSchema: z.object({
    capture_id: z.string(),
    from: normPoint,
    to: normPoint,
    color: hexColor.optional(),
    thickness: overlayThickness.optional(),
    label: z.string().max(80).optional(),
    end_style: arrowEndStyle.optional(),
    stem_style: arrowStemStyle.optional(),
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
        ...(args.thickness !== undefined ? { thickness: args.thickness } : {}),
        ...(args.label !== undefined ? { label: args.label } : {}),
        ...(args.end_style !== undefined ? { endStyle: args.end_style } : {}),
        ...(args.stem_style !== undefined ? { stemStyle: args.stem_style } : {}),
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

// Shapes (rect / square / circle / oval / parallelogram) are all the v2
// `ShapeOverlay`: a normalized bounding `rect` + a `shape` discriminator,
// plus color / filled / rotation (and skewDeg for parallelogram). One
// tool per shape — the agent picks a named tool and only sees that
// shape's flat settings — but they all funnel through `upsertShape`.

/** Build + upsert a ShapeOverlay. `shape` is main's ShapeKind
 *  discriminator; square + circle are 1:1-locked in the editor, so the
 *  tool descriptions tell the agent to keep w == h for those. */
async function upsertShape(
  captureId: string,
  shape: "rect" | "square" | "circle" | "oval" | "parallelogram",
  args: {
    rect: { x: number; y: number; w: number; h: number };
    color?: string | undefined;
    thickness?: z.infer<typeof overlayThickness> | undefined;
    filled?: boolean | undefined;
    rotation?: number | undefined;
    skewDeg?: number | undefined;
  },
  name: string
): Promise<ToolDispatchResult> {
  return upsertVector(
    captureId,
    {
      kind: "shape",
      shape,
      rect: args.rect,
      color: args.color ?? "auto",
      ...(args.thickness !== undefined ? { thickness: args.thickness } : {}),
      ...(args.filled !== undefined ? { filled: args.filled } : {}),
      ...(args.rotation !== undefined ? { rotation: args.rotation } : {}),
      ...(shape === "parallelogram" && args.skewDeg !== undefined
        ? { skewDeg: args.skewDeg }
        : {})
    },
    name
  );
}

/** Shared arg schema for the aspect-free shape tools. */
const shapeArgsSchema = z.object({
  capture_id: z.string(),
  rect: normRect,
  color: hexColor.optional(),
  thickness: overlayThickness.optional(),
  filled: z.boolean().optional(),
  rotation: z.number().finite().optional()
});

const drawRect = defineTool({
  namespace: "pwrsnap_library",
  name: "draw_rect",
  description:
    "Draw a rectangle. `rect` is NORMALIZED [0,1] {x,y,w,h} (x,y = top-left, w,h = size). `color` #rrggbb (omit = auto). `thickness` auto|small|medium|large|x-large or numeric. `filled` true = solid fill, false/omit = outline only. `rotation` radians clockwise around the rect center (omit = 0).",
  annotations: { destructiveHint: false },
  argsSchema: shapeArgsSchema,
  dispatch: async (args) => upsertShape(args.capture_id, "rect", args, "AI rectangle")
});

const drawSquare = defineTool({
  namespace: "pwrsnap_library",
  name: "draw_square",
  description:
    "Draw a square. Give a NORMALIZED bounding `rect` {x,y,w,h}; keep w and h equal for a true square. `color` #rrggbb (omit = auto). `thickness` auto|small|medium|large|x-large or numeric. `filled` true = solid, false/omit = outline. `rotation` radians (omit = 0).",
  annotations: { destructiveHint: false },
  argsSchema: shapeArgsSchema,
  dispatch: async (args) => upsertShape(args.capture_id, "square", args, "AI square")
});

const drawCircle = defineTool({
  namespace: "pwrsnap_library",
  name: "draw_circle",
  description:
    "Draw a circle inscribed in a NORMALIZED bounding `rect` {x,y,w,h}; keep w and h equal so it's round (use draw_oval for a stretched ellipse). `color` #rrggbb (omit = auto). `thickness` auto|small|medium|large|x-large or numeric. `filled` true = solid, false/omit = outline.",
  annotations: { destructiveHint: false },
  argsSchema: shapeArgsSchema,
  dispatch: async (args) => upsertShape(args.capture_id, "circle", args, "AI circle")
});

const drawOval = defineTool({
  namespace: "pwrsnap_library",
  name: "draw_oval",
  description:
    "Draw an oval / ellipse inscribed in a NORMALIZED bounding `rect` {x,y,w,h} (free aspect). `color` #rrggbb (omit = auto). `thickness` auto|small|medium|large|x-large or numeric. `filled` true = solid, false/omit = outline. `rotation` radians (omit = 0).",
  annotations: { destructiveHint: false },
  argsSchema: shapeArgsSchema,
  dispatch: async (args) => upsertShape(args.capture_id, "oval", args, "AI oval")
});

const drawParallelogram = defineTool({
  namespace: "pwrsnap_library",
  name: "draw_parallelogram",
  description:
    "Draw a parallelogram in a NORMALIZED bounding `rect` {x,y,w,h}. `skew_deg` = horizontal skew in degrees, positive shifts the top edge right (omit = 15). `color` #rrggbb (omit = auto). `thickness` auto|small|medium|large|x-large or numeric. `filled` true = solid, false/omit = outline. `rotation` radians (omit = 0).",
  annotations: { destructiveHint: false },
  argsSchema: z.object({
    capture_id: z.string(),
    rect: normRect,
    color: hexColor.optional(),
    thickness: overlayThickness.optional(),
    filled: z.boolean().optional(),
    rotation: z.number().finite().optional(),
    skew_deg: z.number().finite().optional()
  }),
  dispatch: async (args) =>
    upsertShape(
      args.capture_id,
      "parallelogram",
      {
        rect: args.rect,
        color: args.color,
        thickness: args.thickness,
        filled: args.filled,
        rotation: args.rotation,
        skewDeg: args.skew_deg
      },
      "AI parallelogram"
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

const updateLayerArgsSchema = z.object({
  capture_id: z.string(),
  layer_id: z.string(),
  from: normPoint.optional(),
  to: normPoint.optional(),
  rect: normRect.optional(),
  at: normPoint.optional(),
  color: toolColor.optional(),
  label: z.string().max(80).nullable().optional(),
  body: z.string().min(1).max(2000).optional(),
  thickness: overlayThickness.optional(),
  end_style: arrowEndStyle.optional(),
  stem_style: arrowStemStyle.optional(),
  double_ended: z.boolean().optional(),
  shape: shapeKind.optional(),
  filled: z.boolean().optional(),
  rotation: z.number().finite().optional(),
  skew_deg: z.number().finite().optional(),
  opacity: z.number().min(0).max(1).optional(),
  size: z.enum(["small", "medium", "large"]).optional(),
  weight: z.enum(["regular", "bold"]).optional(),
  radius_px: z.number().positive().max(200).optional(),
  pixelate: z.boolean().optional()
});

type UpdateLayerArgs = z.infer<typeof updateLayerArgsSchema>;

async function loadCurrentLayer(
  captureId: string,
  layerId: string
): Promise<
  | { ok: true; layer: BundleLayerNodeValue }
  | { ok: false; error: string }
> {
  const listed = await bus.dispatch("layers:list", { captureId }, { principal: "mcp" });
  if (!listed.ok) {
    return { ok: false, error: `${listed.error.kind}/${listed.error.code}: ${listed.error.message}` };
  }
  const layer = listed.value.find((candidate) => candidate.id === layerId);
  if (layer === undefined) return { ok: false, error: `layer not found: ${layerId}` };
  return { ok: true, layer };
}

function hasAny(args: UpdateLayerArgs, keys: readonly (keyof UpdateLayerArgs)[]): boolean {
  return keys.some((key) => args[key] !== undefined);
}

async function applyAgentLayerPatch(
  layer: BundleLayerNodeValue,
  args: UpdateLayerArgs
): Promise<ToolDispatchResult> {
  const invalidForArrow = hasAny(args, [
    "rect",
    "at",
    "body",
    "shape",
    "filled",
    "opacity",
    "size",
    "weight",
    "rotation",
    "skew_deg",
    "radius_px",
    "pixelate"
  ]);
  const invalidForText = hasAny(args, [
    "from",
    "to",
    "rect",
    "label",
    "thickness",
    "end_style",
    "stem_style",
    "double_ended",
    "shape",
    "filled",
    "opacity",
    "skew_deg",
    "radius_px",
    "pixelate"
  ]);
  const invalidForShape = hasAny(args, [
    "from",
    "to",
    "at",
    "label",
    "body",
    "end_style",
    "stem_style",
    "double_ended",
    "opacity",
    "size",
    "weight",
    "radius_px",
    "pixelate"
  ]);
  const invalidForHighlight = hasAny(args, [
    "from",
    "to",
    "at",
    "label",
    "body",
    "thickness",
    "end_style",
    "stem_style",
    "double_ended",
    "shape",
    "filled",
    "size",
    "weight",
    "skew_deg",
    "radius_px",
    "pixelate"
  ]);

  if (layer.kind === "vector") {
    const shape = { ...layer.shape };
    switch (shape.kind) {
      case "arrow":
        if (invalidForArrow) return { ok: false, error: "patch fields do not apply to an arrow layer" };
        if (args.from !== undefined) shape.from = args.from;
        if (args.to !== undefined) shape.to = args.to;
        if (args.color !== undefined) shape.color = args.color;
        if (args.thickness !== undefined) shape.thickness = args.thickness;
        if (args.label !== undefined) {
          if (args.label === null) delete shape.label;
          else shape.label = args.label;
        }
        if (args.end_style !== undefined) shape.endStyle = args.end_style;
        if (args.stem_style !== undefined) shape.stemStyle = args.stem_style;
        if (args.double_ended !== undefined) shape.doubleEnded = args.double_ended;
        break;
      case "text":
        if (invalidForText) return { ok: false, error: "patch fields do not apply to a text layer" };
        if (args.at !== undefined) shape.point = args.at;
        if (args.body !== undefined) shape.body = args.body;
        if (args.color !== undefined) shape.color = args.color;
        if (args.size !== undefined) shape.size = args.size;
        if (args.weight !== undefined) shape.weight = args.weight;
        if (args.rotation !== undefined) shape.rotation = args.rotation;
        break;
      case "shape":
        if (invalidForShape) return { ok: false, error: "patch fields do not apply to a shape layer" };
        if (args.rect !== undefined) shape.rect = args.rect;
        if (args.color !== undefined) shape.color = args.color;
        if (args.thickness !== undefined) shape.thickness = args.thickness;
        if (args.shape !== undefined) shape.shape = args.shape;
        if (args.filled !== undefined) shape.filled = args.filled;
        if (args.rotation !== undefined) shape.rotation = args.rotation;
        if (args.skew_deg !== undefined) shape.skewDeg = args.skew_deg;
        break;
      case "highlight":
        if (invalidForHighlight) {
          return { ok: false, error: "patch fields do not apply to a highlight layer" };
        }
        if (args.rect !== undefined) shape.rect = args.rect;
        if (args.color !== undefined) shape.color = args.color;
        if (args.opacity !== undefined) shape.opacity = args.opacity;
        if (args.rotation !== undefined) shape.rotation = args.rotation;
        break;
      default:
        return { ok: false, error: `update_layer cannot edit vector kind "${shape.kind}" yet` };
    }
    return { ok: true, data: { ...layer, shape } };
  }

  if (layer.kind !== "effect") {
    return { ok: false, error: `update_layer can only edit vector/effect layers, not ${layer.kind}` };
  }

  if (
    hasAny(args, [
      "from",
      "to",
      "at",
      "color",
      "label",
      "body",
      "thickness",
      "end_style",
      "stem_style",
      "double_ended",
      "shape",
      "filled",
      "opacity",
      "size",
      "weight",
      "skew_deg"
    ])
  ) {
    return { ok: false, error: "patch fields do not apply to an effect layer" };
  }

  let clipRect = layer.clip_rect;
  if (args.rect !== undefined) {
    const dims = await getCaptureDims(args.capture_id);
    if (!dims.ok) return { ok: false, error: dims.error };
    const converted = canvasRectFromNormalized(args.rect, dims);
    if (typeof converted === "string") return { ok: false, error: converted };
    clipRect = converted;
  }

  if (layer.effect.type !== "blur") {
    if (args.radius_px !== undefined || args.pixelate !== undefined) {
      return { ok: false, error: "radius_px/pixelate only apply to blur/redaction layers" };
    }
    return { ok: true, data: { ...layer, clip_rect: clipRect } };
  }

  const effect = { ...layer.effect };
  if (args.radius_px !== undefined) effect.radius_px = args.radius_px;
  if (args.rotation !== undefined) effect.rotation = args.rotation;
  if (args.pixelate !== undefined) {
    effect.style = args.pixelate ? "pixelate" : "gaussian";
  }
  return { ok: true, data: { ...layer, clip_rect: clipRect, effect } };
}

const updateLayerTool = defineTool({
  namespace: "pwrsnap_library",
  name: "update_layer",
  description:
    "Edit one existing layer in place by id. Use list_layers first, then change only the requested fields. This preserves the layer id/z-order and is the right tool for 'make that arrow heavier/thicker' (`thickness`: auto|small|medium|large|x-large), color changes, moving endpoints/rects, text edits, and blur strength. Do NOT delete and redraw just to change style.",
  annotations: { idempotentHint: true },
  argsSchema: updateLayerArgsSchema,
  dispatch: async (args) => {
    const current = await loadCurrentLayer(args.capture_id, args.layer_id);
    if (!current.ok) return { ok: false, error: current.error };
    const patched = await applyAgentLayerPatch(current.layer, args);
    if (!patched.ok) return patched;
    if (!("data" in patched)) {
      return { ok: false, error: "update_layer built no layer payload" };
    }
    const parsed = BundleLayerNode.safeParse(patched.data);
    if (!parsed.success) {
      return { ok: false, error: `built an invalid layer update: ${parsed.error.message}` };
    }
    return runVerb("layers:update", { captureId: args.capture_id, layer: parsed.data });
  }
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
 * The live catalog — 23 tools. Read / introspect / navigate first, then
 * the per-primitive edit tools (one per draw shape + the two effects).
 * Future phases add cross-capture batch, paste-image, and capture/
 * recording verbs.
 */
export const LIBRARY_TOOL_ALLOWLIST: ToolSpec<unknown>[] = [
  // read / introspect / navigate
  libraryList,
  librarySearch,
  captureMetadata,
  readOcrText,
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
  drawSquare,
  drawCircle,
  drawOval,
  drawParallelogram,
  redact,
  blur,
  updateLayerTool,
  deleteLayer,
  reorderLayer,
  addTag,
  removeTag
] as ToolSpec<unknown>[];
