#!/usr/bin/env swift

import AppKit
import Foundation

let outputDir = CommandLine.arguments.dropFirst().first ?? "build/icon.iconset"

struct Color {
  // Warm near-black vertical gradient matching the PwrAgent app icon, as
  // 0–255 device-RGB endpoints (image top = lighter, bottom = near-black).
  // Interpolated per scanline in encoded space below — NSGradient would
  // interpolate in linear light and render the upper half too bright.
  static let bgTop: (r: Double, g: Double, b: Double) = (30, 26, 20)
  static let bgBottom: (r: Double, g: Double, b: Double) = (10, 9, 8)
  // Accent orange — matched to PwrAgent's icon, whose most-saturated bar
  // samples to rgb(232,116,58) / #e8743a. Defined in deviceRGB so the
  // output pixels land on that exact value; the previous calibratedRGB
  // value drifted lighter to #ee894a through the calibrated→device
  // conversion. The mid/back layers are the same hue at lower opacity.
  static let accent = NSColor(deviceRed: 232 / 255.0, green: 116 / 255.0, blue: 58 / 255.0, alpha: 1)
  static let accentMid = NSColor(deviceRed: 232 / 255.0, green: 116 / 255.0, blue: 58 / 255.0, alpha: 0.55)
  static let accentFaint = NSColor(deviceRed: 232 / 255.0, green: 116 / 255.0, blue: 58 / 255.0, alpha: 0.3)
}

func renderIcon(size: Int) -> NSBitmapImageRep {
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
  let scale = s / 1024.0

  // Rounded-rect background — vertical gradient (warm charcoal at the top,
  // near-black at the bottom), matching the PwrAgent app icon. Filled per
  // scanline in device-RGB (encoded) space so the ramp is linear in the
  // output pixels; NSGradient interpolates in linear light and renders the
  // upper half too bright. The bitmap context is y-up, so image row 0 (the
  // top, lighter end) maps to the highest AppKit y.
  let cornerRadius = 180 * scale
  let bg = NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: s, height: s),
                        xRadius: cornerRadius, yRadius: cornerRadius)
  NSGraphicsContext.saveGraphicsState()
  bg.addClip()
  let rows = Int(s)
  for row in 0..<rows {
    let t = rows > 1 ? Double(row) / Double(rows - 1) : 0  // 0 at top, 1 at bottom
    let r = (Color.bgTop.r + (Color.bgBottom.r - Color.bgTop.r) * t) / 255.0
    let g = (Color.bgTop.g + (Color.bgBottom.g - Color.bgTop.g) * t) / 255.0
    let b = (Color.bgTop.b + (Color.bgBottom.b - Color.bgTop.b) * t) / 255.0
    NSColor(deviceRed: CGFloat(r), green: CGFloat(g), blue: CGFloat(b), alpha: 1).setFill()
    NSRect(x: 0, y: s - CGFloat(row) - 1, width: s, height: 1).fill()
  }
  NSGraphicsContext.restoreGraphicsState()

  // Three stacked rectangles (PwrSnap mark) — centered in the icon
  let rectWidth = 450 * scale
  let rectHeight = 340 * scale
  let rx = 48 * scale
  let strokeWidth = 56 * scale
  let offsetX = 64 * scale
  let offsetY = 80 * scale

  let centerX = s / 2
  let centerY = s / 2

  // Back rect (faintest)
  let r3x = centerX - rectWidth / 2 + offsetX
  let r3y = centerY - rectHeight / 2 + offsetY
  let r3 = NSBezierPath(roundedRect: NSRect(x: r3x, y: r3y, width: rectWidth, height: rectHeight),
                        xRadius: rx, yRadius: rx)
  r3.lineWidth = strokeWidth
  Color.accentFaint.setStroke()
  r3.stroke()

  // Middle rect
  let r2x = centerX - rectWidth / 2
  let r2y = centerY - rectHeight / 2
  let r2 = NSBezierPath(roundedRect: NSRect(x: r2x, y: r2y, width: rectWidth, height: rectHeight),
                        xRadius: rx, yRadius: rx)
  r2.lineWidth = strokeWidth
  Color.accentMid.setStroke()
  r2.stroke()

  // Front rect (full opacity)
  let r1x = centerX - rectWidth / 2 - offsetX
  let r1y = centerY - rectHeight / 2 - offsetY
  let r1 = NSBezierPath(roundedRect: NSRect(x: r1x, y: r1y, width: rectWidth, height: rectHeight),
                        xRadius: rx, yRadius: rx)
  r1.lineWidth = strokeWidth
  Color.accent.setStroke()
  r1.stroke()

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
  let rep = renderIcon(size: size)
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

print("Generated \(sizes.count) icon variants in \(outputDir)")
