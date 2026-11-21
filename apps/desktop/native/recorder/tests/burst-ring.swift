// The burst ring, fed synthetic ScreenCaptureKit-shaped frames: BGRA pixel
// buffers wrapped in sample buffers with real presentation timestamps. No
// screen capture, no TCC. Rules checked against the files on disk:
//
//   1. The ring never holds more than maxFrames stills, and what it holds
//      is exactly the newest frames written, in capture order.
//   2. Every reported path exists, and nothing else is left in the dir
//      (evicted stills are deleted, no `.partial` staging files remain).
//   3. Frames closer together than 1/fps are not kept twice.
//   4. Each still decodes at the buffer's full pixel size, with the pixels
//      it was given (the BGRA → PNG byte order is right).
import CoreMedia
import CoreVideo
import Foundation
import ImageIO

func expect(_ condition: Bool, _ message: String) {
    if !condition {
        FileHandle.standardError.write(("FAIL: " + message + "\n").data(using: .utf8)!)
        exit(1)
    }
}

/// A solid BGRA frame whose blue channel encodes `n` (so a still can be
/// traced back to the frame it came from) and red is fixed at 0xC0.
func makeSample(n: Int, pts: Double, width: Int, height: Int) -> CMSampleBuffer {
    var pixels: CVPixelBuffer?
    CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA, nil, &pixels)
    let pb = pixels!
    CVPixelBufferLockBaseAddress(pb, [])
    let base = CVPixelBufferGetBaseAddress(pb)!.assumingMemoryBound(to: UInt8.self)
    let rowBytes = CVPixelBufferGetBytesPerRow(pb)
    for y in 0..<height {
        for x in 0..<width {
            let p = base + y * rowBytes + x * 4
            p[0] = UInt8(n % 256)   // B
            p[1] = 0x20             // G
            p[2] = 0xC0             // R
            p[3] = 0xFF             // A
        }
    }
    CVPixelBufferUnlockBaseAddress(pb, [])
    var format: CMVideoFormatDescription?
    CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pb, formatDescriptionOut: &format)
    var timing = CMSampleTimingInfo(
        duration: .invalid,
        presentationTimeStamp: CMTime(seconds: pts, preferredTimescale: 6000),
        decodeTimeStamp: .invalid
    )
    var sample: CMSampleBuffer?
    CMSampleBufferCreateReadyWithImageBuffer(
        allocator: kCFAllocatorDefault, imageBuffer: pb, formatDescription: format!,
        sampleTiming: &timing, sampleBufferOut: &sample
    )
    return sample!
}

func pixel(of path: String) -> (r: Int, g: Int, b: Int, w: Int, h: Int)? {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
    var rgba = [UInt8](repeating: 0, count: 4)
    let ctx = CGContext(data: &rgba, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: 1, height: 1))
    return (Int(rgba[0]), Int(rgba[1]), Int(rgba[2]), image.width, image.height)
}

@main
struct BurstRing {
    static func main() {
        let dir = URL(fileURLWithPath: CommandLine.arguments[1])
        let width = 64, height = 40, maxFrames = 7, fps = 10.0
        let sink = BurstSink(dir: dir, fps: fps, maxFrames: maxFrames, maxInFlight: 64) { _, _ in }

        // 30 frames 0.1 s apart, plus a near-duplicate 10 ms after frame 4
        // that pacing must refuse.
        var fed = 0
        for n in 0..<30 {
            sink.consume(makeSample(n: n, pts: 100.0 + Double(n) * 0.1, width: width, height: height))
            fed += 1
            if n == 4 {
                sink.consume(makeSample(n: 200, pts: 100.0 + 0.41, width: width, height: height))
            }
        }
        let result = sink.finish()
        expect(result.written == 30, "every paced frame was written (got \(result.written))")
        expect(result.frames.count == maxFrames, "ring holds maxFrames (got \(result.frames.count))")
        expect(result.evicted == 30 - maxFrames, "evicted the rest (got \(result.evicted))")
        expect(result.frames.map { $0.index } == Array((30 - maxFrames)..<30), "ring is the newest frames in order: \(result.frames.map { $0.index })")
        let utc = result.frames.map { $0.utcMs }
        expect(utc == utc.sorted(), "capture times ascend")
        for i in 1..<utc.count {
            expect(abs((utc[i] - utc[i - 1]) - 100) < 1, "capture times keep their 100 ms spacing")
        }

        let onDisk = Set((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [])
        let reported = Set(result.frames.map { URL(fileURLWithPath: $0.path).lastPathComponent })
        expect(onDisk == reported, "the directory holds exactly the ring: \(onDisk.sorted())")

        for frame in result.frames {
            guard let px = pixel(of: frame.path) else { expect(false, "still decodes: \(frame.path)"); return }
            expect(px.w == width && px.h == height, "still keeps the buffer's pixel size")
            expect(px.r == 0xC0 && px.g == 0x20 && px.b == frame.index % 256,
                   "still carries frame \(frame.index)'s pixels in RGB order (got \(px.r),\(px.g),\(px.b))")
            expect(frame.width == width && frame.height == height, "reported size matches")
        }
        print("burst ring: ok fed=\(fed) kept=\(result.frames.count)")
    }
}
