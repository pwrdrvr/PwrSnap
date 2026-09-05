#!/usr/bin/env swift

import AppKit
import Foundation

// Regenerates the PwrSnap app-icon assets under apps/desktop/build/:
//
//   swift scripts/generate-app-icon.swift build
//
//   build/icon.icon/          Icon Composer package — the ONLY macOS input.
//     icon.json               background fill + one glyph layer
//     Assets/glyph.png        the mark alone, 1024×1024, transparent
//   build/icon.png            1024×1024 unpadded master (Windows .ico source)
//   build/icon-macos.png      1024×1024 with the tile inset to Apple's 824px
//                             legacy safe area — the DEVELOPMENT Dock icon only
//
// electron-builder (`mac.icon: build/icon.icon`) compiles the package with
// Xcode 26's actool into Contents/Resources/Assets.car + CFBundleIconName
// (what macOS 26 draws) AND derives the legacy Contents/Resources/icon.icns +
// CFBundleIconFile (macOS 15 and earlier) from the same source. There is
// deliberately no hand-built .icns / .iconset any more: a macOS 26 build
// that only finds a legacy .icns guesses at how to normalize it, and 26.6.2
// guessed a light plate behind our padded tile. See AGENTS.md "macOS app
// icon" and docs/solutions/2026-09-05-macos-26-legacy-icon-light-plate.md.

let buildDir = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "build")

struct Color {
  // Warm near-black vertical gradient matching the PwrAgent app icon, as
  // 0–255 device-RGB endpoints (image top = lighter, bottom = near-black).
  // Interpolated per scanline in encoded space below — NSGradient would
  // interpolate in linear light and render the upper half too bright.
  static let bgTop: (r: Double, g: Double, b: Double) = (30, 26, 20)
  static let bgBottom: (r: Double, g: Double, b: Double) = (10, 9, 8)

  // Accent orange — matched to PwrAgent's icon, whose most-saturated bar
  // samples to rgb(232,116,58) / #e8743a. Kept as raw device-RGB components
  // and handed straight to CGContext.setStrokeColor(red:green:blue:alpha:),
  // which is DeviceRGB — the previous calibratedRGB NSColor drifted lighter
  // to #ee894a through the calibrated→device conversion.
  static let markR: CGFloat = 232 / 255.0
  static let markG: CGFloat = 116 / 255.0
  static let markB: CGFloat = 58 / 255.0

  // The three depth tiers of the stacked-screenshots mark.
  static let frontAlpha: CGFloat = 1.0
  static let midAlpha: CGFloat = 0.55
  static let backAlpha: CGFloat = 0.3
}

/// Renders the icon at `size` px.
///
/// - `macOSCanvas`: inset the tile to Apple's legacy 824-in-1024 safe area
///   (a 100px transparent margin). Pre-26 macOS draws a .icns canvas
///   literally, so a full-bleed tile reads ~24% larger than Terminal next to
///   it. Used for the development Dock PNG only — the shipped legacy .icns
///   is derived by actool from the .icon package, which pads it itself.
/// - `glyphOnly`: skip the tile and paint just the mark on a transparent
///   canvas. This is the Icon Composer layer; the tile comes from the
///   package's `fill`, which is what lets macOS 26 apply its own shape,
///   glass edge, and Dark / Clear / Tinted variants.
func renderIcon(size: Int, macOSCanvas: Bool = false, glyphOnly: Bool = false) -> NSBitmapImageRep {
  guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: size,
    pixelsHigh: size,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  ) else { fatalError("Unable to create bitmap") }
  bitmap.size = NSSize(width: CGFloat(size), height: CGFloat(size))

  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)

  let s = CGFloat(size)
  let canvasScale = s / 1024.0
  let tileInset = macOSCanvas ? 100 * canvasScale : 0
  let tileSize = macOSCanvas ? 824 * canvasScale : s
  let scale = tileSize / 1024.0
  let cg = NSGraphicsContext.current!.cgContext
  let bounds = CGRect(x: tileInset, y: tileInset, width: tileSize, height: tileSize)

  if !glyphOnly {
    // Rounded-rect background — vertical gradient (warm charcoal at the top,
    // near-black at the bottom), matching the PwrAgent app icon. Filled per
    // scanline in device-RGB (encoded) space so the ramp is linear in the
    // output pixels; NSGradient interpolates in linear light and renders the
    // upper half too bright. The bitmap context is y-up, so image row 0 (the
    // top, lighter end) maps to the highest AppKit y.
    let cornerRadius = macOSCanvas ? 185 * canvasScale : 180 * scale
    let bg = NSBezierPath(roundedRect: NSRect(
                            x: tileInset,
                            y: tileInset,
                            width: tileSize,
                            height: tileSize),
                          xRadius: cornerRadius, yRadius: cornerRadius)
    NSGraphicsContext.saveGraphicsState()
    bg.addClip()
    let rows = max(1, Int(tileSize.rounded(.up)))
    for row in 0..<rows {
      let t = rows > 1 ? Double(row) / Double(rows - 1) : 0  // 0 at top, 1 at bottom
      let r = (Color.bgTop.r + (Color.bgBottom.r - Color.bgTop.r) * t) / 255.0
      let g = (Color.bgTop.g + (Color.bgBottom.g - Color.bgTop.g) * t) / 255.0
      let b = (Color.bgTop.b + (Color.bgBottom.b - Color.bgTop.b) * t) / 255.0
      NSColor(deviceRed: CGFloat(r), green: CGFloat(g), blue: CGFloat(b), alpha: 1).setFill()
      NSRect(
        x: tileInset,
        y: tileInset + tileSize - CGFloat(row) - 1,
        width: tileSize,
        height: 1
      ).fill()
    }
    NSGraphicsContext.restoreGraphicsState()
  }

  // ---------------------------------------------------------------------
  // Three stacked rectangles (PwrSnap mark) — centered in the icon.
  //
  // The tiers are a HARD STACK, not a blend. Painting back → mid → front
  // with plain source-over is technically correct alpha compositing, but it
  // is not the mark: the back tier's 30% stroke shows *through* the mid
  // tier's 55% stroke, and every crossing lights up as a brighter, more
  // saturated patch — an X-ray look that reads as a rendering artifact.
  //
  // Instead each tier is knocked out wherever a tier in FRONT of it covers,
  // so the front and mid rects are immutable in colour and opacity anywhere
  // they are seen, and the back rect is simply behind them. Antialiasing is
  // unaffected: the knockout clip's partial coverage at a boundary is
  // exactly 1 − (the covering tier's coverage), i.e. the same weight plain
  // source-over would have applied — so edges stay smooth, no seams.
  // ---------------------------------------------------------------------
  let rectWidth = 450 * scale
  let rectHeight = 340 * scale
  let rx = 48 * scale
  let strokeWidth = 56 * scale
  let offsetX = 64 * scale
  let offsetY = 80 * scale

  let centerX = tileInset + tileSize / 2
  let centerY = tileInset + tileSize / 2

  func markPath(dx: CGFloat, dy: CGFloat) -> CGPath {
    let rect = CGRect(x: centerX - rectWidth / 2 + dx,
                      y: centerY - rectHeight / 2 + dy,
                      width: rectWidth, height: rectHeight)
    return CGPath(roundedRect: rect, cornerWidth: rx, cornerHeight: rx, transform: nil)
  }

  // The area a stroked tier actually covers — used to cut it out of the
  // tiers behind it.
  func strokeRegion(_ path: CGPath) -> CGPath {
    path.copy(strokingWithWidth: strokeWidth, lineCap: .round, lineJoin: .round, miterLimit: 10)
  }

  func paint(_ path: CGPath, alpha: CGFloat, occludedBy occluders: [CGPath]) {
    cg.saveGState()
    // Each clip is "the whole tile MINUS this occluder's stroke band",
    // expressed even-odd (bounds + ring outline). Sequential clips
    // intersect, so N occluders knock out their union.
    for occluder in occluders {
      let inverse = CGMutablePath()
      inverse.addRect(bounds)
      inverse.addPath(strokeRegion(occluder))
      cg.addPath(inverse)
      cg.clip(using: .evenOdd)
    }
    cg.addPath(path)
    cg.setLineWidth(strokeWidth)
    cg.setLineJoin(.round)
    cg.setLineCap(.round)
    cg.setStrokeColor(red: Color.markR, green: Color.markG, blue: Color.markB, alpha: alpha)
    cg.strokePath()
    cg.restoreGState()
  }

  // Back rect (faintest) — top-right of the stack, y-up context
  let back = markPath(dx: offsetX, dy: offsetY)
  // Middle rect — centered
  let mid = markPath(dx: 0, dy: 0)
  // Front rect (full opacity) — bottom-left of the stack
  let front = markPath(dx: -offsetX, dy: -offsetY)

  paint(back, alpha: Color.backAlpha, occludedBy: [mid, front])
  paint(mid, alpha: Color.midAlpha, occludedBy: [front])
  paint(front, alpha: Color.frontAlpha, occludedBy: [])

  NSGraphicsContext.restoreGraphicsState()
  return bitmap
}

func writePNG(_ rep: NSBitmapImageRep, to url: URL, label: String) throws {
  guard let data = rep.representation(using: .png, properties: [:]) else {
    fatalError("Unable to create PNG for \(label)")
  }
  try data.write(to: url)
  print("  \(label) (\(rep.pixelsWide)x\(rep.pixelsHigh))")
}

/// One gradient stop in Icon Composer's `srgb:r,g,b,a` notation. The
/// fixed five-decimal format keeps `icon.json` byte-for-byte deterministic.
func gradientStop(_ c: (r: Double, g: Double, b: Double)) -> String {
  String(format: "srgb:%.5f,%.5f,%.5f,1.00000", c.r / 255.0, c.g / 255.0, c.b / 255.0)
}

// --- build/icon.icon — the Icon Composer package ---------------------------
//
// The schema is the one Icon Composer writes (compare Ghostty's
// images/Ghostty.icon/icon.json, MIT). `fill` paints the whole icon shape;
// the single layer is the mark with `fill: automatic` so Dark / Clear /
// Tinted appearances can recolor it. `glass: false` keeps the mark a flat
// stroke — only the tile edge picks up the macOS 26 glass treatment.
let iconPackage = buildDir.appendingPathComponent("icon.icon")
let assetsDir = iconPackage.appendingPathComponent("Assets")
try FileManager.default.createDirectory(at: assetsDir, withIntermediateDirectories: true)

try writePNG(
  renderIcon(size: 1024, glyphOnly: true),
  to: assetsDir.appendingPathComponent("glyph.png"),
  label: "icon.icon/Assets/glyph.png"
)

let iconJSON = """
{
  "fill" : {
    "linear-gradient" : [
      "\(gradientStop(Color.bgTop))",
      "\(gradientStop(Color.bgBottom))"
    ]
  },
  "groups" : [
    {
      "name" : "Mark",
      "layers" : [
        {
          "name" : "glyph",
          "image-name" : "glyph.png",
          "fill" : "automatic",
          "glass" : false,
          "hidden" : false,
          "blend-mode" : "normal"
        }
      ],
      "lighting" : "individual",
      "shadow" : {
        "kind" : "neutral",
        "opacity" : 0.5
      },
      "translucency" : {
        "enabled" : false,
        "value" : 0.5
      }
    }
  ],
  "supported-platforms" : {
    "circles" : [
      "watchOS"
    ],
    "squares" : "shared"
  }
}

"""
try iconJSON.write(to: iconPackage.appendingPathComponent("icon.json"), atomically: true, encoding: .utf8)
print("  icon.icon/icon.json")

// --- build/icon.png — unpadded master (Windows .ico source) -----------------
try writePNG(
  renderIcon(size: 1024),
  to: buildDir.appendingPathComponent("icon.png"),
  label: "icon.png"
)

// --- build/icon-macos.png — development Dock icon ---------------------------
//
// `app.dock.setIcon()` in development paints this PNG literally, with none
// of the packaged-app icon handling, so it carries the legacy safe-area
// inset itself (see development-dock-icon.ts).
try writePNG(
  renderIcon(size: 1024, macOSCanvas: true),
  to: buildDir.appendingPathComponent("icon-macos.png"),
  label: "icon-macos.png"
)

print("Generated app-icon assets in \(buildDir.path)")
