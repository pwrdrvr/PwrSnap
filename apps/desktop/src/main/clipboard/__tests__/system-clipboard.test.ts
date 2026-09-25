import { beforeEach, describe, expect, test, vi } from "vitest";

// A fake of the Electron 44 clipboard, shaped after what 44.4.5 did on
// macOS 26 when probed: `read()` lists each flavor under its MIME type or
// its `osclipboard` type, and `getType()` rejects any type not listed.
const fake = vi.hoisted(() => ({
  items: [] as Array<Record<string, Buffer | { title: string; url: string }>>,
  written: [] as Array<Record<string, Blob | string>>
}));

vi.mock("electron", () => ({
  clipboard: {
    read: vi.fn(async () =>
      fake.items.map((flavors) => ({
        types: Object.keys(flavors),
        getType: async (type: string) => {
          const value = flavors[type];
          if (value === undefined) {
            throw new Error(`The type '${type}' was not found in the ClipboardItem`);
          }
          return Buffer.isBuffer(value) ? new Blob([new Uint8Array(value)]) : value;
        }
      }))
    ),
    write: vi.fn(async (items: Array<{ payload: Record<string, Blob | string> }>) => {
      fake.written.push(...items.map((item) => item.payload));
    }),
    writeText: vi.fn(async () => undefined),
    clear: vi.fn()
  },
  ClipboardItem: class {
    payload: Record<string, Blob | string>;
    constructor(payload: Record<string, Blob | string>) {
      this.payload = payload;
    }
  },
  nativeImage: {
    createEmpty: () => ({ isEmpty: () => true, bytes: Buffer.alloc(0) }),
    createFromBuffer: (bytes: Buffer) => ({ isEmpty: () => bytes.length === 0, bytes })
  }
}));

const {
  clipboardFormatName,
  rawClipboardType,
  readClipboard,
  writeClipboard,
  writeClipboardImage
} = await import("../system-clipboard");

const raw = rawClipboardType;

beforeEach(() => {
  fake.items = [];
  fake.written = [];
});

describe("clipboard format names", () => {
  test("wraps and unwraps a raw platform flavor", () => {
    expect(raw("public.file-url")).toBe('electron application/osclipboard;format="public.file-url"');
    expect(clipboardFormatName(raw("NeXT TIFF v4.0 pasteboard type"))).toBe(
      "NeXT TIFF v4.0 pasteboard type"
    );
  });

  test("leaves MIME types and other custom formats as they are", () => {
    expect(clipboardFormatName("image/png")).toBe("image/png");
    expect(clipboardFormatName("electron application/bookmark")).toBe(
      "electron application/bookmark"
    );
  });
});

describe("readClipboard", () => {
  test("lists MIME types as-is and raw flavors by their platform name", async () => {
    // A native PNG on macOS, as 44.4.5 listed it.
    fake.items = [
      {
        "image/png": Buffer.from("png"),
        [raw("Apple PNG pasteboard type")]: Buffer.from("png"),
        [raw("NeXT TIFF v4.0 pasteboard type")]: Buffer.from("tiff")
      }
    ];
    const snapshot = await readClipboard();
    expect(snapshot.formats).toEqual([
      "image/png",
      "Apple PNG pasteboard type",
      "NeXT TIFF v4.0 pasteboard type"
    ]);
    expect((await snapshot.readBuffer("NeXT TIFF v4.0 pasteboard type")).toString()).toBe("tiff");
  });

  test("finds a Finder file URL under text/uri-list, never under its UTI", async () => {
    fake.items = [
      {
        "text/uri-list": Buffer.from("file:///tmp/a.png"),
        [raw("NSFilenamesPboardType")]: Buffer.from("<plist/>")
      }
    ];
    const snapshot = await readClipboard();
    expect((await snapshot.readBuffer("text/uri-list")).toString()).toBe("file:///tmp/a.png");
    expect(await snapshot.readBuffer("public.file-url")).toHaveLength(0);
  });

  test("reads the private layer-fragment UTI by its literal name", async () => {
    fake.items = [{ [raw("com.pwrdrvr.pwrsnap.layer-fragment")]: Buffer.from('{"v":1}') }];
    const snapshot = await readClipboard();
    expect(snapshot.has("com.pwrdrvr.pwrsnap.layer-fragment")).toBe(true);
    expect((await snapshot.readBuffer("com.pwrdrvr.pwrsnap.layer-fragment")).toString()).toBe(
      '{"v":1}'
    );
  });

  test("matches Windows format names without regard to case", async () => {
    fake.items = [{ [raw("PNG")]: Buffer.from("png") }];
    const snapshot = await readClipboard();
    expect((await snapshot.readBuffer("png")).toString()).toBe("png");
  });

  test("answers empty for an absent flavor instead of rejecting", async () => {
    fake.items = [{ "text/plain": Buffer.from("hello") }];
    const snapshot = await readClipboard();
    expect(await snapshot.readBuffer("image/png")).toHaveLength(0);
    expect((await snapshot.readImage()).isEmpty()).toBe(true);
    expect(await snapshot.readBookmark()).toBeNull();
    expect(await snapshot.readText()).toBe("hello");
  });

  test("decodes the image flavor and returns a bookmark as an object", async () => {
    fake.items = [
      {
        "image/png": Buffer.from("png bytes"),
        "electron application/bookmark": { title: "T", url: "file:///tmp/y.png" }
      }
    ];
    const snapshot = await readClipboard();
    const image = (await snapshot.readImage()) as unknown as { bytes: Buffer };
    expect(image.bytes.toString()).toBe("png bytes");
    expect(await snapshot.readBookmark()).toEqual({ title: "T", url: "file:///tmp/y.png" });
  });

  test("an emptied clipboard reads as one item with nothing in it", async () => {
    fake.items = [{}];
    const snapshot = await readClipboard();
    expect(snapshot.formats).toEqual([]);
    expect(await snapshot.readText()).toBe("");
  });
});

describe("writes", () => {
  test("puts the image and raw flavors in ONE item, so neither clears the other", async () => {
    await writeClipboard({
      png: Buffer.from("png"),
      raw: { "com.pwrdrvr.pwrsnap.layer-fragment": Buffer.from("{}") }
    });
    expect(fake.written).toHaveLength(1);
    const item = fake.written[0]!;
    expect(Object.keys(item)).toEqual([
      "image/png",
      raw("com.pwrdrvr.pwrsnap.layer-fragment")
    ]);
    expect((item["image/png"] as Blob).type).toBe("image/png");
    expect(Buffer.from(await (item["image/png"] as Blob).arrayBuffer()).toString()).toBe("png");
  });

  test("writes an image as its PNG encoding", async () => {
    await writeClipboardImage({ toPNG: () => Buffer.from("encoded") } as never);
    expect(Object.keys(fake.written[0]!)).toEqual(["image/png"]);
  });
});
