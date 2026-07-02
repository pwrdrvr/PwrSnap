// PwrSnap window-list helper.
//
// Emits the live on-screen window list as JSON to stdout. Used by the
// main process for two things:
//
//   1. Snap-to-window in the region selector — when ⇧ is held during
//      drag, the selector snaps to the window under the cursor.
//   2. Source-app metadata at capture time — `captures.source_app_*`
//      is backfilled with the bundle id + localized name of whichever
//      app owns the window the user captured.
//
// Why a Swift CLI and not a Node native module:
//   - CGWindowListCopyWindowInfo is the only reliable way to get
//     accurate, current bounds for windows owned by other apps.
//   - Native modules drag in node-gyp + Electron rebuild dance per
//     Electron major version. This binary is ABI-stable forever.
//   - It's tiny: < 1MB compiled, no runtime cost at idle.
//
// Build: `swiftc -O -o build/native/window-list main.swift`
// (compiled by apps/desktop/scripts/build-native.mjs at install time;
// shipped under Contents/Resources/PwrSnapWindowList in the .app).
//
// Output (one JSON object per line is more streamable, but we emit a
// single JSON array since callers want an atomic snapshot):
//
//   [{ "windowId": 123, "pid": 456, "bundleId": "com.tinyspeck.slackmacgap",
//      "appName": "Slack", "title": "general — PwrDrvr",
//      "bounds": { "x": 100, "y": 100, "width": 800, "height": 600 },
//      "layer": 0, "alpha": 1.0 }, ...]
//
// Coordinates are in the global virtual coord space (top-left origin),
// matching `screen.getDisplay*()` in Electron — no remap needed.
//
// Filtering: we drop windows with layer != 0 (menu bar, dock, status
// items, screen savers all sit at non-zero layers) and windows with
// alpha == 0 (invisible). The caller can re-filter further if needed.

import AppKit
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

struct WindowBounds: Encodable {
    let x: Int
    let y: Int
    let width: Int
    let height: Int
}

struct WindowInfo: Encodable {
    let windowId: Int
    let pid: Int
    let bundleId: String?
    let appName: String?
    let title: String?
    let bounds: WindowBounds
    let layer: Int
    let alpha: Double
    /// True when this window is the frontmost on-screen of its app
    /// (best-effort — first hit per pid in z-order). The selector
    /// uses this to skip an app's auxiliary panels that sit at
    /// layer 0 alongside the user-visible main window.
    let isFrontmostInApp: Bool
}

/// Payload for the `--write-clipboard` subcommand, read as a single
/// JSON object from stdin (NOT argv — the PNG/UTI bodies are multi-MB
/// and would blow past ARG_MAX). All bodies are base64; the helper
/// decodes them and performs ONE NSPasteboard write that declares
/// every type up front so a private UTI and a flattened image land
/// in the same pasteboard generation. See the dispatch block below
/// for why Electron can't do this itself.
struct ClipboardWriteRequest: Decodable {
    /// The private UTI for the layer-fragment bytes (e.g.
    /// `com.pwrdrvr.pwrsnap.layer-fragment`).
    let utiName: String
    /// Base64 of the private-UTI body — the serialized layer fragment.
    let utiBase64: String
    /// Base64 PNG of the flattened composite. Optional so callers can
    /// write a UTI-only payload, but in practice always present.
    let pngBase64: String?
    /// Base64 TIFF of the same composite. Optional and normally omitted:
    /// once `public.png` is on the pasteboard macOS lazily synthesizes
    /// `public.tiff` from it for apps that request TIFF (older AppKit
    /// text views, Mail, some web apps), so we don't eagerly write a
    /// large uncompressed TIFF. Present only if a caller wants to supply
    /// its own (e.g. already-compressed) TIFF bytes.
    let tiffBase64: String?
}

/// Bundle ids whose windows must NEVER appear as snap targets — they
/// are system chrome (status bar items, accessibility prompts) or
/// helpers that the user can't sensibly capture.
let bundleBlocklist: Set<String> = [
    "com.apple.controlcenter",
    "com.apple.accessibility.universalAccessAuthWarn",
    "com.apple.WindowManager",
    "com.apple.dock",
    "com.apple.notificationcenterui",
    "com.apple.systemuiserver"
]

func collectWindows() -> [WindowInfo] {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        return []
    }

    // Build a (pid → bundleId) map once via NSWorkspace; cheaper than
    // a per-window NSRunningApplication lookup.
    var bundleByPid: [pid_t: String] = [:]
    for app in NSWorkspace.shared.runningApplications {
        if let bid = app.bundleIdentifier {
            bundleByPid[app.processIdentifier] = bid
        }
    }

    var out: [WindowInfo] = []
    out.reserveCapacity(raw.count)
    var seenFrontmostByPid: Set<pid_t> = []
    for win in raw {
        guard
            let layer = win[kCGWindowLayer as String] as? Int,
            layer == 0
        else { continue }

        let alpha = (win[kCGWindowAlpha as String] as? Double) ?? 1.0
        if alpha == 0 { continue }

        guard
            let windowId = win[kCGWindowNumber as String] as? Int,
            let ownerPid = win[kCGWindowOwnerPID as String] as? pid_t,
            let boundsDict = win[kCGWindowBounds as String] as? [String: CGFloat],
            let cgRect = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
        else { continue }

        // Drop sub-pixel dimensions — typical menu strips are 1×1
        // tracking shadows.
        if cgRect.width < 4 || cgRect.height < 4 { continue }

        let appName = win[kCGWindowOwnerName as String] as? String
        let title = win[kCGWindowName as String] as? String
        let bundleId = bundleByPid[ownerPid]

        // Drop blocklisted system bundles (control center pieces,
        // accessibility prompts, etc.) — they have layer 0 windows
        // but should never be capture targets.
        if let bid = bundleId, bundleBlocklist.contains(bid) { continue }

        // First entry per pid (in z-order) is the user-visible main
        // window of that app. Subsequent entries are panels /
        // toolbars / popovers that share the pid — usually not what
        // a user means by "snap to that app's window."
        let isFrontmost = !seenFrontmostByPid.contains(ownerPid)
        seenFrontmostByPid.insert(ownerPid)

        out.append(
            WindowInfo(
                windowId: windowId,
                pid: Int(ownerPid),
                bundleId: bundleId,
                appName: appName,
                title: title,
                bounds: WindowBounds(
                    x: Int(cgRect.origin.x),
                    y: Int(cgRect.origin.y),
                    width: Int(cgRect.width),
                    height: Int(cgRect.height)
                ),
                layer: layer,
                alpha: alpha,
                isFrontmostInApp: isFrontmost
            )
        )
    }
    return out
}

// Subcommand dispatch. Default (no args) → emit the window list.
// `--activate-pid <pid>` → bring the named running app to the
// foreground via NSRunningApplication.activate. Used by the region
// selector to restore the previously-frontmost app after the user
// cancels or commits, without doing app.hide() (which has the side
// effect of unhiding all our windows on the next show()).
//
// Activation is best-effort: if the pid is no longer running or
// activate() returns false, we exit 0 quietly. The caller's UX is
// "the user wanted their last app back" — failing loud doesn't help.

let args = CommandLine.arguments

if args.count >= 3 && args[1] == "--activate-pid" {
    if let pid = pid_t(args[2]),
       let runningApp = NSRunningApplication(processIdentifier: pid) {
        // The options-based variant is deprecated since macOS 14; the
        // modern activate() handles the "ignore other apps" case
        // automatically when the calling process is itself active or
        // a recent action implied user intent. For our use case
        // (caller just dismissed our selector — the user's intent
        // is unmistakable) the no-options variant works.
        runningApp.activate()
    }
    exit(0)
}

// `--write-clipboard` — perform a SINGLE multi-type NSPasteboard write.
//
// Reads one JSON `ClipboardWriteRequest` from stdin and writes the
// private layer-fragment UTI **and** a flattened `public.png` (plus an
// optional caller-supplied `public.tiff`) to the general pasteboard in
// ONE `declareTypes` pass. macOS lazily offers `public.tiff` from the
// PNG for consumers that request it, so we don't eagerly write one.
// Prints `{"ok":true}` to stdout on success.
//
// Why a native helper instead of Electron's `clipboard.*`:
//   - Every Electron `clipboard.write*` call wraps a
//     ScopedClipboardWriter that calls `[pasteboard clearContents]`
//     on construction, so a `writeImage` after a `writeBuffer`
//     wipes the buffer (and vice-versa). There's no Electron API to
//     atomically co-write a custom UTI + standard image —
//     `clipboard.write({...})` only accepts text/html/image/rtf/
//     bookmark. So PwrSnap previously had to choose ONE of "private
//     UTI (PwrSnap→PwrSnap fidelity)" or "PNG (paste into Slack /
//     Mail / Claude)". This helper writes both at once.
//   - `declareTypes(_:owner:)` clears the pasteboard and declares all
//     the types in a single change-count bump; the subsequent
//     `setData(_:forType:)` calls fill each declared type without
//     re-clearing. The private UTI and the image therefore coexist:
//     a non-PwrSnap consumer reads `public.png`/`public.tiff`, while
//     PwrSnap reads back the private UTI losslessly.
if args.count >= 2 && args[1] == "--write-clipboard" {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard let req = try? JSONDecoder().decode(ClipboardWriteRequest.self, from: input) else {
        FileHandle.standardError.write(
            "invalid --write-clipboard request JSON on stdin\n".data(using: .utf8) ?? Data()
        )
        exit(2)
    }
    guard let utiData = Data(base64Encoded: req.utiBase64), !utiData.isEmpty else {
        FileHandle.standardError.write(
            "utiBase64 missing or failed to decode\n".data(using: .utf8) ?? Data()
        )
        exit(3)
    }

    var pngData: Data?
    if let png = req.pngBase64 {
        guard let decoded = Data(base64Encoded: png), !decoded.isEmpty else {
            FileHandle.standardError.write(
                "pngBase64 failed to decode\n".data(using: .utf8) ?? Data()
            )
            exit(3)
        }
        pngData = decoded
    }

    // Only write `public.tiff` if the caller explicitly supplies it. We
    // do NOT derive a TIFF from the PNG: `NSImage.tiffRepresentation`
    // produces an UNCOMPRESSED buffer (~w·h·4 bytes — ~33 MB for a 4K
    // composite) that we'd write to the pasteboard on every copy, when
    // macOS already lazily synthesizes `public.tiff` from `public.png`
    // for any consumer that requests it. Decode failure here is a caller
    // error — exit 3 for parity with the PNG path (no silent drop).
    var tiffData: Data?
    if let tiff = req.tiffBase64 {
        guard let decoded = Data(base64Encoded: tiff), !decoded.isEmpty else {
            FileHandle.standardError.write(
                "tiffBase64 failed to decode\n".data(using: .utf8) ?? Data()
            )
            exit(3)
        }
        tiffData = decoded
    }

    let pasteboard = NSPasteboard.general
    let utiType = NSPasteboard.PasteboardType(req.utiName)
    var declared: [NSPasteboard.PasteboardType] = [utiType]
    if pngData != nil { declared.append(.png) }
    if tiffData != nil { declared.append(.tiff) }

    // ONE declareTypes — this clears the pasteboard and declares every
    // type in a single generation. setData below fills them without
    // re-clearing, so the private UTI and image coexist.
    pasteboard.declareTypes(declared, owner: nil)
    var wroteOk = pasteboard.setData(utiData, forType: utiType)
    if let png = pngData { wroteOk = pasteboard.setData(png, forType: .png) && wroteOk }
    if let tiff = tiffData { wroteOk = pasteboard.setData(tiff, forType: .tiff) && wroteOk }

    if !wroteOk {
        FileHandle.standardError.write(
            "NSPasteboard.setData reported failure for one or more types\n".data(using: .utf8) ?? Data()
        )
        exit(5)
    }
    FileHandle.standardOutput.write("{\"ok\":true}".data(using: .utf8) ?? Data())
    exit(0)
}

// `--capture-window <windowId> <output.png>` — write the actual
// content of the named CGWindow to the given path as a PNG.
//
// Why this instead of `screencapture -l <windowId>`:
//   - `screencapture -l` captures the SCREEN RECT occupied by the
//     window, including anything visually on top of it. Empirically
//     tested: if another app's window covers part of the snap
//     target, those occluding pixels land in the output. The flag
//     does NOT ask WindowServer for the window's actual backing
//     buffer — it just constrains the captured area to the window's
//     bounds.
//   - ScreenCaptureKit's SCContentFilter(desktopIndependentWindow:)
//     + SCScreenshotManager.captureImage asks WindowServer directly
//     for THAT window's pixels regardless of occlusion. The window
//     stays where it is in z-order (we don't raise it visually),
//     and the output contains exactly the content the owning app
//     rendered into its backing store.
//
// SCKit was introduced in macOS 12.3 but SCScreenshotManager
// (the async one-shot API we want here) needs 14.0+. Apple
// obsoleted CGWindowListCreateImage in macOS 15.0 — it doesn't
// even compile against modern SDKs. So macOS 14+ minimum.
//
// Returns exit codes: 0 on success, 2 on bad args, 3-5 on capture
// errors. The TS wrapper interprets non-zero as "fall back to rect
// capture" so older macOS still gets a usable image.
if args.count >= 4 && args[1] == "--capture-window" {
    guard let widNumeric = UInt32(args[2]) else {
        FileHandle.standardError.write("invalid windowId\n".data(using: .utf8) ?? Data())
        exit(2)
    }
    let outputPath = args[3]

    if #available(macOS 14.0, *) {
        // SCScreenshotManager is async; bridge to sync via a semaphore
        // so the CLI exit code reflects the result.
        let semaphore = DispatchSemaphore(value: 0)
        var capturedImage: CGImage?
        var captureError: String?

        Task {
            do {
                let content = try await SCShareableContent.current
                guard let scWindow = content.windows.first(where: {
                    $0.windowID == widNumeric
                }) else {
                    captureError = "window \(widNumeric) not found in SCShareableContent"
                    semaphore.signal()
                    return
                }

                let filter = SCContentFilter(desktopIndependentWindow: scWindow)
                let config = SCStreamConfiguration()
                // Match the window's intrinsic logical size. SCKit
                // defaults to native (Retina) which would double
                // our image dims relative to what the user expects
                // ("a 1024×800 window should land as a 1024×800
                // PNG, not 2048×1600").
                config.width = max(1, Int(scWindow.frame.width))
                config.height = max(1, Int(scWindow.frame.height))
                config.showsCursor = false

                let image = try await SCScreenshotManager.captureImage(
                    contentFilter: filter,
                    configuration: config
                )
                capturedImage = image
            } catch {
                captureError = error.localizedDescription
            }
            semaphore.signal()
        }

        // Wait up to 10s — SCKit usually returns in <100ms but can
        // be slower under load or if the WindowServer is busy.
        if semaphore.wait(timeout: .now() + .seconds(10)) == .timedOut {
            FileHandle.standardError.write("SCKit capture timed out\n".data(using: .utf8) ?? Data())
            exit(3)
        }
        guard let cgImage = capturedImage else {
            FileHandle.standardError.write(
                "SCKit capture failed: \(captureError ?? "nil image")\n".data(using: .utf8) ?? Data()
            )
            exit(3)
        }

        let url = URL(fileURLWithPath: outputPath)
        let pngType = UTType.png.identifier as CFString
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, pngType, 1, nil) else {
            FileHandle.standardError.write(
                "CGImageDestinationCreateWithURL failed\n".data(using: .utf8) ?? Data()
            )
            exit(4)
        }
        CGImageDestinationAddImage(dest, cgImage, nil)
        if !CGImageDestinationFinalize(dest) {
            FileHandle.standardError.write(
                "CGImageDestinationFinalize failed\n".data(using: .utf8) ?? Data()
            )
            exit(5)
        }
        exit(0)
    }

    FileHandle.standardError.write(
        "--capture-window requires macOS 14+\n".data(using: .utf8) ?? Data()
    )
    exit(99)
}

// `--extract-app-icon <bundleId> <output.png> [size]` — resolve a
// bundle id to its installed .app via NSWorkspace, ask the workspace
// for the app's icon (the same NSImage Finder/Dock uses), render it
// to PNG at `size`×`size` (default 1024), and write to `output.png`.
//
// On success, prints the resolved .app POSIX path to stdout — the
// caller stats its Info.plist to decide whether to invalidate its
// cache on subsequent extracts.
//
// Why NSWorkspace.icon(forFile:) instead of reading .icns manually:
//   - Handles document-icon fallbacks, badges (Beta releases), and
//     custom Finder-set icons that the bundle's .icns doesn't carry.
//   - Asks the OS for the best representation at the requested size,
//     so a 1024px request hits the high-res Retina layer, while a
//     32px request avoids needless downscale work.
//
// Exit codes:
//   0 — success (icon written)
//   2 — bad args
//   3 — bundle id not installed locally
//   4 — icon render / PNG encode failure
if args.count >= 4 && args[1] == "--extract-app-icon" {
    let bundleId = args[2]
    let outputPath = args[3]
    let size: Int = args.count >= 5 ? (Int(args[4]) ?? 1024) : 1024
    let clampedSize = max(16, min(2048, size))

    guard let appUrl = NSWorkspace.shared.urlForApplication(
        withBundleIdentifier: bundleId
    ) else {
        FileHandle.standardError.write(
            "no installed app for bundle id \(bundleId)\n".data(using: .utf8) ?? Data()
        )
        exit(3)
    }

    // NSWorkspace.icon(forFile:) returns an NSImage with multiple
    // representations. We request a CGImage at the desired size and
    // let AppKit pick the best rep — high-res for Retina-scale, low
    // for small sidebar uses.
    let nsImage = NSWorkspace.shared.icon(forFile: appUrl.path)
    let targetSize = NSSize(width: clampedSize, height: clampedSize)
    nsImage.size = targetSize

    var rect = NSRect(origin: .zero, size: targetSize)
    guard let cgImage = nsImage.cgImage(
        forProposedRect: &rect,
        context: nil,
        hints: nil
    ) else {
        FileHandle.standardError.write(
            "icon -> cgImage failed for \(bundleId)\n".data(using: .utf8) ?? Data()
        )
        exit(4)
    }

    let outUrl = URL(fileURLWithPath: outputPath)
    let pngType = UTType.png.identifier as CFString
    guard let dest = CGImageDestinationCreateWithURL(outUrl as CFURL, pngType, 1, nil) else {
        FileHandle.standardError.write(
            "CGImageDestinationCreateWithURL failed\n".data(using: .utf8) ?? Data()
        )
        exit(4)
    }
    CGImageDestinationAddImage(dest, cgImage, nil)
    if !CGImageDestinationFinalize(dest) {
        FileHandle.standardError.write(
            "CGImageDestinationFinalize failed\n".data(using: .utf8) ?? Data()
        )
        exit(4)
    }

    // stdout = resolved .app path; caller stats Info.plist to know
    // when to invalidate.
    FileHandle.standardOutput.write(appUrl.path.data(using: .utf8) ?? Data())
    exit(0)
}

/// Snapshot envelope. Wraps the on-screen window list with the
/// pid / bundle id of `NSWorkspace.shared.frontmostApplication` —
/// the system's "currently active app". The TS side cross-checks
/// the snapshot's first entry against this value and warns when
/// they diverge. That divergence is the smoking gun for the
/// "picker chose Claude when cursor was over Library" class of
/// bug: CGWindowList's z-order can lag the actual frontmost-app
/// state, or transparent windows can sit at CGWindowList z=0
/// while another app's window is visually on top.
///
/// `frontmostPid` is null when no app is reported as frontmost
/// (e.g. a brief macOS transition state). In that case the TS
/// side leaves the snapshot order untouched and emits no warning.
struct WindowListSnapshot: Encodable {
    let windows: [WindowInfo]
    let frontmostPid: Int?
    let frontmostBundleId: String?
}

let frontmostApp = NSWorkspace.shared.frontmostApplication
let snapshot = WindowListSnapshot(
    windows: collectWindows(),
    frontmostPid: frontmostApp.map { Int($0.processIdentifier) },
    frontmostBundleId: frontmostApp?.bundleIdentifier
)

let encoder = JSONEncoder()
encoder.outputFormatting = []
let data = try encoder.encode(snapshot)
FileHandle.standardOutput.write(data)
