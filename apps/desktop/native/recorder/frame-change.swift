// How much changed between two screen frames, for the burst sink.
//
// ScreenCaptureKit hands the burst a `.complete` frame whenever something it
// tracks changes — and that includes things that leave the captured pixels
// byte-identical (the pointer moving outside a captured window). Measured on
// a real 8.8 s window burst: 28 of 80 consecutive pairs were identical, and
// 5 more differed only by the text caret blinking (one 1×16 strip). So the
// sink compares every frame against the LAST STILL IT KEPT and keeps it only
// when more than `floor` pixels changed.
//
// Comparing against the last kept still, not the previous frame, means
// small changes accumulate: several sub-floor edits in a row add up and the
// frame that crosses the floor is kept. Nothing is lost for good by being
// small at first.
//
// A pixel counts as changed when any of its B, G or R bytes moved by more
// than `tolerance` (the unused alpha byte of BGRA never counts). Screen
// frames of unchanged content are byte-identical, so the tolerance is tiny:
// it only absorbs the invisible 1–2/255 shimmer the same burst also showed
// (a whole window shifting by 1/255 once), never a faint change a person
// could see.

import Foundation

/// Per-channel change that does not count: invisible on screen.
let burstColorTolerance = 3

/// The number of pixels whose colour differs by more than `tolerance` in
/// any channel between two BGRA images of the same size, counting no
/// further than `limit + 1` — the caller only needs to know whether it
/// passed `limit`, and a frame that changed everywhere should not be walked
/// to the end.
func changedPixelCount(
    _ a: UnsafeRawPointer, rowBytesA: Int,
    _ b: UnsafeRawPointer, rowBytesB: Int,
    width: Int, height: Int, limit: Int, tolerance: Int
) -> Int {
    let rowLength = width * 4
    var count = 0
    for y in 0..<height {
        let rowA = a + y * rowBytesA
        let rowB = b + y * rowBytesB
        // Almost every row of an unchanged frame matches; memcmp is the fast path.
        if memcmp(rowA, rowB, rowLength) == 0 { continue }
        for x in 0..<width {
            let pa = rowA.loadUnaligned(fromByteOffset: x * 4, as: UInt32.self)
            let pb = rowB.loadUnaligned(fromByteOffset: x * 4, as: UInt32.self)
            // Little-endian BGRA: B, G, R in the low three bytes, alpha high.
            if (pa ^ pb) & 0x00FF_FFFF == 0 { continue }
            if channelDelta(pa, pb, 0) > tolerance || channelDelta(pa, pb, 8) > tolerance
                || channelDelta(pa, pb, 16) > tolerance {
                count += 1
                if count > limit { return count }
            }
        }
    }
    return count
}

@inline(__always)
private func channelDelta(_ a: UInt32, _ b: UInt32, _ shift: UInt32) -> Int {
    abs(Int((a >> shift) & 0xFF) - Int((b >> shift) & 0xFF))
}

/// The fewest changed pixels that count as a new still: a text caret's
/// worth (1 × 16 points), in backing pixels. A caret blink is noise; a
/// typed character, a pointer move or anything larger is a change.
func burstChangeFloor(pixelScale: Double) -> Int {
    let scale = min(max(pixelScale, 1), 4)
    return Int((16 * scale * scale).rounded())
}
