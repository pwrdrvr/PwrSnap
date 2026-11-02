// File → New → Paste from Clipboard decides from the clipboard's TYPES and
// never reads a flavor's bytes. It runs on menu open, app activation and
// after our own copies, and on macOS reading the bytes of a Universal
// Clipboard or remote-desktop item pulls it across the network.
//
// Every clipboard surface here is a trap: Electron's `clipboard` and
// `ClipboardItem`, and the `readClipboard()` snapshot. Electron 44's
// `clipboard.read()` is trapped too, not just the byte readers: measured on
// macOS 26, it fetches `public.url` and `public.url-name` to list types.
//
// The type lists below are what AppKit listed for each kind of item when the
// types-only listing was measured (clipboard/pasteboard-types.ts).

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  clipboardCalls: [] as string[]
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: mocks.execFile
}));

vi.mock("electron", () => {
  // Any property is a method that records itself and throws.
  const trap = (owner: string): unknown =>
    new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "then") return undefined;
          return (): never => {
            mocks.clipboardCalls.push(`${owner}.${String(prop)}`);
            throw new Error(`${owner}.${String(prop)} must not be called`);
          };
        }
      }
    );
  class ClipboardItem {
    readonly types: readonly string[] = ["image/png", "text/uri-list"];
    getType(): never {
      mocks.clipboardCalls.push("ClipboardItem.getType");
      throw new Error("ClipboardItem.getType must not be called");
    }
  }
  return {
    clipboard: trap("clipboard"),
    nativeImage: trap("nativeImage"),
    ClipboardItem,
    app: {
      getAppPath: () => {
        throw new Error("app.getAppPath unavailable in tests");
      }
    }
  };
});

vi.mock("../system-clipboard", () => {
  const record = (method: string) => async (): Promise<never> => {
    mocks.clipboardCalls.push(`snapshot.${method}`);
    throw new Error(`snapshot.${method} must not be called`);
  };
  return {
    readClipboard: async () => {
      mocks.clipboardCalls.push("readClipboard");
      return {
        formats: ["image/png", "text/uri-list"],
        has: () => true,
        readBuffer: record("readBuffer"),
        readImage: record("readImage"),
        readBookmark: record("readBookmark"),
        readText: record("readText")
      };
    }
  };
});

const { clipboardTypesMayHoldPasteableImage, pasteFromClipboardMenuEnabled } = await import(
  "../paste-menu-hint"
);
const { listClipboardTypesWithoutReading } = await import("../pasteboard-types");
const { __setNamedImagePasteboardHelperForTests } = await import("../named-image-pasteboard");

const FAKE_HELPER = "/fake/build/native/pasteboard-writer";

// What AppKit listed, measured on macOS 26.
const MAC_TYPES = {
  image: ["public.png", "Apple PNG pasteboard type", "public.tiff", "NeXT TIFF v4.0 pasteboard type"],
  webLink: [
    "public.url",
    "CorePasteboardFlavorType 0x75726C20",
    "dyn.ah62d4rv4gu8yc6durvwwaznwmuuha2pxsvw0e55bsmwca7d3sbwu",
    "Apple URL pasteboard type",
    "public.url-name",
    "CorePasteboardFlavorType 0x75726C6E",
    "public.utf8-plain-text",
    "NSStringPboardType"
  ],
  finderFile: [
    "public.file-url",
    "CorePasteboardFlavorType 0x6675726C",
    "dyn.ah62d4rv4gu8y6y4grf0gn5xbrzw1gydcr7u1e3cytf2gn",
    "NSFilenamesPboardType",
    "dyn.ah62d4rv4gu8yc6durvwwaznwmuuha2pxsvw0e55bsmwca7d3sbwu",
    "Apple URL pasteboard type",
    "public.utf8-plain-text",
    "NSStringPboardType",
    "public.tiff",
    "NeXT TIFF v4.0 pasteboard type"
  ],
  // PwrSnap's own copy: the PNG beside a file URL.
  imageBesideFileUrl: [
    "public.file-url",
    "CorePasteboardFlavorType 0x6675726C",
    "dyn.ah62d4rv4gu8y6y4grf0gn5xbrzw1gydcr7u1e3cytf2gn",
    "NSFilenamesPboardType",
    "dyn.ah62d4rv4gu8yc6durvwwaznwmuuha2pxsvw0e55bsmwca7d3sbwu",
    "Apple URL pasteboard type",
    "public.png",
    "Apple PNG pasteboard type",
    "public.tiff",
    "NeXT TIFF v4.0 pasteboard type"
  ],
  text: ["public.utf8-plain-text", "NSStringPboardType"],
  chromiumHtml: [
    "org.chromium.web-custom-data",
    "public.html",
    "Apple HTML pasteboard type",
    "public.utf8-plain-text",
    "NSStringPboardType"
  ],
  webCustomFormat: [
    "org.w3.web-custom-format.map",
    "org.w3.web-custom-format.type-0",
    "public.utf8-plain-text",
    "NSStringPboardType"
  ],
  empty: []
} satisfies Record<string, string[]>;

/** The helper's `--list-types` answering with these types. */
function helperLists(types: readonly string[]): void {
  mocks.execFile.mockImplementation(
    (
      _file: string,
      _args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      callback(null, JSON.stringify(types), "");
    }
  );
}

beforeEach(() => {
  mocks.execFile.mockReset();
  mocks.clipboardCalls.length = 0;
  __setNamedImagePasteboardHelperForTests(FAKE_HELPER);
});

afterEach(() => {
  __setNamedImagePasteboardHelperForTests(null);
});

describe("clipboardTypesMayHoldPasteableImage", () => {
  test.each([
    ["an image", MAC_TYPES.image, true],
    ["a web link (public.url, as a bookmark lists)", MAC_TYPES.webLink, true],
    ["a Finder file", MAC_TYPES.finderFile, true],
    ["an image beside a file URL", MAC_TYPES.imageBesideFileUrl, true],
    ["plain text", MAC_TYPES.text, false],
    ["Chromium HTML", MAC_TYPES.chromiumHtml, false],
    ["a W3C custom format", MAC_TYPES.webCustomFormat, false],
    ["nothing", MAC_TYPES.empty, false]
  ])("macOS listing %s → %s", (_label, types, expected) => {
    expect(clipboardTypesMayHoldPasteableImage(types, "darwin")).toBe(expected);
  });

  test("MIME names and raw image flavors count on every platform", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      expect(clipboardTypesMayHoldPasteableImage(["image/png"], platform)).toBe(true);
      expect(clipboardTypesMayHoldPasteableImage(["image/bmp"], platform)).toBe(true);
      expect(clipboardTypesMayHoldPasteableImage(["text/uri-list"], platform)).toBe(true);
      expect(clipboardTypesMayHoldPasteableImage(["PNG"], platform)).toBe(true);
      expect(clipboardTypesMayHoldPasteableImage(["text/plain"], platform)).toBe(false);
    }
  });

  test("Explorer's file-drop formats count only on Windows", () => {
    expect(clipboardTypesMayHoldPasteableImage(["CF_HDROP"], "win32")).toBe(true);
    expect(clipboardTypesMayHoldPasteableImage(["FileNameW"], "win32")).toBe(true);
    expect(clipboardTypesMayHoldPasteableImage(["CF_HDROP"], "darwin")).toBe(false);
  });
});

describe("listClipboardTypesWithoutReading", () => {
  test("asks the macOS helper for --list-types and nothing else", async () => {
    helperLists(MAC_TYPES.image);

    expect(await listClipboardTypesWithoutReading("darwin")).toEqual(MAC_TYPES.image);
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    expect(mocks.execFile.mock.calls[0]?.[0]).toBe(FAKE_HELPER);
    expect(mocks.execFile.mock.calls[0]?.[1]).toEqual(["--list-types"]);
    expect(mocks.execFile.mock.calls[0]?.[2]).toMatchObject({ killSignal: "SIGKILL" });
  });

  test("has no listing on Windows or Linux, and spawns nothing there", async () => {
    expect(await listClipboardTypesWithoutReading("win32")).toBeNull();
    expect(await listClipboardTypesWithoutReading("linux")).toBeNull();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  test("is unknown, not empty, when the helper is missing, fails or answers oddly", async () => {
    __setNamedImagePasteboardHelperForTests(null);
    expect(await listClipboardTypesWithoutReading("darwin")).toBeNull();
    expect(mocks.execFile).not.toHaveBeenCalled();

    __setNamedImagePasteboardHelperForTests(FAKE_HELPER);
    mocks.execFile.mockImplementation(
      (_f: string, _a: unknown, _o: unknown, callback: (error: Error) => void) => {
        callback(Object.assign(new Error("timed out"), { killed: true, signal: "SIGKILL" }));
      }
    );
    expect(await listClipboardTypesWithoutReading("darwin")).toBeNull();

    for (const stdout of ["not json", '{"types":[]}', "[1,2]"]) {
      mocks.execFile.mockImplementation(
        (_f: string, _a: unknown, _o: unknown, callback: (e: null, out: string) => void) => {
          callback(null, stdout);
        }
      );
      expect(await listClipboardTypesWithoutReading("darwin")).toBeNull();
    }
  });
});

describe("pasteFromClipboardMenuEnabled", () => {
  test.each(Object.entries(MAC_TYPES))(
    "never reads clipboard bytes on macOS (%s)",
    async (_label, types) => {
      helperLists(types);

      await pasteFromClipboardMenuEnabled("darwin");

      // getType, readBuffer, readImage, readText, readBookmark, and
      // clipboard.read() itself.
      expect(mocks.clipboardCalls).toEqual([]);
    }
  );

  test("follows the macOS types", async () => {
    helperLists(MAC_TYPES.image);
    expect(await pasteFromClipboardMenuEnabled("darwin")).toBe(true);
    helperLists(MAC_TYPES.text);
    expect(await pasteFromClipboardMenuEnabled("darwin")).toBe(false);
    helperLists(MAC_TYPES.empty);
    expect(await pasteFromClipboardMenuEnabled("darwin")).toBe(false);
  });

  test("is enabled when macOS cannot list types", async () => {
    __setNamedImagePasteboardHelperForTests(null);
    expect(await pasteFromClipboardMenuEnabled("darwin")).toBe(true);
    expect(mocks.clipboardCalls).toEqual([]);
  });

  test.each(["win32", "linux"] as const)(
    "is always enabled on %s and touches no clipboard",
    async (platform) => {
      expect(await pasteFromClipboardMenuEnabled(platform)).toBe(true);
      expect(mocks.clipboardCalls).toEqual([]);
      expect(mocks.execFile).not.toHaveBeenCalled();
    }
  );
});
