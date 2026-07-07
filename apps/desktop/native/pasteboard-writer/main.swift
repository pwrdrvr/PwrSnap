import AppKit
import Foundation

enum PasteboardWriterError: Error, CustomStringConvertible {
  case usage
  case unreadablePng(String)
  case missingFileUrlPath(String)
  case invalidFileUrl(String)
  case cannotCreateImage
  case cannotCreateTiff
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
    case .cannotCreateImage:
      return "could not decode PNG data as an image"
    case .cannotCreateTiff:
      return "could not create TIFF representation"
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
  guard let image = NSImage(data: pngData) else {
    throw PasteboardWriterError.cannotCreateImage
  }
  guard let tiffData = image.tiffRepresentation else {
    throw PasteboardWriterError.cannotCreateTiff
  }

  guard FileManager.default.fileExists(atPath: parsed.fileUrlPath) else {
    throw PasteboardWriterError.missingFileUrlPath(parsed.fileUrlPath)
  }
  let fileUrl = NSURL(fileURLWithPath: parsed.fileUrlPath)
  guard fileUrl.isFileURL, let fileUrlString = fileUrl.absoluteString else {
    throw PasteboardWriterError.invalidFileUrl(parsed.fileUrlPath)
  }

  let imageItem = NSPasteboardItem()
  imageItem.setData(pngData, forType: NSPasteboard.PasteboardType.png)
  imageItem.setData(tiffData, forType: NSPasteboard.PasteboardType.tiff)
  let urlItem = NSPasteboardItem()
  urlItem.setData(
    fileUrlString.data(using: .utf8)!,
    forType: NSPasteboard.PasteboardType.fileURL
  )

  let pasteboard = NSPasteboard.general
  pasteboard.clearContents()
  guard pasteboard.writeObjects([imageItem, urlItem]) else {
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
