// The one module in main that talks to Electron's `clipboard`.
//
// Electron 44 rebuilt `clipboard` on the W3C Clipboard API (electron/rfcs
// 0019). Every read and write returns a Promise; the per-flavor helpers
// (`readImage`, `writeImage`, `readBuffer`, `writeBuffer`,
// `availableFormats`, `readBookmark`, …) are gone; and a platform flavor
// with no standard MIME mapping is addressed as
// `electron application/osclipboard;format="<name>"`.
//
// This module keeps the vocabulary the rest of main was written in — a flat
// list of format names, and "give me that format's bytes" — on top of the
// new API, so the flavor-matching logic in clipboard-image-buffer.ts and
// windows-file-clipboard-reader.ts did not have to change shape. Standard
// MIME types keep their MIME name; every other flavor is listed by its raw
// platform name, unwrapped from the `osclipboard` custom format.
//
// Measured on Electron 44.4.5 / macOS 26, the things that bite:
//
//   • `ClipboardItem.getType()` REJECTS any type its item does not list in
//     `types`, and `has()` answers no for the same names. A flavor can only
//     be read under the name the platform lists it by.
//   • macOS lists `public.file-url` as `text/uri-list`, `public.png` as
//     `image/png` + "Apple PNG pasteboard type", and `public.tiff` as
//     "NeXT TIFF v4.0 pasteboard type". Asking for the literal UTI of any of
//     those rejects, which is why callers look for `text/uri-list`.
//   • `getType("image/png")` hands back the pasteboard's own PNG bytes
//     verbatim when there is one, and a PNG Chromium converted otherwise.
//   • A private UTI written through `osclipboard` is listed under its
//     literal name, even from an unpackaged build whose Info.plist does not
//     declare it.
//   • Writing `image/png` re-encodes the PNG, and macOS then offers a TIFF
//     representation of it too.
//   • One `write()` of one `ClipboardItem` lands every flavor in it together.
//     Before 44 each write call cleared the pasteboard first, which is why
//     native-clipboard.ts exists.

import { clipboard, ClipboardItem, nativeImage, type NativeImage } from "electron";

const RAW_TYPE_PREFIX = 'electron application/osclipboard;format="';
const RAW_TYPE_SUFFIX = '"';
const BOOKMARK_TYPE = "electron application/bookmark";

/** The clipboard type that carries a raw platform flavor (a UTI, a Windows
 *  registered format name, an X11 target). */
export function rawClipboardType(format: string): string {
  return `${RAW_TYPE_PREFIX}${format}${RAW_TYPE_SUFFIX}`;
}

/** A clipboard type's format name: the platform name inside an `osclipboard`
 *  type, or the type itself for a MIME type or another custom format. */
export function clipboardFormatName(type: string): string {
  return type.startsWith(RAW_TYPE_PREFIX) && type.endsWith(RAW_TYPE_SUFFIX)
    ? type.slice(RAW_TYPE_PREFIX.length, -RAW_TYPE_SUFFIX.length)
    : type;
}

export type ClipboardBookmark = { title: string; url: string };

/** One read of the system clipboard. Every lookup answers from the same
 *  `clipboard.read()`, so a caller that checks a flavor and then reads it
 *  cannot see two different clipboards. */
export type ClipboardSnapshot = {
  /** Every flavor on the clipboard, by format name (see the header). */
  readonly formats: readonly string[];
  has(format: string): boolean;
  /** That flavor's bytes, or an empty Buffer when it is absent. */
  readBuffer(format: string): Promise<Buffer>;
  /** The clipboard image decoded from its `image/*` flavor, or an empty
   *  image when there is none or it does not decode. */
  readImage(): Promise<NativeImage>;
  /** Present only when a bookmark was written as one. */
  readBookmark(): Promise<ClipboardBookmark | null>;
  /** The `text/plain` flavor, or "" when there is none. */
  readText(): Promise<string>;
};

type ListedType = { item: Electron.ClipboardItem; type: string };

export async function readClipboard(): Promise<ClipboardSnapshot> {
  const items = await clipboard.read();
  const formats: string[] = [];
  // Keyed by lower-cased name: Windows registered-format names compare
  // case-insensitively, and the first item to list a name wins.
  const listed = new Map<string, ListedType>();
  for (const item of items) {
    for (const type of item.types) {
      const format = clipboardFormatName(type);
      const key = format.toLowerCase();
      if (listed.has(key)) continue;
      listed.set(key, { item, type });
      formats.push(format);
    }
  }

  const readBlob = async (format: string): Promise<Blob | null> => {
    const entry = listed.get(format.toLowerCase());
    if (entry === undefined) return null;
    const value = await entry.item.getType(entry.type);
    return value instanceof Blob ? value : null;
  };
  const readBuffer = async (format: string): Promise<Buffer> => {
    const blob = await readBlob(format);
    return blob === null ? Buffer.alloc(0) : Buffer.from(await blob.arrayBuffer());
  };

  return {
    formats,
    has: (format) => listed.has(format.toLowerCase()),
    readBuffer,
    readImage: async () => {
      const imageFormat = formats.find((format) => format.toLowerCase().startsWith("image/"));
      if (imageFormat === undefined) return nativeImage.createEmpty();
      return nativeImage.createFromBuffer(await readBuffer(imageFormat));
    },
    readBookmark: async () => {
      const entry = listed.get(BOOKMARK_TYPE);
      if (entry === undefined) return null;
      const value = await entry.item.getType(BOOKMARK_TYPE);
      return value instanceof Blob ? null : { title: value.title, url: value.url };
    },
    readText: async () => (await readBuffer("text/plain")).toString("utf8")
  };
}

export type ClipboardWrite = {
  /** PNG bytes for the `image/png` flavor. */
  png?: Buffer;
  /** Raw platform flavors, by platform name. */
  raw?: Readonly<Record<string, Buffer>>;
};

/** Replace the clipboard with one item carrying every flavor given. */
export async function writeClipboard(write: ClipboardWrite): Promise<void> {
  const payload: Record<string, Blob> = {};
  if (write.png !== undefined) {
    payload["image/png"] = new Blob([new Uint8Array(write.png)], { type: "image/png" });
  }
  for (const [format, bytes] of Object.entries(write.raw ?? {})) {
    payload[rawClipboardType(format)] = new Blob([new Uint8Array(bytes)]);
  }
  await clipboard.write([new ClipboardItem(payload)]);
}

/** The pre-44 `clipboard.write({ image })`: the image as PNG, nothing else. */
export async function writeClipboardImage(image: NativeImage): Promise<void> {
  await writeClipboard({ png: image.toPNG() });
}

export async function writeClipboardText(text: string): Promise<void> {
  await clipboard.writeText(text);
}

export function clearClipboard(): void {
  clipboard.clear();
}
