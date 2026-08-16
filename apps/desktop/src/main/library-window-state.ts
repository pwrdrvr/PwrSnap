import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";
import type { Rectangle } from "electron";

export const LIBRARY_WINDOW_DEFAULT_WIDTH = 1440;
export const LIBRARY_WINDOW_DEFAULT_HEIGHT = 960;
export const LIBRARY_WINDOW_MIN_WIDTH = 480;
export const LIBRARY_WINDOW_MIN_HEIGHT = 480;

type StoredLibraryWindowState = {
  schemaVersion: 1;
  normalBounds: Rectangle;
};

function finiteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value)
    : null;
}

function parseRectangle(value: unknown): Rectangle | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const x = finiteInteger(record.x);
  const y = finiteInteger(record.y);
  const width = finiteInteger(record.width);
  const height = finiteInteger(record.height);
  if (x === null || y === null || width === null || height === null) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Keep a requested Library frame wholly inside one display's usable work area.
 * This handles both first launch (the 1440x960 default on a smaller display)
 * and restore after a monitor, resolution, scale, or taskbar layout change.
 */
export function fitLibraryWindowBoundsToWorkArea(
  requested: Rectangle,
  workArea: Rectangle
): Rectangle {
  const workWidth = Math.max(1, Math.round(workArea.width));
  const workHeight = Math.max(1, Math.round(workArea.height));
  const width = Math.min(
    Math.max(LIBRARY_WINDOW_MIN_WIDTH, Math.round(requested.width)),
    workWidth
  );
  const height = Math.min(
    Math.max(LIBRARY_WINDOW_MIN_HEIGHT, Math.round(requested.height)),
    workHeight
  );
  const minX = Math.round(workArea.x);
  const minY = Math.round(workArea.y);
  const maxX = minX + workWidth - width;
  const maxY = minY + workHeight - height;
  return {
    x: clamp(Math.round(requested.x), minX, maxX),
    y: clamp(Math.round(requested.y), minY, maxY),
    width,
    height
  };
}

/** The centered, work-area-bounded frame used when no prior state exists. */
export function defaultLibraryWindowBounds(workArea: Rectangle): Rectangle {
  const width = Math.min(LIBRARY_WINDOW_DEFAULT_WIDTH, Math.max(1, workArea.width));
  const height = Math.min(LIBRARY_WINDOW_DEFAULT_HEIGHT, Math.max(1, workArea.height));
  return fitLibraryWindowBoundsToWorkArea(
    {
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      width,
      height
    },
    workArea
  );
}

/**
 * Read the last normal (non-minimized/non-fullscreen) Library frame. Invalid
 * state is quarantined and treated as a first launch; it must never block app
 * startup.
 */
export function readLibraryWindowBounds(filePath: string): Rectangle | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) throw new Error("invalid state");
    const record = parsed as Record<string, unknown>;
    if (record.schemaVersion !== 1) throw new Error("unsupported schema");
    const bounds = parseRectangle(record.normalBounds);
    if (bounds === null) throw new Error("invalid bounds");
    return bounds;
  } catch {
    const suffix = new Date().toISOString().replace(/[:.]/g, "-");
    try {
      renameSync(filePath, `${filePath}.corrupt-${suffix}.json`);
    } catch {
      // Best effort only. A corrupt convenience-state file is not fatal.
    }
    return null;
  }
}

/** Persist one small state blob via write-then-rename so crashes cannot tear it. */
export function writeLibraryWindowBounds(filePath: string, bounds: Rectangle): void {
  const normalBounds = parseRectangle(bounds);
  if (normalBounds === null) return;
  const blob: StoredLibraryWindowState = { schemaVersion: 1, normalBounds };
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(blob, null, 2)}\n`, "utf8");
    renameSync(tempPath, filePath);
  } catch (cause) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Preserve the original write error.
    }
    throw cause;
  }
}
