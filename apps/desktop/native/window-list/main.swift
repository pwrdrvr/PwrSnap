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

let encoder = JSONEncoder()
encoder.outputFormatting = []
let data = try encoder.encode(collectWindows())
FileHandle.standardOutput.write(data)
