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
      return "usage: pasteboard-writer --png <path> --file-url <path> [--png <path> --file-url <path> ...] [--meta <json>]\n"
        + "       pasteboard-writer --list-types"
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

struct PasteboardWriteItem {
  let pngPath: String
  let fileUrlPath: String
}

/// `--png A --file-url A [--png B --file-url B ...] [--meta <json>]`.
/// Each `--png` opens an item and the `--file-url` after it closes that item,
/// so one invocation can write several images (the cart's Copy all) as
/// separate pasteboard items, the shape a Finder multi-file copy has.
func parseArgs(_ args: [String]) throws -> (items: [PasteboardWriteItem], metaJson: String?)
{
  var items: [PasteboardWriteItem] = []
  var pendingPng: String?
  var metaJson: String?
  var index = 1

  while index < args.count {
    let arg = args[index]
    switch arg {
    case "--png":
      index += 1
      guard index < args.count, pendingPng == nil else { throw PasteboardWriterError.usage }
      pendingPng = args[index]
    case "--file-url":
      index += 1
      guard index < args.count, let png = pendingPng else { throw PasteboardWriterError.usage }
      items.append(PasteboardWriteItem(pngPath: png, fileUrlPath: args[index]))
      pendingPng = nil
    case "--meta":
      index += 1
      guard index < args.count else { throw PasteboardWriterError.usage }
      metaJson = args[index]
    default:
      throw PasteboardWriterError.usage
    }
    index += 1
  }

  guard pendingPng == nil, !items.isEmpty else { throw PasteboardWriterError.usage }
  return (items, metaJson)
}

func makeItem(_ item: PasteboardWriteItem, metaJson: String?) throws -> NSPasteboardItem {
  let pngUrl = URL(fileURLWithPath: item.pngPath)
  guard let pngData = try? Data(contentsOf: pngUrl) else {
    throw PasteboardWriterError.unreadablePng(item.pngPath)
  }

  guard FileManager.default.fileExists(atPath: item.fileUrlPath) else {
    throw PasteboardWriterError.missingFileUrlPath(item.fileUrlPath)
  }
  let fileUrl = NSURL(fileURLWithPath: item.fileUrlPath)
  guard fileUrl.isFileURL, let fileUrlString = fileUrl.absoluteString else {
    throw PasteboardWriterError.invalidFileUrl(item.fileUrlPath)
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
  // Optional diagnostics marker: a tiny JSON payload under a private
  // PwrSnap UTI. NSPasteboard doesn't record which app wrote it, so
  // tools like PbScope badge events carrying a `com.pwrdrvr.*` flavor
  // as PwrSnap-originated and correlate a specific copy (captureId +
  // seq) with what a remote Mac receives. A few hundred bytes, eager
  // by design — unlike TIFF (see above) it costs nothing.
  if let metaJson, let metaData = metaJson.data(using: .utf8), !metaData.isEmpty {
    imageItem.setData(
      metaData,
      forType: NSPasteboard.PasteboardType("com.pwrdrvr.pwrsnap.clip-meta")
    )
  }
  return imageItem
}

func run() throws {
  let parsed = try parseArgs(CommandLine.arguments)
  // Build every item before touching the pasteboard: an unreadable file
  // must fail the copy without clearing what the user had copied before.
  let items = try parsed.items.map { try makeItem($0, metaJson: parsed.metaJson) }

  let pasteboard = NSPasteboard.general
  pasteboard.clearContents()
  guard pasteboard.writeObjects(items) else {
    throw PasteboardWriterError.pasteboardWriteFailed
  }
  guard pasteboard.pasteboardItems?.count == items.count else {
    throw PasteboardWriterError.pasteboardWriteFailed
  }
  _ = pasteboard.types
  _ = pasteboard.pasteboardItems?.flatMap { item in item.types }
}

// `--list-types` prints the general pasteboard's type names as a JSON array
// and reads nothing else: no `data(forType:)`, no `string(forType:)`, no
// `readObjects`, no `NSImage(pasteboard:)`. A flavor from another device
// (Universal Clipboard) or a remote-desktop client is promised data, and
// macOS fetches it only when an app asks for its bytes. Asking for `types`
// fetched nothing in any case measured, while Electron 44's
// `clipboard.read()` fetches `public.url` and `public.url-name` just to list
// types. The File → New → Paste from Clipboard hint uses this mode for that
// reason (clipboard/pasteboard-types.ts).
func listTypes() throws {
  let types = (NSPasteboard.general.types ?? []).map { $0.rawValue }
  FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: types))
}

do {
  if CommandLine.arguments.dropFirst().first == "--list-types" {
    guard CommandLine.arguments.count == 2 else { throw PasteboardWriterError.usage }
    try listTypes()
  } else {
    try run()
  }
} catch {
  fputs("\(error)\n", stderr)
  exit(1)
}
