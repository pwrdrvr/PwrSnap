import AppKit
import Foundation

enum PasteboardWriterError: Error, CustomStringConvertible {
  case usage
  case unreadablePng(String)
  case missingFileUrlPath(String)
  case invalidFileUrl(String)
  case pasteboardWriteFailed

  var description: String {
    switch self {
    case .usage:
      return "usage: pasteboard-writer --png <path> --file-url <path>"
    case .unreadablePng(let path):
      return "could not read PNG data at \(path)"
    case .missingFileUrlPath(let path):
      return "file URL target does not exist at \(path)"
    case .invalidFileUrl(let path):
      return "could not create file URL for \(path)"
    case .pasteboardWriteFailed:
      return "NSPasteboard rejected the item"
    }
  }
}

func parseArgs(_ args: [String]) throws -> (pngPath: String, fileUrlPath: String) {
  var pngPath: String?
  var fileUrlPath: String?
  var index = 1

  while index < args.count {
    let arg = args[index]
    switch arg {
    case "--png":
      index += 1
      guard index < args.count else { throw PasteboardWriterError.usage }
      pngPath = args[index]
    case "--file-url":
      index += 1
      guard index < args.count else { throw PasteboardWriterError.usage }
      fileUrlPath = args[index]
    default:
      throw PasteboardWriterError.usage
    }
    index += 1
  }

  guard let pngPath, let fileUrlPath else { throw PasteboardWriterError.usage }
  return (pngPath, fileUrlPath)
}

func run() throws {
  let parsed = try parseArgs(CommandLine.arguments)
  let pngUrl = URL(fileURLWithPath: parsed.pngPath)
  guard let pngData = try? Data(contentsOf: pngUrl) else {
    throw PasteboardWriterError.unreadablePng(parsed.pngPath)
  }

  guard FileManager.default.fileExists(atPath: parsed.fileUrlPath) else {
    throw PasteboardWriterError.missingFileUrlPath(parsed.fileUrlPath)
  }
  let fileUrl = NSURL(fileURLWithPath: parsed.fileUrlPath)
  guard fileUrl.isFileURL, let fileUrlString = fileUrl.absoluteString else {
    throw PasteboardWriterError.invalidFileUrl(parsed.fileUrlPath)
  }

  // Write `public.png` + `public.file-url` ONLY — never an eager
  // `public.tiff`. `NSImage.tiffRepresentation` produces an UNCOMPRESSED
  // buffer (~w·h·4 bytes; a 91 KB PNG measured 960 KB of TIFF), and remote
  // pasteboard consumers (Universal Clipboard, Splashtop) transfer whatever
  // is eagerly declared — so an eager TIFF turns a 250 KB copy into a
  // multi-megabyte paste on the far end. macOS lazily synthesizes
  // `public.tiff` from `public.png` via pasteboard type translation for any
  // local consumer that requests it (Preview, Mail, older AppKit text
  // views), so nothing is lost by omitting it. This mirrors the
  // `--write-clipboard` layer-fragment path in ../window-list/main.swift.
  //
  // History: PR #297 made the no-eager-TIFF decision; PR #309 reintroduced
  // an eager `tiffRepresentation` write in this helper (the regression);
  // PR #324 removed it. Do not add TIFF back. A lazy
  // NSPasteboardItemDataProvider is NOT an option here either — this
  // helper is a one-shot CLI that exits after writing, so there is no
  // process left alive to serve the provider callback.
  let imageItem = NSPasteboardItem()
  imageItem.setData(pngData, forType: NSPasteboard.PasteboardType.png)
  imageItem.setData(
    fileUrlString.data(using: .utf8)!,
    forType: NSPasteboard.PasteboardType.fileURL
  )

  let pasteboard = NSPasteboard.general
  pasteboard.clearContents()
  guard pasteboard.writeObjects([imageItem]) else {
    throw PasteboardWriterError.pasteboardWriteFailed
  }
  _ = pasteboard.types
  _ = pasteboard.pasteboardItems?.flatMap { item in item.types }
}

do {
  try run()
} catch {
  fputs("\(error)\n", stderr)
  exit(1)
}
