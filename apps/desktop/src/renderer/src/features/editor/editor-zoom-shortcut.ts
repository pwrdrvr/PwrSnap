import type { ShortcutPlatform } from "@pwrsnap/shared";
import { isPrimaryAccel } from "../shared/keyboard";

export type EditorZoomShortcut = "fit" | "in" | "out";

/** Resolve only the zoom chords owned by the canvas surface. Primary+1 is
 * intentionally absent: EditorChrome owns numbered panel shortcuts. */
export function editorZoomShortcut(
  event: KeyboardEvent,
  platform: ShortcutPlatform
): EditorZoomShortcut | null {
  if (!isPrimaryAccel(event, platform) || event.altKey) return null;
  if (event.key === "0") return "fit";
  if (event.key === "=" || event.key === "+") return "in";
  if (event.key === "-" || event.key === "_") return "out";
  return null;
}
