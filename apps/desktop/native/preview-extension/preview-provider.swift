// PwrSnap macOS Quick Look Preview Extension. Renders the full-
// screen Spacebar / Quick Look preview for `.pwrsnap` bundles —
// distinct from the Thumbnail Extension (which serves Finder
// icons, column-view previews, and Spotlight). Apple's Quick Look
// stack treats thumbnails (small, fast, icon-shaped) and previews
// (full-screen, high-fidelity, interactive-capable) as separate
// extension points:
//
//   • com.apple.quicklook.thumbnail — what PwrSnapThumbnailExtension
//     provides. Returns a small bitmap.
//   • com.apple.quicklook.preview   — what THIS extension provides.
//     Returns the actual file contents (or a rendered preview) for
//     Quick Look's full-screen / Spacebar surface.
//
// We could ship one .appex with both providers, but Apple's docs
// recommend separate bundles per extension point so registration
// failures isolate cleanly. Both extensions share zip-reader.swift
// — build-native.mjs lists the same source file in both targets'
// sources arrays. (See docs/solutions/2026-05-19-finder-thumbnail-
// extension.md for the canonical setup notes; everything that
// applies to the Thumbnail extension — MH_EXECUTE, App Sandbox,
// _NSExtensionMain entry point — applies here identically.)
//
// Preview content strategy:
//   1. composite.png — legacy bundles only; carries the
//      pre-baked rendered composite with overlays applied. Best
//      preview if available because it shows what the user
//      actually composed in PwrSnap.
//   2. source.png — always present. For modern bundles without
//      applied overlays, source equals composite, so this is the
//      canonical preview content. For bundles with applied
//      overlays, this loses the overlays — a future enhancement
//      could re-compose live, but the sandbox can't load sharp/
//      libvips, so it'd need to be the bundle writer's job to
//      carry a full-res composite for v2 bundles too.
//
// We do NOT fall back to composite_thumbnail.jpg here — the
// thumbnail JPEG is sized for Finder icons (≤ 1024px), Spacebar
// preview wants full resolution and the thumbnail would look soft
// blown up to 2K+ display dimensions.

import AppKit
import Foundation
import QuickLookUI
import UniformTypeIdentifiers

// MARK: - Preview-specific extraction (separate from the thumbnail
//        extension's chain so the preference order can differ).

/// Walk the bundle's preferred-preview chain.
public func extractPwrSnapPreview(
  bundleURL: URL
) throws -> (data: Data, contentType: UTType) {
  let reader = try PwrSnapBundleReader(url: bundleURL)
  if let composite = try reader.extractEntry(named: "composite.png") {
    return (composite, .png)
  }
  if let source = try reader.extractEntry(named: "source.png") {
    return (source, .png)
  }
  // Last-ditch fallback — if the bundle somehow has no source.png
  // (which would fail bundle-store's validation, so this is
  // theoretical) but does have a thumbnail, render that rather
  // than failing the preview entirely.
  if let thumbnail = try reader.extractEntry(named: "composite_thumbnail.jpg") {
    return (thumbnail, .jpeg)
  }
  throw ThumbnailError.noCompositeEntry
}

// MARK: - Preview provider

/// Principal class for the Quick Look preview extension point.
/// macOS instantiates this via `_NSExtensionMain` reading
/// `NSExtension.NSExtensionPrincipalClass` from Info.plist.
///
/// **API shape note**: `QLPreviewingController` declares the
/// preview method in Objective-C as
/// `-providePreviewForFileRequest:completionHandler:` (per
/// QuickLookUI.framework/Headers/QLPreviewingController.h). Swift
/// surfaces it as `providePreview(for:completionHandler:)`. There
/// is no canonical `async throws -> QLPreviewReply` overload — the
/// Obj-C runtime can't find a Swift-only `async` method via the
/// extension XPC dispatch, so the preview surface stays blank and
/// Finder falls back to the brand icon (the bug we hit before this
/// rewrite). Always use the callback form, mirroring how the
/// Thumbnail Extension uses `provideThumbnail(for:_:)`.
@objc(PreviewProvider)
final class PreviewProvider: QLPreviewProvider, QLPreviewingController {

  /// Extract the best available image entry, hand it back as raw
  /// PNG/JPEG bytes via `QLPreviewReply(dataOfContentType:...)`.
  /// macOS renders the bytes in its own surface — we don't need to
  /// draw into a context, set up an NSGraphicsContext, or worry
  /// about Retina point/pixel mismatches (the headache from the
  /// thumbnail extension's first iteration). Image dimensions are
  /// read from the data itself via NSImage; we pass them as
  /// contentSize so Quick Look can size its window appropriately
  /// before the bitmap finishes decoding.
  func providePreview(
    for request: QLFilePreviewRequest,
    completionHandler handler: @escaping (QLPreviewReply?, Error?) -> Void
  ) {
    do {
      let (data, contentType) = try extractPwrSnapPreview(bundleURL: request.fileURL)

      // Read image dimensions to feed contentSize. NSImage decodes
      // headers cheaply; for a malformed image we fall back to a
      // reasonable default rather than failing the whole preview.
      let contentSize: CGSize
      if let image = NSImage(data: data), image.size.width > 0 {
        contentSize = image.size
      } else {
        // Default to a 4:3 frame at a sensible mid-size. Quick Look
        // will rescale around this once the bitmap loads.
        contentSize = CGSize(width: 1280, height: 960)
      }

      // Swift bridges the Obj-C two-arg block
      // `(QLPreviewReply *reply, NSError ** error)` to a single-
      // argument closure (the inout NSError pointer is dropped on
      // the Swift side; we surface errors by throwing instead).
      let reply = QLPreviewReply(
        dataOfContentType: contentType,
        contentSize: contentSize
      ) { _ in
        return data
      }
      handler(reply, nil)
    } catch {
      handler(nil, error)
    }
  }
}
