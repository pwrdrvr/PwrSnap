// Whether File → New → Paste from Clipboard is enabled.
//
// The answer is a HINT, decided from the clipboard's type names alone
// (clipboard/pasteboard-types.ts). It never reads a flavor's bytes, never
// decodes an image, and never opens a file a URL names: it runs when the
// File menu opens, when the app becomes active and after PwrSnap's own
// copies, none of which is the user asking to paste. `capture:pasteFromClipboard`
// does the real work and reports "no image" when the hint was generous, so a
// listed file URL to a non-image file, or a web URL, may leave the item
// enabled.

import { clipboardImageBufferFormats } from "../clipboard-image-buffer";
import { listClipboardTypesWithoutReading } from "./pasteboard-types";
import { windowsClipboardFormatsMayContainFiles } from "./windows-file-clipboard-reader";

// Type names under which a file or URL can be listed. `public.url` and its
// legacy name are what a bookmark (and a copied web link) lists; the paste
// command follows those too. Compared lower-cased.
const FILE_URL_TYPES = new Set([
  "public.file-url",
  "public.url",
  "apple url pasteboard type", // NSURLPboardType
  "nsfilenamespboardtype",
  "text/uri-list"
]);

/** Whether a clipboard listing these types may hold something the paste
 *  command turns into an image. */
export function clipboardTypesMayHoldPasteableImage(
  types: readonly string[],
  platform: NodeJS.Platform = process.platform
): boolean {
  if (types.some((type) => type.toLowerCase().startsWith("image/"))) return true;
  if (clipboardImageBufferFormats(types).length > 0) return true;
  if (types.some((type) => FILE_URL_TYPES.has(type.toLowerCase()))) return true;
  return windowsClipboardFormatsMayContainFiles(types, platform);
}

/** Enabled unless the clipboard's types positively rule an image out.
 *  Where no types-only listing exists, that is always. */
export async function pasteFromClipboardMenuEnabled(
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  const types = await listClipboardTypesWithoutReading(platform);
  return types === null || clipboardTypesMayHoldPasteableImage(types, platform);
}
