# Paste from Clipboard pulled other devices' clipboards across the network

**Symptom.** The operator saw clipboard items, images and files, transferred
over the network that they never asked to paste. They had been copied on
another device (Universal Clipboard) or in a remote-desktop session.

**Cause.** The enablement check for File → New → Paste from Clipboard read
clipboard bytes. It ran on every File menu open, on every menu rebuild and
after PwrSnap's own copies. Before the Electron 44 upgrade it called
`clipboard.readImage()`, which reads and decodes the whole image. On 44 it
read the bookmark, `text/uri-list` and `text/plain` whenever no image type
was listed.

On macOS such an item is promised data. The pasteboard lists its types, and
the bytes of a flavor are fetched from the owner, across the network, only
when some app asks for them. A menu hint asking for bytes is a transfer the
user did not ask for.

## Measurement

To decide whether "list the types" is safe, a probe put an item on the
general pasteboard whose every flavor was **promised**. It used
`NSPasteboardItem.setDataProvider(_:forTypes:)`, the lazy mechanism remote
clipboards use, and the provider logged each request for bytes. Each
listing ran against a fresh item, because a provided flavor is cached and
not requested twice. The control (`getType` on every listed type) fetched
the bytes in every case.

macOS 26.6, Electron 44.5.1 and 41.10.7. "—" means nothing was fetched.

| Item | AppKit `types` (helper `--list-types`) | E44 `read()` / `has()` | E41 `availableFormats()` | E41 `has(fmt)` |
|---|---|---|---|---|
| image (png + tiff) | — | — | — | — |
| web link | — | `public.url-name`, `public.url` | — | — |
| Finder file + icon | — | — | — | — |
| Chromium custom data + html | — | — | `org.chromium.web-custom-data` | — |
| W3C web custom format | — | `org.w3.web-custom-format.map` | — | — |
| plain text | — | — | — | — |
| image beside a file URL | — | — | — | — |

Where each fetch comes from, in Chromium 152 and Electron 44.5.1:

- Electron's `EnumerateAvailableTypes` (behind both `read()` and `has()`)
  calls `Clipboard::ReadURL` on every non-Linux platform to decide whether to
  list `electron application/bookmark`. On macOS that is `stringForType:` for
  `public.url-name` and `public.url`. On Windows it is
  `GetClipboardData(CFSTR_INETURLW)`, which renders a delay-rendered format.
  The Windows half is from source only; it was not measured.
- `ReadAvailableStandardAndCustomFormatNames` reads the W3C custom-format map
  whenever one is listed, on every platform.
- Electron 41's `availableFormats()` went through `ReadAvailableTypes`, which
  reads `org.chromium.web-custom-data` to list custom MIME types.

So Electron 44 has no types-only listing anywhere. AppKit's
`NSPasteboard.types` is one, on macOS.

A side finding: **macOS fetches a promised `public.file-url` from its writer
the moment it is written**, 0–1 ms after `writeObjects`, with no reader
involved and no other type affected. A file URL can therefore never stay
lazy, and the probe writes it eagerly so it cannot mask the other flavors.

## What changed

- The Swift `pasteboard-writer` helper (shipped as
  `PwrSnapPasteboardWriter`) gained `--list-types`, which prints
  `NSPasteboard.general.types` as JSON and reads nothing else. Measured
  against the same seven items, it fetched nothing. It spawns in about 10 ms.
- `clipboard/pasteboard-types.ts` lists types through that helper on macOS
  and returns null elsewhere. `clipboard/paste-menu-hint.ts` enables the item
  when an `image/*` type, a raw image flavor, a file-URL or URL type, or (on
  Windows) a file-drop format is listed. When there is no listing, it is
  always enabled.
- macOS also refreshes the item on `did-become-active`. The listing is async,
  so the `menu-will-show` answer lands after the menu draws, and the first
  File open after a copy in another app used to show the previous answer.
  The upgrade had tried a focus refresh once and removed it, because that
  probe read bytes on every click into PwrSnap. A types-only refresh costs one
  short process and transfers nothing.

## Re-measuring

A minimal provider is enough. Run it, then run the listing under test from
another process, then a `getType` control:

```swift
import AppKit
final class P: NSObject, NSPasteboardItemDataProvider {
  func pasteboard(_ pb: NSPasteboard?, item: NSPasteboardItem,
                  provideDataForType type: NSPasteboard.PasteboardType) {
    print("PROVIDE \(type.rawValue)"); fflush(stdout)
    item.setData("x".data(using: .utf8)!, forType: type)
  }
}
let p = P(), item = NSPasteboardItem()
_ = item.setDataProvider(p, forTypes: [.URL, .init("public.url-name"), .string])
NSPasteboard.general.clearContents()
NSPasteboard.general.writeObjects([item])
RunLoop.main.run()
```

Two things that wreck the measurement:

- A clipboard manager can fetch a flavor before the listing runs, after
  which the provider is never asked again. Add an empty
  `org.nspasteboard.TransientType` flavor (well-behaved managers skip the
  item), and log for a second before the listing so a background fetch shows
  up as one.
- Electron 41's `readImage()` hung for nearly ten minutes, until killed,
  against an item whose file URL named a file that did not exist. With the
  URL pointing at a real image it returned at once. Point it at a real file.
