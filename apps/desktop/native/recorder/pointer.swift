// The pointer, kept beside a burst's stills instead of baked into them.
//
// A burst records its pixels WITHOUT the pointer (showsCursor = false) and
// notes, for every still it keeps, where the pointer was and which sprite it
// showed. Two things follow:
//
//   - Change detection compares pixels only, so moving the pointer is never
//     "something changed" — only what the pointer does to the screen is.
//   - A kept still gets the pointer back as its own removable Cursor layer,
//     exactly as a screenshot does (main places it with the same math).
//
// Position: CGEvent(source: nil).location — global points, top-left origin,
// thread-safe, read the moment a frame is accepted. Sprite:
// NSCursor.currentSystem (deprecated in macOS 15 with no public
// replacement; still works, and nil only means "no sprite"). That is AppKit,
// so it is sampled on the main queue on a short timer and the newest sprite
// id is read under a lock; a sprite can lag the position by one tick.

import AppKit
import CoreGraphics
import Foundation

/// The pointer's hotspot in STILL-LOCAL points, and the sprite it showed.
struct PointerAt: Equatable {
    let x: Double
    let y: Double
    let sprite: Int?
}

struct PointerSprite: Equatable {
    let id: Int
    let path: String
    let pixelWidth: Int
    let pixelHeight: Int
    /// Draw size and hotspot in POINTS.
    let pointWidth: Double
    let pointHeight: Double
    let hotspotX: Double
    let hotspotY: Double
}

/// The distinct sprites a burst has seen, each written to `dir` once as
/// `pointer-<id>.png`, at most `limit` of them: an animated cursor (the
/// spinning wait cursor) is a new image every tick, and a long take must not
/// turn that into thousands of files. Past the limit a new sprite gets no id
/// (its stills carry no pointer); sprites already seen keep theirs. Not
/// thread-safe: the tracker serializes access.
final class PointerSpriteRegistry {
    static let defaultLimit = 64

    private struct Key: Hashable {
        let png: Data
        let pointWidth: Double
        let pointHeight: Double
        let hotspotX: Double
        let hotspotY: Double
    }

    private let dir: URL
    private let limit: Int
    private var ids: [Key: Int] = [:]
    private(set) var sprites: [PointerSprite] = []

    init(dir: URL, limit: Int = PointerSpriteRegistry.defaultLimit) {
        self.dir = dir
        self.limit = max(0, limit)
    }

    /// The id for this sprite, writing it the first time it is seen. Nil
    /// when the file cannot be written (that still then has no sprite).
    func register(
        png: Data, pixelWidth: Int, pixelHeight: Int,
        pointWidth: Double, pointHeight: Double, hotspotX: Double, hotspotY: Double
    ) -> Int? {
        let key = Key(png: png, pointWidth: pointWidth, pointHeight: pointHeight, hotspotX: hotspotX, hotspotY: hotspotY)
        if let id = ids[key] { return id }
        guard sprites.count < limit else { return nil }
        let id = sprites.count
        let url = dir.appendingPathComponent("pointer-\(id).png")
        do {
            try png.write(to: url, options: .atomic)
        } catch {
            return nil
        }
        ids[key] = id
        sprites.append(PointerSprite(
            id: id, path: url.path, pixelWidth: pixelWidth, pixelHeight: pixelHeight,
            pointWidth: pointWidth, pointHeight: pointHeight, hotspotX: hotspotX, hotspotY: hotspotY
        ))
        return id
    }
}

final class PointerTracker {
    /// Global top-left point of the still's (0, 0).
    private let origin: CGPoint
    private let registry: PointerSpriteRegistry
    private let lock = NSLock()
    private var currentSprite: Int?
    private var timer: DispatchSourceTimer?
    /// The last tick's raw cursor image (main queue only): an unchanged
    /// cursor — almost every tick — skips the PNG encode and the lookup.
    private var lastRaw: (pixels: Data, hotspot: NSPoint, size: NSSize)?

    init(dir: URL, origin: CGPoint) {
        self.origin = origin
        self.registry = PointerSpriteRegistry(dir: dir)
    }

    func start() {
        DispatchQueue.main.async {
            // NSCursor needs an AppKit connection; this opens one without
            // running an event loop, and the recorder never becomes an app
            // the user can see or that can take focus mid-take.
            NSApplication.shared.setActivationPolicy(.prohibited)
            self.sampleSprite()
            let timer = DispatchSource.makeTimerSource(queue: .main)
            timer.schedule(deadline: .now() + .milliseconds(66), repeating: .milliseconds(66))
            timer.setEventHandler { [weak self] in self?.sampleSprite() }
            timer.resume()
            self.timer = timer
        }
    }

    func stop() {
        DispatchQueue.main.async {
            self.timer?.cancel()
            self.timer = nil
        }
    }

    /// Where the pointer is right now. Any thread.
    func now() -> PointerAt? {
        guard let location = CGEvent(source: nil)?.location else { return nil }
        lock.lock()
        defer { lock.unlock() }
        return PointerAt(x: Double(location.x - origin.x), y: Double(location.y - origin.y), sprite: currentSprite)
    }

    func sprites() -> [PointerSprite] {
        lock.lock()
        defer { lock.unlock() }
        return registry.sprites
    }

    /// Main queue only.
    private func sampleSprite() {
        guard let cursor = NSCursor.currentSystem else { return }
        let image = cursor.image
        // The densest bitmap rep: the first rep of a multi-rep cursor is
        // usually 1× and would look blurry drawn over a Retina still.
        guard let rep = image.representations.compactMap({ $0 as? NSBitmapImageRep })
                .max(by: { $0.pixelsWide < $1.pixelsWide })
                ?? image.tiffRepresentation.flatMap({ NSBitmapImageRep(data: $0) }) else { return }
        var raw: Data?
        if !rep.isPlanar, let bytes = rep.bitmapData {
            raw = Data(bytes: bytes, count: rep.bytesPerRow * rep.pixelsHigh)
            if let last = lastRaw, last.pixels == raw, last.hotspot == cursor.hotSpot, last.size == image.size {
                return
            }
        }
        guard let png = rep.representation(using: .png, properties: [:]) else { return }
        lastRaw = raw.map { ($0, cursor.hotSpot, image.size) }
        lock.lock()
        defer { lock.unlock() }
        currentSprite = registry.register(
            png: png, pixelWidth: rep.pixelsWide, pixelHeight: rep.pixelsHigh,
            pointWidth: Double(image.size.width), pointHeight: Double(image.size.height),
            hotspotX: Double(cursor.hotSpot.x), hotspotY: Double(cursor.hotSpot.y)
        )
    }
}
