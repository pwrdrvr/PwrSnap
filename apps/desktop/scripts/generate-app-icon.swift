#!/usr/bin/env swift

import AppKit
import Foundation

// Regenerates apps/desktop/build/icon.iconset/* and build/icon.png for PwrSnap.
//
//   swift scripts/generate-app-icon.swift build/icon.iconset
//   iconutil -c icns build/icon.iconset -o build/icon.icns

let outputDir = CommandLine.arguments.dropFirst().first ?? "build/icon.iconset"

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

func renderIcon(size: Int, macOSCanvas: Bool = false) -> NSBitmapImageRep {
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

  // Rounded-rect background — vertical gradient (warm charcoal at the top,
  // near-black at the bottom), matching the PwrAgent app icon. Filled per
  // scanline in device-RGB (encoded) space so the ramp is linear in the
  // output pixels; NSGradient interpolates in linear light and renders the
  // upper half too bright. The bitmap context is y-up, so image row 0 (the
  // top, lighter end) maps to the highest AppKit y.
  // Legacy macOS renders the ICNS canvas literally. Apple's 1024px template
  // puts the rounded tile in an 824px square with a 100px transparent margin;
  // macOS 26 can normalize old icons automatically, but Sequoia and earlier
  // cannot. Keep the unpadded master for Windows/Linux and use this safe-area
  // canvas for the ICNS and the development Dock icon.
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

let sizes: [(Int, String)] = [
  (16, "icon_16x16.png"),
  (32, "icon_16x16@2x.png"),
  (32, "icon_32x32.png"),
  (64, "icon_32x32@2x.png"),
  (128, "icon_128x128.png"),
  (256, "icon_128x128@2x.png"),
  (256, "icon_256x256.png"),
  (512, "icon_256x256@2x.png"),
  (512, "icon_512x512.png"),
  (1024, "icon_512x512@2x.png"),
]

let outputURL = URL(fileURLWithPath: outputDir)
try FileManager.default.createDirectory(at: outputURL, withIntermediateDirectories: true)

for (size, filename) in sizes {
  let rep = renderIcon(size: size, macOSCanvas: true)
  guard let pngData = rep.representation(using: .png, properties: [:]) else {
    fatalError("Unable to create PNG for \(filename)")
  }
  let file = outputURL.appendingPathComponent(filename)
  try pngData.write(to: file)
  print("  \(filename) (\(size)x\(size))")
}

let dockIconRep = renderIcon(size: 1024)
guard let dockIconPngData = dockIconRep.representation(using: .png, properties: [:]) else {
  fatalError("Unable to create PNG for icon.png")
}
let dockIconFile = outputURL.deletingLastPathComponent().appendingPathComponent("icon.png")
try dockIconPngData.write(to: dockIconFile)
print("  icon.png (1024x1024)")

let macOSDockIconRep = renderIcon(size: 1024, macOSCanvas: true)
guard let macOSDockIconPngData = macOSDockIconRep.representation(using: .png, properties: [:]) else {
  fatalError("Unable to create PNG for icon-macos.png")
}
let macOSDockIconFile = outputURL.deletingLastPathComponent().appendingPathComponent("icon-macos.png")
try macOSDockIconPngData.write(to: macOSDockIconFile)
print("  icon-macos.png (1024x1024)")

print("Generated \(sizes.count) icon variants in \(outputDir)")
