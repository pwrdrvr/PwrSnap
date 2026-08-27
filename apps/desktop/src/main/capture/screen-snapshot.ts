// Registry for the explicit Linux selector fallback. Windows and macOS use
// renderer-owned display media and never register a full-screen bitmap here.
// Linux currently retains the historical temp-PNG route because PipeWire's
// portal does not expose a source that can be deterministically pinned to an
// Electron Display id.

import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { nanoid } from "nanoid";
import { getMainLogger } from "../log";
import { captureScreen } from "./screencapture";

const log = getMainLogger("pwrsnap:screen-snapshot");

type Entry = {
  filePath: string;
  displayId: number;
};

const registry = new Map<string, Entry>();

export type ScreenSnapshot = {
  id: string;
  filePath: string;
  displayId: number;
};

export async function captureAndRegister(
  displayId: number,
  _options?: { mode?: "auto" | "region" | "window" }
): Promise<ScreenSnapshot> {
  const result = await captureScreen(displayId);
  if (!result.ok) {
    throw new Error(`screen snapshot failed: ${result.reason}: ${result.message}`);
  }
  const id = nanoid();
  const entry: Entry = { filePath: result.tempPath, displayId };
  registry.set(id, entry);
  log.info("fallback snapshot registered", {
    id,
    filePath: result.tempPath,
    displayId,
    strategy: "legacy-file"
  });
  return { id, filePath: result.tempPath, displayId };
}

export function getSnapshotPath(id: string): string | null {
  return registry.get(id)?.filePath ?? null;
}

export function getSnapshot(id: string): ScreenSnapshot | null {
  const entry = registry.get(id);
  if (entry === undefined) return null;
  return { id, filePath: entry.filePath, displayId: entry.displayId };
}

export async function releaseSnapshot(id: string): Promise<void> {
  const entry = registry.get(id);
  if (entry === undefined) return;
  registry.delete(id);
  try {
    await rm(dirname(entry.filePath), { recursive: true, force: true });
  } catch (err) {
    log.warn("fallback snapshot cleanup failed", {
      id,
      filePath: entry.filePath,
      message: err instanceof Error ? err.message : String(err)
    });
  }
}
