# macOS 26.6.2 drew the app icon on a light plate — ship a `.icon`, not just a `.icns`

*2026-09-05 — [#PR_NUMBER](https://github.com/pwrdrvr/PwrSnap/pull/PR_NUMBER)*

## Symptom

On a Mac Mini running macOS 26.6.2, the 1.1.0-alpha.6 DMG and the installed
app both showed the PwrSnap icon as a **dark tile shrunk inside a light-gray
rounded plate** — in the Dock, in Finder, in the DMG window. PwrGit's fresh
build did the same. PwrAgent, installed weeks earlier and untouched, looked
normal. Downgrading PwrSnap to alpha.4 fixed the icon on the same machine.

The same alpha.6 DMG, opened on a MacBook Pro running macOS **26.6.1**,
looked correct. Same bytes.

## Cause

Two facts, one of which we controlled.

**Ours:** #534 (2026-09-01) moved the shipped `.icns` artwork into Apple's
legacy 824-in-1024 safe area — a 100px transparent margin — because on macOS
15 a full-bleed `.icns` draws about 24% larger than Terminal next to it.
PwrGit got the identical change twelve seconds later (#187 there), which is
why both apps "broke together" and PwrAgent did not. Measured raw fill of the
1024px rep:

| Icon | Raw fill |
| --- | --- |
| PwrAgent (untouched, full-bleed) | 100.0% |
| PwrSnap alpha.4 (full-bleed) | 100.0% |
| PwrSnap alpha.6 (#534, padded) | 80.5% |
| PwrGit post-#187 (padded) | 80.5% |

**Apple's:** an app that ships no Icon Composer `.icon` gets its legacy
`.icns` auto-normalized by macOS 26, and the normalizer's behavior for a
padded input changed between point releases. Rendering the alpha.6 bundle
through the system compositor:

| macOS | Full-bleed `.icns` | Padded `.icns` |
| --- | --- | --- |
| 26.6.1 (MBP) | normalized to 80.5% box | 80.5% box, no plate |
| 26.6.2 (Mini) | normalized, no plate | **light plate behind a shrunk tile** |
| 15.7.9 (MBP 2018) | drawn literally (oversize) | drawn literally (correct) |

So the padded `.icns` was right for macOS 15 and wrong for 26.6.2, and the
full-bleed one was the reverse. No single `.icns` satisfies both, and the
26.6.1 → 26.6.2 flip means the answer would keep moving.

The build was clean: the `.icns` inside the alpha.6 DMG was byte-identical to
`build/icon.icns` at HEAD. Icon cache, TCC, Gatekeeper, and dark mode were
ruled out (both machines were in dark mode; the DMG's `.icns` decoded all ten
reps on both).

## Why Ghostty doesn't have this problem

Ghostty (MIT) ships **both** formats: `CFBundleIconName` → `Assets.car`
compiled from `images/Ghostty.icon` (added 2025-06-21, twelve days after
WWDC 25), plus `CFBundleIconFile` → `Ghostty.icns`. Its `.icns` is padded to
**80.9%** — the same shape as our alpha.6 — and is not hand-built at all: there
is no `iconutil` anywhere in the repo, it is `actool`'s generated fallback.
macOS 26 reads the asset catalog and never opens the `.icns`, so the
normalizer never runs on it.

## Fix

Ship the same pair. `generate-app-icon.swift` now emits
`build/icon.icon/` — `icon.json` with the tile as the package `fill` and a
single glyph-only layer, `Assets/glyph.png` — and electron-builder's
`mac.icon` points at it. app-builder-lib 26.15.7 already supports this
(`util/macosIconComposer.js`): at package time it runs `actool`, writes
`Assets.car` + `CFBundleIconName`, and derives `icon.icns` +
`CFBundleIconFile` from the same source. The hand-built `.icns` and
`.iconset` are deleted. `icon.png` (Windows master, full-bleed) and
`icon-macos.png` (development Dock icon, padded) are unchanged.

Nothing about the `.icon` needed Icon Composer's GUI. The schema is plain
JSON referencing PNG layers (compare Ghostty's `icon.json`), so the
generator writes it deterministically and a test compiles it.

Compiled output for our package on this machine:

| Output | Result |
| --- | --- |
| `Assets.car` | Aqua, DarkAqua, Tintable renditions + `Icon.iconstack` |
| generated `Icon.icns` | ic04 / ic07 / ic11 / ic13, raw fill 80.9% (same as Ghostty) |
| partial Info.plist | `CFBundleIconName = Icon`, `CFBundleIconFile = Icon` |
| two-key bundle, system-composited | 80.5% box, dark tile, no plate |

The build machine needs Xcode 26+ selected: electron-builder hard-fails on
`actool` < 26, and GitHub's `macos-15` image defaults to 16.4 with 26.0.1 –
26.3 installed alongside. `release.yml` selects the newest 26.x in both
macOS jobs and asserts the version.

One actool trap, found while writing the test: **`--app-icon Icon` is
resolved by the package's basename.** Compile `build/icon.icon` directly
with that flag and actool exits 0, writes `Assets.car`, and silently emits
**no `Icon.icns`** — the app icon was never registered as the app icon.
electron-builder copies the package to `Icon.icon` before compiling for
exactly this reason (`macosIconComposer.js`), and `app-icon.test.mjs`
stages it the same way. Compile by hand the same way, or check for the
`.icns` in the output.

The proof for this PR was the real pipeline, not the scratch compile:
`release.mjs --prepare-only`, the controlled ffmpeg copied into the stage
from the alpha.6 DMG, then `release.mjs --sign-stage-only --dryrun`. The
resulting universal `PwrSnap.app` carried `CFBundleIconName = Icon`,
`CFBundleIconFile = icon.icns`, `Assets.car`, and the actool `icon.icns`;
lipo, helper signing, and asar checks all passed.

## How to verify — ask macOS, don't eyeball the PNG

Dock and Finder draw `NSWorkspace.shared.icon(forFile:)`. Render it and
measure the opaque bounds; a plate shows up as a bounding box that reaches
the canvas edge with a light color behind the tile.

```swift
// swift probe.swift /path/to/Some.app
import Cocoa
let img = NSWorkspace.shared.icon(forFile: CommandLine.arguments[1])
let px = 512
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px,
  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
img.draw(in: NSRect(x: 0, y: 0, width: px, height: px))
NSGraphicsContext.restoreGraphicsState()
var minX = px, maxX = -1
for y in 0..<px { for x in 0..<px {
  if let c = rep.colorAt(x: x, y: y), c.alphaComponent > 0.125 {
    minX = min(minX, x); maxX = max(maxX, x) } } }
print("fill \(Double(maxX - minX + 1) / Double(px) * 100)%")
try? rep.representation(using: .png, properties: [:])?
  .write(to: URL(fileURLWithPath: "probe.png"))
```

Three things this investigation kept tripping over:

- **A screenshot of the Dock is not enough** — the Dock auto-hides and the
  compositor's output at 64pt hides a plate behind the tile's own shadow.
  Render at 512 and look at `probe.png`.
- **The probe only fires on the affected OS.** 26.6.1 renders the alpha.6
  icon clean; the GitHub `macos-15` runner cannot see it at all. Verify on
  the newest macOS you ship to. That is also why this is documented as an
  invariant rather than a CI gate: no gate on the build machine can catch
  a compositor change on the user's machine.
- **`NSImage(contentsOfFile:)` on a `.icns` shows what macOS 15 draws**
  (the literal canvas); `NSWorkspace.icon(forFile:)` on the `.app` shows
  what macOS 26 draws. Measuring one and reasoning about the other is how
  #534 looked correct.

## What we ruled out first

- Icon cache / stale Dock — the DMG window (fresh mount) showed it too.
- A build-side double inset — shipped `.icns` was byte-identical to HEAD.
- Bad `.icns` packing (PwrGit #125 had that before) — all ten reps decoded.
- Dark mode — both Macs were in dark mode; only the OS build differed.
