// Burst capture sink for the PwrSnap recorder.
//
// A burst is a short run of lossless stills, not a video: ScreenCaptureKit
// delivers BGRA frames at up to `fps` (only when the screen changed — an
// idle display produces no `.complete` frames, so there are no duplicate
// stills), and each one is written as a PNG into a directory the caller
// owns. The directory is a RING: once `maxFrames` stills exist, the oldest
// is deleted as each new one lands, so a burst left running costs a
// bounded amount of disk and the user reviews the last N seconds.
//
// Threading: `consume` runs on the stream's sample queue. It copies the
// pixels out of the IOSurface-backed buffer right away (so ScreenCaptureKit
// gets its buffer back and does not stall) and hands the copy to a
// concurrent encode queue. At most `maxInFlight` encodes run at once; a
// frame that arrives while every slot is busy is DROPPED and counted —
// falling behind must never grow memory without bound. Ring bookkeeping
// is serialized on `ringQueue`.

import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ImageIO
import UniformTypeIdentifiers

final class BurstSink {
    struct Frame {
        let index: Int
        let path: String
        let utcMs: Double
        let width: Int
        let height: Int
    }

    private let dir: URL
    private let minInterval: Double
    private let maxFrames: Int
    private let maxInFlight: Int
    private let encodeQueue = DispatchQueue(label: "pwrsnap.recorder.burst.encode", attributes: .concurrent)
    private let ringQueue = DispatchQueue(label: "pwrsnap.recorder.burst.ring")
    private let slots: DispatchSemaphore
    private let group = DispatchGroup()
    private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
    private let onProgress: (Int, Int) -> Void

    private var lastAcceptedPts: Double = -Double.infinity
    private var nextIndex = 0
    // Ring state — touched only on ringQueue.
    private var frames: [Frame] = []
    private var written = 0
    private var dropped = 0
    private var failed = 0
    private var evicted = 0

    init(dir: URL, fps: Double, maxFrames: Int, maxInFlight: Int = 4, onProgress: @escaping (Int, Int) -> Void) {
        self.dir = dir
        self.minInterval = fps > 0 ? 1.0 / fps : 0
        self.maxFrames = max(1, maxFrames)
        self.maxInFlight = max(1, maxInFlight)
        self.slots = DispatchSemaphore(value: max(1, maxInFlight))
        self.onProgress = onProgress
    }

    /// One `.complete` screen sample. Called on the stream's sample queue.
    func consume(_ buf: CMSampleBuffer) {
        let pts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(buf))
        // ScreenCaptureKit's minimumFrameInterval already paces delivery;
        // this guards a stream that delivers faster anyway (allow 5% slop
        // so a frame that lands a hair early is not thrown away).
        if pts - lastAcceptedPts < minInterval * 0.95 { return }
        guard let pixels = CMSampleBufferGetImageBuffer(buf) else { return }
        guard slots.wait(timeout: .now()) == .success else {
            ringQueue.async { self.dropped += 1 }
            return
        }
        lastAcceptedPts = pts
        guard let image = copyImage(pixels) else {
            slots.signal()
            ringQueue.async { self.failed += 1 }
            return
        }
        // Host clock → UTC, sampled now: the same conversion the video path
        // uses for its timeline event.
        let hostNow = CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock()))
        let utcMs = (Date().timeIntervalSince1970 + pts - hostNow) * 1000
        let index = nextIndex
        nextIndex += 1
        let url = dir.appendingPathComponent(String(format: "frame-%06d.png", index))
        group.enter()
        encodeQueue.async {
            defer {
                self.slots.signal()
                self.group.leave()
            }
            let ok = self.writePng(image, to: url)
            self.ringQueue.sync {
                guard ok else {
                    self.failed += 1
                    return
                }
                self.written += 1
                // Encodes finish out of order; keep the ring in capture order.
                let frame = Frame(index: index, path: url.path, utcMs: utcMs, width: image.width, height: image.height)
                let at = self.frames.firstIndex(where: { $0.index > index }) ?? self.frames.count
                self.frames.insert(frame, at: at)
                while self.frames.count > self.maxFrames {
                    let oldest = self.frames.removeFirst()
                    try? FileManager.default.removeItem(atPath: oldest.path)
                    self.evicted += 1
                }
                self.onProgress(self.frames.count, self.written)
            }
        }
    }

    /// Wait for in-flight encodes, then report the ring in capture order.
    func finish() -> (frames: [Frame], written: Int, dropped: Int, failed: Int, evicted: Int) {
        group.wait()
        return ringQueue.sync { (frames, written, dropped, failed, evicted) }
    }

    /// Copy BGRA pixels out of the (pooled) capture buffer into memory we own.
    private func copyImage(_ pixels: CVPixelBuffer) -> CGImage? {
        guard CVPixelBufferGetPixelFormatType(pixels) == kCVPixelFormatType_32BGRA else { return nil }
        CVPixelBufferLockBaseAddress(pixels, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixels, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(pixels) else { return nil }
        let width = CVPixelBufferGetWidth(pixels)
        let height = CVPixelBufferGetHeight(pixels)
        let rowBytes = CVPixelBufferGetBytesPerRow(pixels)
        guard width > 0, height > 0 else { return nil }
        let data = Data(bytes: base, count: rowBytes * height)
        guard let provider = CGDataProvider(data: data as CFData) else { return nil }
        let info = CGBitmapInfo(rawValue: CGBitmapInfo.byteOrder32Little.rawValue
            | CGImageAlphaInfo.noneSkipFirst.rawValue)
        return CGImage(
            width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
            bytesPerRow: rowBytes, space: colorSpace, bitmapInfo: info,
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent
        )
    }

    private func writePng(_ image: CGImage, to url: URL) -> Bool {
        let staging = url.appendingPathExtension("partial")
        guard let dest = CGImageDestinationCreateWithURL(
            staging as CFURL, UTType.png.identifier as CFString, 1, nil
        ) else { return false }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else {
            try? FileManager.default.removeItem(at: staging)
            return false
        }
        do {
            try FileManager.default.moveItem(at: staging, to: url)
            return true
        } catch {
            try? FileManager.default.removeItem(at: staging)
            return false
        }
    }
}
