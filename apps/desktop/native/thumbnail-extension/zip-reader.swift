// PwrSnap macOS Thumbnail Extension. Renders Finder + QuickLook
// thumbnails for `.pwrsnap` bundles without ever launching the app
// or running compose() — the bundle already carries a pre-baked
// `composite_thumbnail.jpg` (≤ 1024px long edge, JPEG quality 80)
// generated at pack time by `buildCompositeThumbnail` in
// apps/desktop/src/main/persistence/bundle-store.ts.
//
// Fallback chain (most → least preferred):
//   1. composite_thumbnail.jpg — modern bundles (post bundle-storage-
//      refactor for captures > 1024px on either edge)
//   2. composite.png — legacy bundles (pre-refactor; full-res baked
//      composite. Larger but still decodes the same way.)
//   3. source.png — small-capture modern bundles that skipped the
//      thumbnail entirely (source ≤ 1024px so it IS thumbnail-sized).
//
// The extension runs in a sandboxed XPC subprocess managed by
// macOS's QuickLookThumbnailing framework — read-only access to the
// `.pwrsnap` file via the URL macOS hands us, no subprocess
// spawning (the sandbox blocks it), no network. All in-process
// Foundation + AppKit.
//
// Builds as a loadable bundle (`-Xlinker -bundle`), no main() — the
// host framework dlopen()s the binary and instantiates `ThumbnailProvider`
// by name (from Info.plist's `NSExtensionPrincipalClass`).

import AppKit
import Foundation
import QuickLookThumbnailing

// MARK: - Errors

enum ThumbnailError: LocalizedError {
  case bundleUnreadable(String)
  case noCompositeEntry
  case imageDecodeFailed
  case malformedZip(String)

  var errorDescription: String? {
    switch self {
    case .bundleUnreadable(let m): return "PwrSnap bundle unreadable: \(m)"
    case .noCompositeEntry: return "PwrSnap bundle contains no composite or source entry"
    case .imageDecodeFailed: return "PwrSnap thumbnail image data failed to decode"
    case .malformedZip(let m): return "PwrSnap bundle is malformed: \(m)"
    }
  }
}

// MARK: - ZIP reader

/// Minimal ZIP central-directory reader for STORE-mode entries.
///
/// We intentionally support only STORE-mode (no DEFLATE) because
/// PwrSnap bundles configure yazl with `compress: false` for every
/// image entry — PNG and JPEG are already DEFLATE-compressed
/// internally, so a second compression pass costs CPU for negligible
/// size win. STORE entries can be read verbatim from the local-file-
/// header data offset.
///
/// No ZIP64 support: that would require 64-bit central-directory
/// location. PwrSnap bundles are bounded well under 4 GB (≤ 32768×
/// 32768 source PNG plus a ≤ 1024px JPEG thumbnail + tiny JSON), so
/// 32-bit fields suffice forever.
struct PwrSnapBundleReader {
  private let fileData: Data

  init(url: URL) throws {
    do {
      // mappedIfSafe: for small files (< 2 MB roughly) Foundation
      // reads them eagerly; for larger files it mmaps. Thumbnail
      // extraction touches a tiny fraction of the bundle (just the
      // central directory + one entry), so mmap wins for large
      // captures.
      fileData = try Data(contentsOf: url, options: .mappedIfSafe)
    } catch {
      throw ThumbnailError.bundleUnreadable(error.localizedDescription)
    }
  }

  /// Returns the raw bytes of the named entry, or nil if no entry
  /// matches. Throws only on structurally malformed bundles.
  func extractEntry(named name: String) throws -> Data? {
    let eocd = try findEndOfCentralDirectory()

    let centralDirOffset = Int(readUInt32(at: eocd + 16))
    let entryCount = Int(readUInt16(at: eocd + 10))

    var cursor = centralDirOffset
    for _ in 0..<entryCount {
      // Central Directory File Header signature: 0x02014b50 (LE).
      guard readUInt32(at: cursor) == 0x02014b50 else {
        throw ThumbnailError.malformedZip(
          "central-directory entry signature mismatch at offset \(cursor)"
        )
      }

      let compressionMethod = readUInt16(at: cursor + 10)
      let compressedSize = Int(readUInt32(at: cursor + 20))
      let filenameLength = Int(readUInt16(at: cursor + 28))
      let extraFieldLength = Int(readUInt16(at: cursor + 30))
      let commentLength = Int(readUInt16(at: cursor + 32))
      let localHeaderOffset = Int(readUInt32(at: cursor + 42))
      let filename = readString(at: cursor + 46, length: filenameLength)

      if filename == name {
        // Refuse to extract DEFLATE / LZMA / anything other than
        // STORE — our writer never uses those for image entries, and
        // supporting them would mean linking against Compression /
        // zlib and dealing with sandbox restrictions.
        guard compressionMethod == 0 else {
          throw ThumbnailError.malformedZip(
            "entry \(name) uses unsupported compression method \(compressionMethod)"
          )
        }

        // Walk into the local file header at localHeaderOffset to
        // find the actual file data. The central directory's
        // {filename, extra} field lengths are NOT guaranteed to match
        // the local header's (per the ZIP spec) — we re-read from
        // the local header.
        // Local File Header signature: 0x04034b50.
        guard readUInt32(at: localHeaderOffset) == 0x04034b50 else {
          throw ThumbnailError.malformedZip(
            "local file header signature mismatch at offset \(localHeaderOffset)"
          )
        }
        let lfhFilenameLength = Int(readUInt16(at: localHeaderOffset + 26))
        let lfhExtraFieldLength = Int(readUInt16(at: localHeaderOffset + 28))
        let dataStart = localHeaderOffset + 30 + lfhFilenameLength + lfhExtraFieldLength
        let dataEnd = dataStart + compressedSize
        guard dataEnd <= fileData.count else {
          throw ThumbnailError.malformedZip(
            "entry \(name) data range \(dataStart)..\(dataEnd) exceeds bundle size \(fileData.count)"
          )
        }
        return fileData.subdata(in: dataStart..<dataEnd)
      }

      cursor += 46 + filenameLength + extraFieldLength + commentLength
    }
    return nil
  }

  // MARK: - Byte helpers

  /// Walk backwards from end-of-file looking for the End-of-Central-
  /// Directory signature (0x06054b50). ZIP comments can be up to
  /// 65535 bytes long, so the EOCD lives within the last 65535 + 22
  /// bytes. We scan byte-by-byte because the comment itself can
  /// contain the signature pattern — the LAST occurrence in the
  /// scan window is the true EOCD (comments come BEFORE the EOCD
  /// in file order, but their bytes come AFTER the EOCD's record
  /// since the comment length is part of the EOCD).
  ///
  /// Returns the EOCD offset.
  private func findEndOfCentralDirectory() throws -> Int {
    let signature: UInt32 = 0x06054b50
    let minimumEocdSize = 22
    guard fileData.count >= minimumEocdSize else {
      throw ThumbnailError.malformedZip("file too small to be a valid ZIP")
    }
    let maxScan = min(fileData.count, 65535 + minimumEocdSize)
    let scanStart = fileData.count - maxScan
    var offset = fileData.count - minimumEocdSize
    while offset >= scanStart {
      if readUInt32(at: offset) == signature {
        return offset
      }
      offset -= 1
    }
    throw ThumbnailError.malformedZip(
      "end-of-central-directory signature not found in last \(maxScan) bytes"
    )
  }

  private func readUInt32(at offset: Int) -> UInt32 {
    let bytes = fileData.subdata(in: offset..<(offset + 4))
    return UInt32(bytes[0])
      | (UInt32(bytes[1]) << 8)
      | (UInt32(bytes[2]) << 16)
      | (UInt32(bytes[3]) << 24)
  }

  private func readUInt16(at offset: Int) -> UInt16 {
    let bytes = fileData.subdata(in: offset..<(offset + 2))
    return UInt16(bytes[0]) | (UInt16(bytes[1]) << 8)
  }

  private func readString(at offset: Int, length: Int) -> String {
    let bytes = fileData.subdata(in: offset..<(offset + length))
    return String(data: bytes, encoding: .utf8) ?? ""
  }
}

/// Extract the best available composite/source for thumbnailing.
/// Walks the entry preference chain so the same code paths the
/// extension uses are testable via the CLI harness.
public func extractPwrSnapThumbnailData(bundleURL: URL) throws -> Data {
  let reader = try PwrSnapBundleReader(url: bundleURL)
  if let thumb = try reader.extractEntry(named: "composite_thumbnail.jpg") {
    return thumb
  }
  if let composite = try reader.extractEntry(named: "composite.png") {
    return composite
  }
  if let source = try reader.extractEntry(named: "source.png") {
    return source
  }
  throw ThumbnailError.noCompositeEntry
}

// MARK: - Thumbnail provider

/// Principal class for the Quick Look thumbnail extension point. The
/// host framework instantiates this by name (from Info.plist's
/// `NSExtensionPrincipalClass`) and dispatches each thumbnail
/// request to `provideThumbnail`. `@objc(ThumbnailProvider)` keeps
/// the Objective-C-visible name stable across Swift module renames.
@objc(ThumbnailProvider)
final class ThumbnailProvider: QLThumbnailProvider {
  override func provideThumbnail(
    for request: QLFileThumbnailRequest,
    _ handler: @escaping (QLThumbnailReply?, Error?) -> Void
  ) {
    do {
      let data = try extractPwrSnapThumbnailData(bundleURL: request.fileURL)

      guard let image = NSImage(data: data) else {
        handler(nil, ThumbnailError.imageDecodeFailed)
        return
      }

      // Aspect-fit the source image into the requested max size.
      // request.maximumSize is in POINTS; QuickLook handles the
      // scale-factor → physical pixels conversion under the hood for
      // Retina displays.
      let nativeSize = image.size
      let targetMax = request.maximumSize
      let scale = min(
        targetMax.width / max(nativeSize.width, 1),
        targetMax.height / max(nativeSize.height, 1)
      )
      let drawSize = CGSize(
        width: max(1, nativeSize.width * scale),
        height: max(1, nativeSize.height * scale)
      )

      let reply = QLThumbnailReply(contextSize: drawSize) { context in
        let nsContext = NSGraphicsContext(cgContext: context, flipped: false)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = nsContext
        image.draw(in: CGRect(origin: .zero, size: drawSize))
        NSGraphicsContext.restoreGraphicsState()
        return true
      }
      handler(reply, nil)
    } catch {
      handler(nil, error)
    }
  }
}
