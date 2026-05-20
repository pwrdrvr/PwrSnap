---
title: Finder Quick Look Thumbnail Extension for .pwrsnap bundles
type: solution
date: 2026-05-19
area: desktop
tags: [quicklook, appex, macos, codesign, sandbox, pluginkit, swift, thumbnail-extension]
---

# Finder Quick Look Thumbnail Extension

How `.pwrsnap` bundles get per-file thumbnails in Finder, column-view
preview, Spotlight results, and anywhere else macOS asks for "the
icon for this file." Captured because we hit three separate silent-
failure pitfalls landing this — each one looks like "everything is
configured correctly and nothing happens" with no log entry to grep
for.

## Topology

```
┌──────────────┐   QLFileThumbnailRequest    ┌─────────────────────────────┐
│ Finder       │ ──────────────────────────► │ pluginkit / extensionkitd    │
│ Spotlight    │                              │   scans Contents/PlugIns/    │
│ qlmanage     │ ◄────── QLThumbnailReply ─── │   spawns extension worker    │
└──────────────┘    (drawn bitmap or URL)     └──────────────┬───────────────┘
                                                             │ XPC
                                                             ▼
                                       ┌──────────────────────────────────────┐
                                       │ PwrSnapThumbnailExtension.appex      │
                                       │  Contents/                            │
                                       │    Info.plist     ← NSExtension dict │
                                       │    MacOS/         ← MH_EXECUTE binary │
                                       │    _CodeSignature ← Developer ID +    │
                                       │                     sandbox entitle.  │
                                       └────────────────┬─────────────────────┘
                                                        │ Data(contentsOf:)
                                                        ▼
                                          ┌─────────────────────────────┐
                                          │ ~/Documents/PwrSnap/*.pwrsnap│
                                          │  ZIP central directory walk  │
                                          │  composite_thumbnail.jpg →   │
                                          │  composite.png →             │
                                          │  source.png (fallback chain) │
                                          └─────────────────────────────┘
```

The extension is sandboxed, runs out-of-process from Finder, and gets
ONLY a sandbox extension token granting read access to the file URL
in the request. No network, no other filesystem, no IPC to PwrSnap's
main app. The extension worker is short-lived: macOS spawns it on
demand and kills it when idle.

## File layout

| Path | What |
|---|---|
| `apps/desktop/native/thumbnail-extension/zip-reader.swift` | The whole extension — minimal STORE-mode ZIP reader + `extractPwrSnapThumbnailData()` (fallback chain) + `@objc(ThumbnailProvider) final class ThumbnailProvider: QLThumbnailProvider` |
| `apps/desktop/native/thumbnail-extension/cli.swift` | Diagnostic CLI (`PwrSnapThumbnailCli`) — same extraction logic, callable from a shell so we can repro on a user machine without Finder gymnastics |
| `apps/desktop/native/thumbnail-extension/Info.plist` | `CFBundlePackageType: XPC!`, `NSExtensionPointIdentifier: com.apple.quicklook.thumbnail`, `NSExtensionPrincipalClass: ThumbnailProvider`, `QLSupportedContentTypes: [com.pwrdrvr.pwrsnap.bundle]` |
| `apps/desktop/build/entitlements.thumbnail-extension.plist` | `com.apple.security.app-sandbox: true` + `com.apple.security.files.user-selected.read-only: true`. Minimal — no V8/libvips exemptions, this is a sandboxed Quick Look provider not the parent app. |
| `apps/desktop/scripts/build-native.mjs` | Compiles `.appex` via `swiftc` with `-Xlinker -e -Xlinker _NSExtensionMain` to get an MH_EXECUTE binary; also builds the standalone CLI |
| `apps/desktop/scripts/afterpack-sign-appex.mjs` | electron-builder `afterPack` hook — signs the `.appex` with Developer ID + the entitlements file BEFORE the parent app's codesign pass walks the bundle tree |
| `apps/desktop/electron-builder.yml` | Wires the `.appex` into `Contents/PlugIns/`, the CLI into `Contents/Resources/PwrSnapThumbnailCli`, declares the `com.pwrdrvr.pwrsnap.bundle` UTI, points `afterPack` at the signing hook |

## Bundle layout — what the extension reads

Each `.pwrsnap` is a ZIP container holding:

| Entry | Required | What it is |
|---|---|---|
| `manifest.json` | yes | Capture metadata (id, dimensions, sha256, timestamps) |
| `overlays.json` | yes | Annotation layers (empty for unedited captures) |
| `source.png` | yes | Original capture pixels — never modified |
| `composite_thumbnail.jpg` | post-PR-90, optional | ≤1024px JPEG q80 of the rendered composite, written when overlays change the appearance |
| `composite.png` | pre-PR-90 bundles | Full-res rendered composite (deprecated; ~half the library still has these) |

The extension's extraction chain (see `extractPwrSnapThumbnailData`):

1. `composite_thumbnail.jpg` — the preferred path; small, JPEG, already-cropped
2. `composite.png` — legacy bundles only; full-res, fine but slower to decode
3. `source.png` — captures with no overlays (composite equals source byte-for-byte, so PR #90's writer skips composite_thumbnail.jpg generation)

All three are decoded via `NSImage(data:)`. The ZIP reader is a 280-LOC walk of the central directory — STORE entries only (PwrSnap doesn't deflate-compress images, which are already compressed), no Zip-Slip risk because we don't extract by name to disk, we extract by name into memory.

## The three silent-failure pitfalls

Each of these looks like "extension is installed, configured correctly,
nothing happens, no log entry anywhere." We hit all three in one
session; together they cost about half a day of debugging. The
following section is what each looked like + how to recognize it
fast.

### 1. MH_EXECUTE vs MH_BUNDLE — App Extensions are executables

**Symptom**: `.appex` lives in `Contents/PlugIns/`, signed with
Developer ID + hardened runtime, parent app codesign verifies, but
`pluginkit -mAv | grep pwrsnap` returns nothing. `lsregister -f -R`
and `pluginkit -a <path>` both run silently with no effect. **No log
entry anywhere** — not in `pkd`, not in `extensionkitd`, not in
`quicklookd`. System Settings → Extensions → Quick Look doesn't list
the app.

If you also try to add entitlements to the extension binary, you'll
find `codesign --entitlements path/to/plist <appex>` reports
"signed bundle" with no error, but `codesign -d --entitlements -`
afterward shows the binary has no entitlements blob at all. The
CodeDirectory `hashes=N+M` count never includes an entitlements slot.

**Root cause**: App Extensions on macOS are MH_EXECUTE binaries with
`_NSExtensionMain` (from Foundation) as the linker entry point. NOT
MH_BUNDLE (loadable bundles). Both `pluginkit` and `codesign
--entitlements` are silent no-ops on MH_BUNDLE. The Mach-O type is
set by the linker — `-emit-library -Xlinker -bundle` produces
MH_BUNDLE, while a normal `-o <out>` link produces MH_EXECUTE.

**How to recognize it fast**: `file
<appex>/Contents/MacOS/<binary>`. The output line will say either:

| Output | Diagnosis |
|---|---|
| `Mach-O 64-bit executable` | Good — pluginkit will see it |
| `Mach-O 64-bit bundle` | **This is the bug.** Will silently fail. |

Compare against any Apple system extension to confirm — they're all
MH_EXECUTE: `file /System/Applications/Books.app/Contents/PlugIns/BooksThumbnail.appex/Contents/MacOS/BooksThumbnail`.

**Fix**: in `build-native.mjs`, drop `-emit-library` and `-Xlinker
-bundle`. Add `-Xlinker -e -Xlinker _NSExtensionMain` to override
the linker's default `_main` entry point with the symbol Foundation
exports for App Extensions. Keep `-parse-as-library` because our
source files only declare types — there's no top-level Swift code to
serve as `_main`. NSExtensionMain reads `NSExtension.NSExtensionPrincipalClass`
from Info.plist, sets up the XPC connection with the host (Finder /
QuickLookUI), and instantiates `@objc(ThumbnailProvider)`.

### 2. App Sandbox is mandatory for Quick Look extensions

**Symptom**: MH_EXECUTE binary, correctly signed with Developer ID +
hardened runtime + entitlements file passed to codesign, `codesign -d
--entitlements -` reports the entitlements ARE embedded, but
`pluginkit` still doesn't list the extension. **Still no log entry
anywhere.**

**Root cause**: Quick Look thumbnail extensions are required to be
sandboxed. `pluginkit` silently rejects unsandboxed extensions at
scan time. The empty `<dict/>` entitlements file we shipped first
satisfied codesign but produced an extension with no sandbox →
pluginkit dropped it.

**How to recognize it fast**: `codesign -d --entitlements -
<your.appex>` vs `codesign -d --entitlements -
/System/Applications/Books.app/Contents/PlugIns/BooksThumbnail.appex`.
If yours has nothing and theirs has `com.apple.security.app-sandbox =
true`, this is the bug.

**Fix**: `apps/desktop/build/entitlements.thumbnail-extension.plist`
needs at minimum:

```xml
<key>com.apple.security.app-sandbox</key>
<true/>
<key>com.apple.security.files.user-selected.read-only</key>
<true/>
```

The first turns on the sandbox so pluginkit accepts the extension.
The second grants read access to the file URL the host hands us in
`QLFileThumbnailRequest.fileURL` — without it, our `Data(contentsOf:
url)` call inside the ZIP reader would deny.

**What NOT to add**: any of the V8 / libvips / cs.allow-* entitlements
the parent PwrSnap.app has (`build/entitlements.mac.plist`). The
extension does plain Foundation/AppKit work — no JIT, no unsigned
executable memory, no library-validation bypass. Adding any of those
defeats the point of running it in a separate sandboxed process.

### 3. QLThumbnailReply: two initializers, only one of them is sane

**Symptom**: Extension is registered, runs, returns thumbnails, but
on Retina displays they render at exactly 1/4 the slot area —
content tucked into the bottom-left quadrant of each thumbnail card
with white space filling the rest. On non-Retina displays this would
be invisible. Same symptom in every viewer (icon view, column view,
Spotlight, qlmanage output).

**Root cause**: `QLThumbnailReply` has two initializers that look
identical at the call site:

```swift
// Raw-CGContext form — context's coord transform is undocumented
// across releases. On Retina, drawing in your contextSize gives a
// half-size result tucked into the corner.
init(contextSize:, drawing: (CGContext) -> Bool)

// NSGraphicsContext-current form — macOS pre-applies the right
// scale transform. Drawing in POINTS just works.
init(contextSize:, currentContextDrawing: () -> Bool)
```

Both take `(contextSize:, closure:)` at the call site. Swift's
trailing-closure syntax picks the raw-CGContext overload when the
closure has one parameter (`{ context in ... }`). Easy to use
accidentally, hard to debug — there's no warning and the rendering
"sort of works."

**How to recognize it fast**: thumbnail content in bottom-left
quadrant of the slot, exactly 50% in each dimension. Always the
same proportion regardless of source image aspect. If it's any
other geometry (centered with letterboxing, stretched, cropped),
it's a different bug.

**Fix**: use the `currentContextDrawing:` initializer explicitly
(named-argument form so Swift can't pick the wrong overload), and
size the context to the full slot Finder gave you:

```swift
let reply = QLThumbnailReply(
  contextSize: request.maximumSize,
  currentContextDrawing: {
    // NSGraphicsContext.current is set up for us with the
    // right backing-store scale already applied
    image.draw(in: CGRect(origin: drawOrigin, size: drawSize))
    return true
  }
)
```

`request.maximumSize` is in POINTS. `currentContextDrawing` matches
Apple's QLThumbnailProvider sample code. Aspect-fit + center the
image within the slot so non-matching aspect ratios letterbox cleanly
rather than slamming against an edge.

**Failed alternative**: trying to compensate by inflating contextSize
to `maximumSize * request.scale` and drawing at the inflated pixel
size. macOS either rejected the oversized reply or our cached worker
held stale state — either way, thumbnails stopped rendering entirely.
The right move is to stop fighting the coordinate system and use the
helper Apple provides.

## Signing pipeline — afterPack hook

electron-builder 26.x's `@electron/osx-sign` doesn't auto-discover
`.appex` bundles when walking `Contents/` for nested code. It signs
the parent `Contents/MacOS/PwrSnap` first; the parent codesign pass
then traverses the sealed-resources manifest, finds our
`Contents/PlugIns/PwrSnapThumbnailExtension.appex`, sees it's
unsigned, and aborts:

```
code object is not signed at all
In subcomponent: .../PlugIns/PwrSnapThumbnailExtension.appex
```

Fix: `apps/desktop/scripts/afterpack-sign-appex.mjs` runs as the
electron-builder `afterPack` hook (configured in
`electron-builder.yml` top-level). The hook fires AFTER the staged
.app is packed and BEFORE the parent codesign pass starts. It signs
every `.appex` under `Contents/PlugIns/` with:

- Same Developer ID identity electron-builder will use for the parent
  (discovered via `CSC_NAME` env or `security find-identity -v -p
  codesigning`)
- `--options runtime` (hardened runtime)
- `--entitlements build/entitlements.thumbnail-extension.plist`
- `--timestamp` (Apple timestamp server)

For unsigned dev builds (no identity available), the hook ad-hoc
signs with `-`. Ad-hoc signing is enough for the .appex to be a
valid bundle on disk; the parent's `--deep` pass replaces these
signatures with the real Developer ID at release time.

**Do not pre-sign the `.appex` in `build-native.mjs`** — an ad-hoc
signature there conflicts with electron-builder's `--deep` re-sign
of the parent and trips:

```
PwrSnap.app: invalid Info.plist (plist or signature have been modified)
In subcomponent: .../PlugIns/PwrSnapThumbnailExtension.appex
```

The .appex stays unsigned out of `build-native.mjs` and the
`afterPack` hook is the sole signer.

## UTI declarations — how Finder knows .pwrsnap is ours

In `electron-builder.yml` under `mac.extendInfo`:

```yaml
UTExportedTypeDeclarations:
  - UTTypeIdentifier: com.pwrdrvr.pwrsnap.bundle
    UTTypeDescription: "PwrSnap Capture Bundle"
    UTTypeConformsTo: [public.data, public.composite-content]
    UTTypeIconFile: icon.icns
    UTTypeTagSpecification:
      public.filename-extension: [pwrsnap]
      public.mime-type: [application/vnd.pwrdrvr.pwrsnap.bundle+zip]

CFBundleDocumentTypes:
  - CFBundleTypeName: "PwrSnap Capture Bundle"
    CFBundleTypeRole: Editor
    LSHandlerRank: Owner
    LSItemContentTypes: [com.pwrdrvr.pwrsnap.bundle]
```

Two effects:

1. **UTI registration** — Launch Services indexes `com.pwrdrvr.pwrsnap.bundle`
   when PwrSnap.app first lands in `/Applications/`. Files with the
   `.pwrsnap` extension get classified under this UTI, which the
   thumbnail extension's `QLSupportedContentTypes` claims. macOS
   routes thumbnail requests for the UTI to our extension.

2. **Default-handler registration** — `CFBundleTypeRole: Editor` +
   `LSHandlerRank: Owner` make PwrSnap the default app for double-
   clicks on `.pwrsnap` files. The brand icon (`icon.icns`) becomes
   the file-type icon shown when no per-file thumbnail is available
   (small slot sizes below `QLThumbnailMinimumSize: 32`, or for
   files the extension can't render).

Launch Services caches UTI registrations aggressively. After deleting
a PwrSnap.app install, `.pwrsnap` files keep their brand icon for
some time because lsregister still has the UTI claim with `Bundle
node not found on disk`. Force a refresh with:

```bash
/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -f -R -trusted /Applications/PwrSnap.app
```

## Diagnostic CLI

`apps/desktop/native/thumbnail-extension/cli.swift` compiles to a
standalone binary (`build/native/pwrsnap-thumbnail-cli` in dev,
`/Applications/PwrSnap.app/Contents/Resources/PwrSnapThumbnailCli`
in release) that reuses the same extraction pipeline as the
extension. Useful when a user machine doesn't show thumbnails and
you need to rule out Finder/Quick Look cache issues vs an actual
extraction bug:

```bash
# Extract the embedded thumbnail data from a bundle
PwrSnapThumbnailCli ~/Documents/PwrSnap/<id>.pwrsnap -o /tmp/thumb.bin
file /tmp/thumb.bin    # JPEG / PNG with dimensions
open /tmp/thumb.bin    # Renders in Preview.app
```

If the CLI produces a valid image but Finder shows the brand icon,
the extension isn't being invoked — go through the three pitfalls
above starting with `pluginkit -mAv | grep pwrsnap`. If the CLI
errors out, the bug is in the ZIP reader / extraction chain.

## Live debugging checklist

When thumbnails aren't showing up, in order:

1. `pluginkit -mAv | grep pwrsnap` — is the extension registered?
   - **No** → pitfall #1 (MH_EXECUTE?) or #2 (sandbox?)
   - **Yes** → continue
2. `file /Applications/PwrSnap.app/Contents/PlugIns/PwrSnapThumbnailExtension.appex/Contents/MacOS/PwrSnapThumbnailExtension`
   - Must say `Mach-O 64-bit executable` (not `bundle`)
3. `codesign -d --entitlements - <path-to-appex>`
   - Must show `com.apple.security.app-sandbox = true`
4. `PwrSnapThumbnailCli ~/Documents/PwrSnap/<file>.pwrsnap -o /tmp/x.bin && file /tmp/x.bin`
   - Confirms the extraction pipeline works outside the extension
5. `qlmanage -t -s 512 -o /tmp ~/Documents/PwrSnap/<file>.pwrsnap`
   - Invokes the extension directly; output `.png` shows what Finder
     would render
6. `log show --last 5m --predicate 'subsystem CONTAINS "extensionkit" OR process == "pkd"' | grep -i pwrsnap`
   - Once registration works, runtime errors WILL log here (sandbox
     denials, principal-class lookup failures, drawing exceptions).
     The silent failures are all pre-registration.

## Related

- PR #14 — `.pwrsnap` bundle format v1 (which introduced the UTI)
- PR #90 — `composite_thumbnail.jpg` inside the bundle (gives this
  extension a small JPEG to render instead of decoding the full-res
  composite)
- PR #92 — this extension
- Future: Quick Look **Preview** Extension (Spacebar full-screen
  preview, separate `.appex` at extension point
  `com.apple.quicklook.preview`)
- Future: re-migrate the legacy bundles still carrying
  `composite.png == source.png` so they get a proper
  `composite_thumbnail.jpg` and Finder can decode less per request
