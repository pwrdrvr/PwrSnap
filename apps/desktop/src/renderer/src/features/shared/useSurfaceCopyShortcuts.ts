import { useEffect, useRef } from "react";
import type { ShortcutPlatform, VideoPreset } from "@pwrsnap/shared";
import { isEditableTarget, isPrimaryAccel } from "./keyboard";

export type SurfaceCopyAssetKind = "image" | "video";

export type SurfaceCopyShortcut =
  | { kind: "image"; preset: VideoPreset }
  | { kind: "video"; format: "gif" | "mp4"; preset: VideoPreset };

const PRESETS: readonly VideoPreset[] = ["low", "med", "high"];

/** Resolve only the shortcut that the currently active asset advertises. */
export function resolveSurfaceCopyShortcut(
  event: KeyboardEvent,
  platform: ShortcutPlatform,
  assetKind: SurfaceCopyAssetKind
): SurfaceCopyShortcut | null {
  if (event.repeat || event.isComposing || event.shiftKey || event.altKey) return null;
  if (!isPrimaryAccel(event, platform)) return null;
  const index = Number(event.key) - 1;
  if (!Number.isInteger(index) || index < 0) return null;
  if (assetKind === "image") {
    const preset = PRESETS[index];
    return preset === undefined ? null : { kind: "image", preset };
  }
  if (index > 5) return null;
  const preset = PRESETS[index % 3];
  if (preset === undefined) return null;
  return {
    kind: "video",
    format: index < 3 ? "gif" : "mp4",
    preset
  };
}

/**
 * One window listener per surface, independent of how many copy grids that
 * surface renders. Nested grids stay presentational; the active asset decides
 * which digit range is live.
 */
export function useSurfaceCopyShortcuts(options: {
  assetKind: SurfaceCopyAssetKind | null;
  enabled: boolean;
  platform: ShortcutPlatform;
  onShortcut: (shortcut: SurfaceCopyShortcut) => void;
}): void {
  const onShortcutRef = useRef(options.onShortcut);
  onShortcutRef.current = options.onShortcut;

  useEffect(() => {
    if (!options.enabled || options.assetKind === null) return undefined;
    const assetKind = options.assetKind;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (isEditableTarget(event)) return;
      const shortcut = resolveSurfaceCopyShortcut(event, options.platform, assetKind);
      if (shortcut === null) return;
      event.preventDefault();
      onShortcutRef.current(shortcut);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [options.assetKind, options.enabled, options.platform]);
}
