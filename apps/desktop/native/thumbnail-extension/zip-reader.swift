// PwrSnap macOS Thumbnail Extension. Renders Finder + QuickLook
// thumbnails for `.pwrsnap` bundles without ever launching the app
// or running compose() — the bundle already carries a pre-baked
// `composite_thumbnail.jpg` (≤ 1024px long edge, JPEG quality 90)
// generated at pack time by `buildCompositeThumbnail` in
// apps/desktop/src/main/persistence/bundle-store.ts.
//
// Fallback chain (most → least preferred):
//   1. composite_thumbnail.jpg — present in all modern bundles
//      (post-PR-#111 the packer writes one for every capture; the
//      previous "skip for small sources" optimization left v2 bundles
//      with no Finder thumbnail at all).
//   2. composite.png — legacy bundles (pre-PR-#90; full-res baked
//      composite. Larger but still decodes the same way.)
//   3. source.png — v1-only flat name, last-resort fallback for
//      bundles that somehow lack both above. v2 bundles store
//      source bytes at `sources/<sha256>.png` (invisible to this
//      static chain — but post-PR-#111 every v2 capture has a
//      composite_thumbnail.jpg anyway).
//
// The extension runs in a sandboxed XPC subprocess managed by
// macOS's QuickLookThumbnailing framework — read-only access to the
// `.pwrsnap` file via the URL macOS hands us (granted by the
// `com.apple.security.files.user-selected.read-only` entitlement),
// no subprocess spawning (the sandbox blocks it), no network. All
// in-process Foundation + AppKit.
//
// Builds as a Mach-O executable (MH_EXECUTE) with `_NSExtensionMain`
// (Foundation) as the linker entry point — set via
// `-Xlinker -e -Xlinker _NSExtensionMain` in scripts/build-native.mjs.
// NSExtensionMain reads `NSExtension.NSExtensionPrincipalClass` from
// Info.plist, sets up the XPC connection with the host, and
// instantiates `@objc(ThumbnailProvider)`. Critically NOT MH_BUNDLE
// — `pluginkit` and `codesign --entitlements` both silently no-op on
// MH_BUNDLE binaries, which is the single most painful failure mode
// for new App Extensions (see docs/solutions/2026-05-19-finder-
// thumbnail-extension.md).

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
  ///
  /// Every offset / size pulled out of the file is bounds-checked
  /// against `fileData.count` BEFORE any read. A truncated
  /// `.pwrsnap` or maliciously crafted ZIP (bogus central-directory
  /// offset, oversized lengths, integer overflow on
  /// `localHeaderOffset + 30 + lfhFilenameLength + lfhExtraFieldLength`)
  /// produces a `malformedZip` throw rather than crashing the
  /// sandboxed extension worker.
  func extractEntry(named name: String) throws -> Data? {
    let eocd = try findEndOfCentralDirectory()

    guard let centralDirOffset = readUInt32IfInBounds(at: eocd + 16).map(Int.init),
          let entryCount = readUInt16IfInBounds(at: eocd + 10).map(Int.init)
    else {
      throw ThumbnailError.malformedZip("EOCD record truncated at offset \(eocd)")
    }

    var cursor = centralDirOffset
    for _ in 0..<entryCount {
      // Central directory entry header is 46 bytes before the
      // variable-length name/extra/comment trailers. Reject early
      // if there isn't even room for the fixed header.
      guard cursor >= 0, cursor + 46 <= fileData.count else {
        throw ThumbnailError.malformedZip(
          "central-directory cursor \(cursor) out of bounds (bundle is \(fileData.count) bytes)"
        )
      }

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

      // Filename is the only variable-length field we have to read
      // *before* deciding whether this is our entry. Bounds-check
      // its range first.
      let filenameStart = cursor + 46
      guard filenameStart + filenameLength <= fileData.count else {
        throw ThumbnailError.malformedZip(
          "central-directory filename range out of bounds at entry offset \(cursor)"
        )
      }
      let filename = readString(at: filenameStart, length: filenameLength)

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
        // {filename, extra} field lengths are NOT guaranteed to
        // match the local header's (per the ZIP spec) — we re-read
        // from the local header. Local-header offset is
        // attacker-controllable, so bounds-check it explicitly
        // before any read.
        guard localHeaderOffset >= 0,
              localHeaderOffset + 30 <= fileData.count
        else {
          throw ThumbnailError.malformedZip(
            "local-header offset \(localHeaderOffset) out of bounds for \(name)"
          )
        }

        // Local File Header signature: 0x04034b50.
        guard readUInt32(at: localHeaderOffset) == 0x04034b50 else {
          throw ThumbnailError.malformedZip(
            "local file header signature mismatch at offset \(localHeaderOffset)"
          )
        }
        let lfhFilenameLength = Int(readUInt16(at: localHeaderOffset + 26))
        let lfhExtraFieldLength = Int(readUInt16(at: localHeaderOffset + 28))
        // The arithmetic `30 + filename + extra + compressedSize`
        // could overflow / underflow if any field is negative-ish
        // when bridged from a corrupt UInt32. Compute via Int and
        // check both ends.
        let (dataStart, addOverflow) = localHeaderOffset.addingReportingOverflow(
          30 + lfhFilenameLength + lfhExtraFieldLength
        )
        let (dataEnd, lenOverflow) = dataStart.addingReportingOverflow(compressedSize)
        guard !addOverflow, !lenOverflow,
              dataStart >= 0, dataStart <= fileData.count,
              dataEnd >= dataStart, dataEnd <= fileData.count
        else {
          throw ThumbnailError.malformedZip(
            "entry \(name) data range \(dataStart)..\(dataEnd) exceeds bundle size \(fileData.count)"
          )
        }
        return fileData.subdata(in: dataStart..<dataEnd)
      }

      // Advance cursor over name + extra + comment. Same overflow
      // hardening as above.
      let (next, advanceOverflow) = cursor.addingReportingOverflow(
        46 + filenameLength + extraFieldLength + commentLength
      )
      guard !advanceOverflow else {
        throw ThumbnailError.malformedZip(
          "central-directory cursor advance overflow at entry offset \(cursor)"
        )
      }
      cursor = next
    }
    return nil
  }

  // MARK: - Byte helpers

  /// Walk backwards from end-of-file looking for the End-of-Central-
  /// Directory signature (0x06054b50). ZIP comments can be up to
  /// 65535 bytes long, so the EOCD lives within the last 65535 + 22
  /// bytes.
  ///
  /// We return the FIRST signature found scanning backwards, which is
  /// the LAST in forward order — the structurally correct EOCD,
  /// assuming PwrSnap-written bundles don't embed ZIP comments that
  /// happen to contain `\x50\x4b\x05\x06`. yazl (our writer) doesn't
  /// emit comments, so this is safe for our own files. A bundle from
  /// elsewhere could theoretically false-positive on a comment byte;
  /// a future hardening pass could verify the candidate by checking
  /// that `centralDirOffset + 46 <= fileData.count` and that the byte
  /// at that offset is the central-directory signature. Not done
  /// today because we treat non-PwrSnap ZIPs as out-of-scope input.
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
      // Use the bounds-checked variant rather than the raw read — at
      // scanStart we're at the buffer's lower edge and the raw read
      // would trap on offset < 0 in degenerate inputs.
      if readUInt32IfInBounds(at: offset) == signature {
        return offset
      }
      offset -= 1
    }
    throw ThumbnailError.malformedZip(
      "end-of-central-directory signature not found in last \(maxScan) bytes"
    )
  }

  /// Unchecked 4-byte LE read. Caller MUST have already verified
  /// `offset + 4 <= fileData.count`; on out-of-bounds this traps.
  /// Use only after a bounds-check, or use `readUInt32IfInBounds`.
  private func readUInt32(at offset: Int) -> UInt32 {
    let bytes = fileData.subdata(in: offset..<(offset + 4))
    return UInt32(bytes[0])
      | (UInt32(bytes[1]) << 8)
      | (UInt32(bytes[2]) << 16)
      | (UInt32(bytes[3]) << 24)
  }

  /// Unchecked 2-byte LE read. Same caveat as `readUInt32`.
  private func readUInt16(at offset: Int) -> UInt16 {
    let bytes = fileData.subdata(in: offset..<(offset + 2))
    return UInt16(bytes[0]) | (UInt16(bytes[1]) << 8)
  }

  /// Unchecked UTF-8 string read. Caller MUST bounds-check
  /// `offset + length <= fileData.count` first. Returns the empty
  /// string for non-UTF-8 input (PwrSnap-written entry names are all
  /// ASCII so this only fires on malformed bundles, in which case
  /// the filename-match below will fail and we'll skip the entry).
  private func readString(at offset: Int, length: Int) -> String {
    let bytes = fileData.subdata(in: offset..<(offset + length))
    return String(data: bytes, encoding: .utf8) ?? ""
  }

  /// Safe wrapper around `readUInt32` — returns `nil` if the read
  /// would run off the end of the buffer. Use for offsets that come
  /// from outside the file (e.g., the initial EOCD field reads).
  private func readUInt32IfInBounds(at offset: Int) -> UInt32? {
    guard offset >= 0, offset + 4 <= fileData.count else { return nil }
    return readUInt32(at: offset)
  }

  /// Safe wrapper around `readUInt16` — same idea as
  /// `readUInt32IfInBounds`.
  private func readUInt16IfInBounds(at offset: Int) -> UInt16? {
    guard offset >= 0, offset + 2 <= fileData.count else { return nil }
    return readUInt16(at: offset)
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

      // Aspect-fit the image into `request.maximumSize` (in POINTS)
      // and use the FIT SIZE as the context size — not the full
      // maximumSize rectangle. This matches how Finder renders
      // .png/.jpg thumbnails: the thumbnail "card" Finder lays out
      // takes the image's native aspect, with no letterboxing
      // whitespace inside the card. Sizing contextSize to maximumSize
      // (a previous attempt) produced visible letterbox bands on
      // every non-square capture, which doesn't match the system look.
      //
      // The `currentContextDrawing` initializer is critical here:
      // macOS sets up `NSGraphicsContext.current` with the right
      // backing-store scale transform applied, so drawing in points
      // just works on any display. The sibling raw-CGContext
      // overload (`init(contextSize:, drawing: (CGContext) -> Bool)`)
      // is a footgun — its coordinate transform isn't documented
      // consistently across releases and on Retina it leaves the
      // image rendered into the bottom-left quadrant. Using the
      // named-argument form forces Swift to pick the right overload
      // (a trailing closure `{ ctx in ... }` with one parameter
      // matches the raw-CGContext form instead).
      //
      // See docs/solutions/2026-05-19-finder-thumbnail-extension.md
      // for the failure-mode history.
      let nativeSize = image.size
      let maxSize = request.maximumSize
      let fit = min(
        maxSize.width / max(nativeSize.width, 1),
        maxSize.height / max(nativeSize.height, 1)
      )
      let drawSize = CGSize(
        width: max(1, nativeSize.width * fit),
        height: max(1, nativeSize.height * fit)
      )

      let reply = QLThumbnailReply(
        contextSize: drawSize,
        currentContextDrawing: {
          // Fill the entire context. No letterboxing — the card
          // itself is image-shaped.
          image.draw(in: CGRect(origin: .zero, size: drawSize))
          return true
        }
      )
      handler(reply, nil)
    } catch {
      handler(nil, error)
    }
  }
}
