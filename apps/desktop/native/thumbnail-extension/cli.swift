// Standalone CLI harness for the same ZIP-reading + entry-extraction
// logic the Quick Look Thumbnail Extension uses at runtime. Drives
// `extractPwrSnapThumbnailData` directly so we can:
//
//   1. Verify the Swift ZIP reader against real `.pwrsnap` bundles
//      without needing Finder integration / lsregister gymnastics.
//   2. Diagnose "Finder thumbnail isn't rendering for this bundle"
//      by running the same code path under stdout/stderr observation.
//   3. Bake the extension into broader test infrastructure later
//      (e.g., a Playwright spec that captures a screenshot, packs a
//      bundle, then invokes this CLI and asserts the output decodes
//      as a sane JPEG/PNG).
//
// Usage:
//   pwrsnap-thumbnail-cli <bundle.pwrsnap> [-o <out.jpg|.png>]
//
// With `-o`: writes the raw extracted entry bytes to the given path.
// Without: writes them to stdout.
//
// Exit codes:
//   0 — extracted successfully
//   1 — bundle unreadable / not a ZIP
//   2 — no eligible entry (composite_thumbnail.jpg, composite.png,
//       source.png) found in the bundle
//   3 — argument / IO error
//
// Built by scripts/build-native.mjs alongside the .appex; the
// ZIP-reading logic lives in zip-reader.swift and is shared between
// the two via the Swift module-internal scope. (The CLI binary is
// compiled as MH_EXECUTE with the standard `_main` entry; the
// extension binary is compiled MH_EXECUTE with `_NSExtensionMain` —
// same Mach-O type, different entry points, same Swift code.)

import Foundation

@main
struct PwrSnapThumbnailCli {
  static func main() {
    exit(runCli(args: Array(CommandLine.arguments.dropFirst())))
  }
}

private func writeStderr(_ message: String) {
  FileHandle.standardError.write(Data((message + "\n").utf8))
}

private func runCli(args: [String]) -> Int32 {
  guard args.count >= 1 else {
    writeStderr("usage: pwrsnap-thumbnail-cli <bundle.pwrsnap> [-o <out.{jpg,png}>]")
    return 3
  }

  var bundlePath: String?
  var outputPath: String?
  var i = 0
  while i < args.count {
    let arg = args[i]
    if arg == "-o" || arg == "--output" {
      guard i + 1 < args.count else {
        writeStderr("error: -o requires a path argument")
        return 3
      }
      outputPath = args[i + 1]
      i += 2
    } else if bundlePath == nil {
      bundlePath = arg
      i += 1
    } else {
      writeStderr("error: unexpected argument \(arg)")
      return 3
    }
  }

  guard let path = bundlePath else {
    writeStderr("error: missing bundle path argument")
    return 3
  }

  let url = URL(fileURLWithPath: path)
  let data: Data
  do {
    data = try extractPwrSnapThumbnailData(bundleURL: url)
  } catch let error as ThumbnailError {
    writeStderr("error: \(error.errorDescription ?? "unknown")")
    switch error {
    case .bundleUnreadable, .malformedZip:
      return 1
    case .noCompositeEntry, .imageDecodeFailed:
      return 2
    }
  } catch {
    writeStderr("error: \(error.localizedDescription)")
    return 1
  }

  if let outPath = outputPath {
    do {
      try data.write(to: URL(fileURLWithPath: outPath))
    } catch {
      writeStderr("error: writing output: \(error.localizedDescription)")
      return 3
    }
    writeStderr("wrote \(data.count) bytes to \(outPath)")
  } else {
    FileHandle.standardOutput.write(data)
  }
  return 0
}

// (PwrSnapThumbnailCli.main above is the @main entry; runCli is
// invoked from there. Top-level expressions can't appear at file
// scope here because we compile with -parse-as-library — there's no
// implicit `main.swift`.)
