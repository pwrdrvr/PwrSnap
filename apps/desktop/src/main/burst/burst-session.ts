// A stopped burst, waiting for the user to choose which stills to keep.
//
// The recorder writes the stills into a temp directory the recording
// service created (`pwrsnap-burst-*` under the OS temp dir). On Stop the
// service hands that directory to this registry, which owns it from then
// on: it serves the stills to the Burst Review window, turns the chosen
// ones into ordinary snaps, and deletes the directory when the session
// ends (keep, discard, window closed, app quit). A crash leaves the
// directory to the boot-time `pwrsnap-*` temp sweep.
//
// Nothing here trusts a path it did not make. The recorder's report is a
// list of paths over a pipe; each one must be a `frame-NNNNNN.png` (or, for
// a pointer sprite, `pointer-N.png`) directly inside the directory made for
// it, or it is dropped.
//
// The pointer is not in the stills' pixels. When the take tracked it, each
// still carries where it was (still-local points) and which sprite it
// showed; the review draws it on top, and a kept snap gets it back as the
// same removable Cursor layer a screenshot has.

import { realpathSync, rm, rmSync } from "node:fs";
import { copyFile, readFile, rm as rmAsync } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { nanoid } from "nanoid";
import {
  annotationBasisPx,
  annotationTextSizePx,
  type BurstFrame,
  type BurstSessionView,
  type CaptureRecord,
  type Overlay,
  type PwrSnapError,
  type Result
} from "@pwrsnap/shared";
import { computeCursorPlacement, type CursorLayerPlacement } from "../capture/cursor-placement";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:burst");

export const BURST_TEMP_PREFIX = "pwrsnap-burst-";
const FRAME_FILE = /^frame-(\d{6})\.png$/;
const SPRITE_FILE = /^pointer-(\d{1,4})\.png$/;

/** Where the pointer's hotspot was, in still-local POINTS, and its sprite. */
export type FramePointer = { x: number; y: number; sprite: number | null };

export type RecorderBurstFrame = {
  index: number;
  path: string;
  utcMs: number;
  width: number;
  height: number;
  pointer?: { x: number; y: number; sprite?: number };
};

type SessionFrame = {
  index: number;
  path: string;
  utcMs: number;
  widthPx: number;
  heightPx: number;
  pointer?: FramePointer;
};

/** A pointer sprite the recorder wrote; sizes and hotspot in POINTS. */
export type PointerSpriteFile = {
  id: number;
  path: string;
  pointWidth: number;
  pointHeight: number;
  hotspotX: number;
  hotspotY: number;
};

type BurstSession = {
  id: string;
  /** The temp directory this session owns and deletes. */
  rootDir: string;
  frames: SessionFrame[];
  kept: Set<number>;
  evictedFrames: number;
  droppedFrames: number;
  sourceApp: { bundleId: string | null; appName: string | null } | null;
  sourceWindowTitle: string | null;
  devicePixelRatio: number;
  sprites: Map<number, PointerSpriteFile>;
  /** A keep is running: a second keep or a discard waits for it. */
  busy: Promise<unknown> | null;
};

const sessions = new Map<string, BurstSession>();
const listeners = new Set<(burstId: string, state: "open" | "closed") => void>();

export function onBurstSessionChange(listener: (burstId: string, state: "open" | "closed") => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(burstId: string, state: "open" | "closed"): void {
  for (const l of listeners) l(burstId, state);
}

/**
 * The recorder's frame list, narrowed to stills that really are inside
 * `framesDir`, deduplicated, in capture order. Pure apart from `realpath`
 * (injected for tests).
 */
export function acceptRecorderFrames(
  framesDir: string,
  reported: readonly unknown[],
  realpath: (p: string) => string = realpathSync
): SessionFrame[] {
  let root: string;
  try {
    root = realpath(framesDir);
  } catch {
    return [];
  }
  const byIndex = new Map<number, SessionFrame>();
  for (const raw of reported) {
    if (raw === null || typeof raw !== "object") continue;
    const f = raw as Partial<RecorderBurstFrame>;
    if (typeof f.path !== "string" || typeof f.index !== "number" || !Number.isInteger(f.index) || f.index < 0) continue;
    if (typeof f.utcMs !== "number" || !Number.isFinite(f.utcMs)) continue;
    if (typeof f.width !== "number" || typeof f.height !== "number" || !(f.width > 0) || !(f.height > 0)) continue;
    const name = basename(f.path);
    const match = FRAME_FILE.exec(name);
    if (match === null || Number(match[1]) !== f.index) continue;
    let resolved: string;
    try {
      resolved = realpath(f.path);
    } catch {
      continue;
    }
    if (dirname(resolved) !== root || basename(resolved) !== name) continue;
    if (byIndex.has(f.index)) continue;
    const pointer = acceptPointer(f.pointer);
    byIndex.set(f.index, {
      index: f.index,
      path: resolved,
      utcMs: f.utcMs,
      widthPx: Math.round(f.width),
      heightPx: Math.round(f.height),
      ...(pointer === null ? {} : { pointer })
    });
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

function acceptPointer(raw: unknown): FramePointer | null {
  if (raw === null || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.x !== "number" || !Number.isFinite(p.x) || typeof p.y !== "number" || !Number.isFinite(p.y)) return null;
  const sprite = typeof p.sprite === "number" && Number.isInteger(p.sprite) && p.sprite >= 0 ? p.sprite : null;
  return { x: p.x, y: p.y, sprite };
}

/**
 * The recorder's pointer sprites, narrowed to `pointer-<id>.png` files
 * directly inside `pointerDir` with sane sizes. Pure apart from `realpath`.
 */
export function acceptPointerSprites(
  pointerDir: string,
  reported: readonly unknown[],
  realpath: (p: string) => string = realpathSync
): Map<number, PointerSpriteFile> {
  const sprites = new Map<number, PointerSpriteFile>();
  let root: string;
  try {
    root = realpath(pointerDir);
  } catch {
    return sprites;
  }
  const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  for (const raw of reported) {
    if (raw === null || typeof raw !== "object") continue;
    const sp = raw as Record<string, unknown>;
    if (typeof sp.id !== "number" || !Number.isInteger(sp.id) || sp.id < 0 || typeof sp.path !== "string") continue;
    if (!positive(sp.pointWidth) || !positive(sp.pointHeight) || !finite(sp.hotspotX) || !finite(sp.hotspotY)) continue;
    const name = basename(sp.path);
    const match = SPRITE_FILE.exec(name);
    if (match === null || Number(match[1]) !== sp.id || sprites.has(sp.id)) continue;
    let resolved: string;
    try {
      resolved = realpath(sp.path);
    } catch {
      continue;
    }
    if (dirname(resolved) !== root || basename(resolved) !== name) continue;
    sprites.set(sp.id, {
      id: sp.id,
      path: resolved,
      pointWidth: sp.pointWidth,
      pointHeight: sp.pointHeight,
      hotspotX: sp.hotspotX,
      hotspotY: sp.hotspotY
    });
  }
  return sprites;
}

/**
 * Where a still's pointer sprite draws, in the still's PIXELS — the
 * screenshot cursor math with the still itself as the captured region.
 * Null when the still has no pointer, its sprite is unknown, or the hotspot
 * was outside the still.
 */
export function framePointerPlacement(
  frame: { widthPx: number; heightPx: number; pointer?: FramePointer },
  sprites: ReadonlyMap<number, PointerSpriteFile>,
  devicePixelRatio: number
): (Omit<CursorLayerPlacement, "pngBytes"> & { sprite: PointerSpriteFile }) | null {
  const pointer = frame.pointer;
  if (pointer === undefined || pointer.sprite === null) return null;
  const sprite = sprites.get(pointer.sprite);
  if (sprite === undefined) return null;
  const scale = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const placement = computeCursorPlacement({
    sample: {
      posX: pointer.x,
      posY: pointer.y,
      hotspotX: sprite.hotspotX,
      hotspotY: sprite.hotspotY,
      pointWidth: sprite.pointWidth,
      pointHeight: sprite.pointHeight
    },
    regionOriginX: 0,
    regionOriginY: 0,
    regionWidth: frame.widthPx / scale,
    regionHeight: frame.heightPx / scale,
    scaleFactor: scale
  });
  return placement === null ? null : { ...placement, sprite };
}

export function openBurstSession(input: {
  rootDir: string;
  framesDir: string;
  frames: readonly unknown[];
  evictedFrames: number;
  droppedFrames: number;
  sourceApp: { bundleId: string | null; appName: string | null } | null;
  sourceWindowTitle: string | null;
  devicePixelRatio: number;
  /** Where the recorder wrote pointer sprites, and its report of them. */
  pointerDir?: string;
  pointerSprites?: readonly unknown[];
}): string {
  if (!basename(input.rootDir).startsWith(BURST_TEMP_PREFIX)) {
    throw new Error("burst root is not a burst temp directory");
  }
  const id = nanoid(12);
  sessions.set(id, {
    id,
    rootDir: input.rootDir,
    frames: acceptRecorderFrames(input.framesDir, input.frames),
    kept: new Set(),
    evictedFrames: Math.max(0, input.evictedFrames | 0),
    droppedFrames: Math.max(0, input.droppedFrames | 0),
    sourceApp: input.sourceApp,
    sourceWindowTitle: input.sourceWindowTitle,
    devicePixelRatio: input.devicePixelRatio > 0 ? input.devicePixelRatio : 1,
    sprites: input.pointerDir === undefined ? new Map() : acceptPointerSprites(input.pointerDir, input.pointerSprites ?? []),
    busy: null
  });
  log.info("burst session opened", { burstId: id, frames: sessions.get(id)!.frames.length });
  notify(id, "open");
  return id;
}

/** `pointer` addresses a pointer sprite: `index` is then the sprite id. */
export type BurstFrameVariant = "full" | "thumb" | "pointer";

export function burstFrameUrl(burstId: string, index: number, variant: BurstFrameVariant = "full"): string {
  if (variant === "pointer") return `pwrsnap-screen://b/${burstId}/pointer/${index}`;
  return `pwrsnap-screen://b/${burstId}/${index}${variant === "thumb" ? "/thumb" : ""}`;
}

/** Parse `pwrsnap-screen://b/<burstId>/<index>[/thumb]` or
 *  `pwrsnap-screen://b/<burstId>/pointer/<spriteId>`. Pure. */
export function parseBurstFrameUrl(
  url: string
): { burstId: string; index: number; variant: BurstFrameVariant } | null {
  const prefix = "pwrsnap-screen://b/";
  if (!url.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length).split(/[?#]/, 1)[0]!.replace(/\/+$/, "");
  const sprite = /^([A-Za-z0-9_-]{6,32})\/pointer\/(\d{1,4})$/.exec(rest);
  if (sprite !== null) return { burstId: sprite[1]!, index: Number(sprite[2]), variant: "pointer" };
  const match = /^([A-Za-z0-9_-]{6,32})\/(\d{1,7})(\/thumb)?$/.exec(rest);
  if (match === null) return null;
  return { burstId: match[1]!, index: Number(match[2]), variant: match[3] === undefined ? "full" : "thumb" };
}

/** The file a pointer sprite URL resolves to, or null. */
export function burstPointerSpritePath(burstId: string, spriteId: number): string | null {
  return sessions.get(burstId)?.sprites.get(spriteId)?.path ?? null;
}

/** The file a frame URL resolves to, or null once the session is gone. */
export function burstFramePath(burstId: string, index: number): string | null {
  return sessions.get(burstId)?.frames.find((f) => f.index === index)?.path ?? null;
}

/**
 * Where a frame's filmstrip thumbnail lives: inside the session's own
 * directory, so it goes when the session does. Null once the session is
 * gone or the frame is not in it.
 */
export function burstThumbPaths(
  burstId: string,
  index: number
): { framePath: string; thumbsDir: string; thumbPath: string } | null {
  const s = sessions.get(burstId);
  const frame = s?.frames.find((f) => f.index === index);
  if (s === undefined || frame === undefined) return null;
  const thumbsDir = join(s.rootDir, "thumbs");
  return { framePath: frame.path, thumbsDir, thumbPath: join(thumbsDir, `${index}.jpg`) };
}

export function getBurstSessionView(burstId: string): BurstSessionView | null {
  const s = sessions.get(burstId);
  if (s === undefined) return null;
  const firstMs = s.frames[0]?.utcMs ?? 0;
  const frames: BurstFrame[] = s.frames.map((f) => {
    const placed = framePointerPlacement(f, s.sprites, s.devicePixelRatio);
    return {
      index: f.index,
      capturedAt: new Date(Math.round(f.utcMs)).toISOString(),
      offsetMs: Math.round(f.utcMs - firstMs),
      widthPx: f.widthPx,
      heightPx: f.heightPx,
      url: burstFrameUrl(s.id, f.index),
      thumbUrl: burstFrameUrl(s.id, f.index, "thumb"),
      ...(placed === null
        ? {}
        : {
            pointer: {
              url: burstFrameUrl(s.id, placed.sprite.id, "pointer"),
              left: placed.xPx / f.widthPx,
              top: placed.yPx / f.heightPx,
              width: placed.drawWidthPx / f.widthPx,
              height: placed.drawHeightPx / f.heightPx
            }
          })
    };
  });
  return {
    burstId: s.id,
    frames,
    evictedFrames: s.evictedFrames,
    droppedFrames: s.droppedFrames,
    keptIndexes: [...s.kept].sort((a, b) => a - b),
    sourceAppName: s.sourceApp?.appName ?? null,
    devicePixelRatio: s.devicePixelRatio
  };
}

export function hasOpenBursts(): boolean {
  return sessions.size > 0;
}

export function openBurstIds(): string[] {
  return [...sessions.keys()];
}

// ── the capture-time label ─────────────────────────────────────────────

/** `14:03:22.417` in the user's local time. */
export function formatClockMs(utcMs: number, timeZone?: string): string {
  const d = new Date(Math.round(utcMs));
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    ...(timeZone === undefined ? {} : { timeZone })
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("hour")}:${get("minute")}:${get("second")}.${String(d.getUTCMilliseconds()).padStart(3, "0")}`;
}

/** `+1.300 s` — offset from the first kept frame. */
export function formatOffset(ms: number): string {
  return `+${(Math.max(0, Math.round(ms)) / 1000).toFixed(3)} s`;
}

/**
 * The removable text label a kept still starts with: its capture time and
 * its offset from the first kept still, top-left, white on a black outline
 * so it reads over any screen. Sized from the still's own dimensions
 * through the one annotation ladder, like any label the user draws.
 */
export function captureTimeLabel(
  frame: { utcMs: number; widthPx: number; heightPx: number },
  firstKeptUtcMs: number,
  timeZone?: string
): { name: string; shape: Overlay } {
  const sizePx = annotationTextSizePx("small", annotationBasisPx(frame.widthPx, frame.heightPx));
  const margin = Math.max(8, Math.round(sizePx * 0.6));
  return {
    name: "Capture time",
    shape: {
      kind: "text",
      // Text anchors at its left edge, first line centred on the point.
      // The size comes from the still's LONGER side, so on a thin strip
      // (a toolbar burst) margin + half a line can be taller than the
      // still: clamp the anchor to the still's middle so the label stays
      // on it instead of landing below it.
      point: {
        x: Math.min(margin, frame.widthPx / 2) / frame.widthPx,
        y: Math.min(margin + sizePx / 2, frame.heightPx / 2) / frame.heightPx
      },
      body: `${formatClockMs(frame.utcMs, timeZone)} (${formatOffset(frame.utcMs - firstKeptUtcMs)})`,
      size: "small",
      weight: "bold",
      color: "#ffffff",
      outline: "black"
    }
  };
}

// ── keep / discard ─────────────────────────────────────────────────────

export type PersistStill = (
  tempPath: string,
  sourceApp: { bundleId: string | null; appName: string | null } | null,
  options: {
    devicePixelRatio: number;
    sourceWindowTitle: string | null;
    capturedAt: string;
    annotations?: Array<{ name: string; shape: Overlay }>;
    cursorLayer?: CursorLayerPlacement;
    tags: string[];
  }
) => Promise<Result<CaptureRecord, PwrSnapError>>;

/**
 * Keep the chosen frames as snaps (in capture order) and, once every one
 * has landed, end the session. Frames already kept by an earlier attempt
 * are skipped, so a retry after a partial failure never duplicates a snap.
 * With `withPointer`, a still whose pointer was tracked gets it as a
 * removable Cursor layer.
 */
export async function keepBurstFrames(
  burstId: string,
  frameIndexes: readonly number[],
  stampTime: boolean,
  persist: PersistStill,
  withPointer = true
): Promise<Result<{ captureIds: string[] }, PwrSnapError>> {
  const s = sessions.get(burstId);
  if (s === undefined) return { ok: false, error: { kind: "validation", code: "burst_not_found", message: "This burst has already been closed." } };
  while (s.busy !== null) await s.busy.catch(() => undefined);
  if (sessions.get(burstId) !== s) {
    return { ok: false, error: { kind: "validation", code: "burst_not_found", message: "This burst has already been closed." } };
  }
  const wanted = new Set(frameIndexes.filter((i) => Number.isInteger(i)));
  const chosen = s.frames.filter((f) => wanted.has(f.index));
  if (chosen.length === 0) {
    return { ok: false, error: { kind: "validation", code: "nothing_selected", message: "Choose at least one frame to keep." } };
  }
  const work = (async (): Promise<Result<{ captureIds: string[] }, PwrSnapError>> => {
    const firstKept = chosen[0]!.utcMs;
    // One read per distinct sprite. The pointer is an optional layer: a
    // sprite that cannot be read costs that layer, never the still.
    const spriteBytes = new Map<number, Promise<Buffer | null>>();
    const readSprite = (sprite: PointerSpriteFile): Promise<Buffer | null> => {
      let pending = spriteBytes.get(sprite.id);
      if (pending === undefined) {
        pending = readFile(sprite.path).catch((cause: unknown) => {
          log.warn("burst pointer sprite unreadable; keeping without it", {
            burstId,
            code: (cause as { code?: unknown }).code ?? "unknown"
          });
          return null;
        });
        spriteBytes.set(sprite.id, pending);
      }
      return pending;
    };
    const captureIds: string[] = [];
    for (const frame of chosen) {
      if (s.kept.has(frame.index)) continue;
      // Persisting CONSUMES its input (the capture store moves the temp
      // file into the bundle). Hand it a copy: the still itself stays in
      // the session so the review can keep showing it, and a retry after
      // a failure part way still has every still to work from.
      const staged = join(s.rootDir, `keep-${frame.index}-${nanoid(6)}.png`);
      let result: Awaited<ReturnType<PersistStill>>;
      try {
        await copyFile(frame.path, staged);
        const placed = withPointer ? framePointerPlacement(frame, s.sprites, s.devicePixelRatio) : null;
        const pngBytes = placed === null ? null : await readSprite(placed.sprite);
        const cursorLayer: CursorLayerPlacement | undefined = placed === null || pngBytes === null
          ? undefined
          : {
              pngBytes,
              xPx: placed.xPx,
              yPx: placed.yPx,
              drawWidthPx: placed.drawWidthPx,
              drawHeightPx: placed.drawHeightPx
            };
        result = await persist(staged, s.sourceApp, {
          devicePixelRatio: s.devicePixelRatio,
          sourceWindowTitle: s.sourceWindowTitle,
          capturedAt: new Date(Math.round(frame.utcMs)).toISOString(),
          ...(stampTime ? { annotations: [captureTimeLabel(frame, firstKept)] } : {}),
          ...(cursorLayer === undefined ? {} : { cursorLayer }),
          tags: ["burst"]
        });
      } catch (cause) {
        result = {
          ok: false,
          error: {
            kind: "persistence",
            code: "burst_keep_failed",
            message: cause instanceof Error ? cause.message : String(cause)
          }
        };
      } finally {
        await rmAsync(staged, { force: true }).catch(() => undefined);
      }
      if (!result.ok) {
        log.warn("burst keep stopped part way", { burstId, kept: captureIds.length, code: result.error.code });
        return result;
      }
      s.kept.add(frame.index);
      captureIds.push(result.value.id);
    }
    await closeSession(s);
    log.info("burst kept", { burstId, kept: captureIds.length, of: s.frames.length });
    return { ok: true, value: { captureIds } };
  })();
  s.busy = work;
  try {
    return await work;
  } finally {
    if (s.busy === work) s.busy = null;
  }
}

export async function discardBurst(burstId: string): Promise<void> {
  const s = sessions.get(burstId);
  if (s === undefined) return;
  while (s.busy !== null) await s.busy.catch(() => undefined);
  if (sessions.get(burstId) !== s) return;
  await closeSession(s);
  log.info("burst discarded", { burstId, frames: s.frames.length, kept: s.kept.size });
}

async function closeSession(s: BurstSession): Promise<void> {
  if (sessions.get(s.id) !== s) return;
  sessions.delete(s.id);
  await new Promise<void>((resolve) =>
    rm(s.rootDir, { recursive: true, force: true }, (cause) => {
      if (cause) log.warn("burst temp cleanup failed", { burstId: s.id, message: cause.message });
      resolve();
    })
  );
  notify(s.id, "closed");
}

/** Quit-time close of one review window: delete its stills now. */
export function discardBurstSync(burstId: string): void {
  const s = sessions.get(burstId);
  if (s === undefined) return;
  sessions.delete(burstId);
  try {
    rmSync(s.rootDir, { recursive: true, force: true });
  } catch {
    // The boot temp sweep is the backstop.
  }
  notify(burstId, "closed");
}

/** App quit: delete every open burst's stills now (temp dirs only). */
export function discardAllBurstsSync(): void {
  for (const s of sessions.values()) {
    try {
      rmSync(s.rootDir, { recursive: true, force: true });
    } catch {
      // The boot temp sweep is the backstop.
    }
  }
  sessions.clear();
}

export function __resetBurstSessionsForTests(): void {
  sessions.clear();
  listeners.clear();
}
