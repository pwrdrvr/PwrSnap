// changedPixelCount against a naive model, over seeded random frames.
//
// Model: walk every pixel, count those whose B, G or R byte differs by more
// than the tolerance (alpha is ignored). The implementation may stop early, so the rule is:
//   model <= limit  ⇒  result == model
//   model >  limit  ⇒  result == limit + 1
// Frames carry row padding (rowBytes > width × 4) with garbage in it, which
// must never count. Changes are clustered, scattered, alpha-only or none.
import Foundation

func expect(_ condition: Bool, _ message: String) {
    if !condition {
        FileHandle.standardError.write(("FAIL: " + message + "\n").data(using: .utf8)!)
        exit(1)
    }
}

/// SplitMix64 — deterministic, so a failure names a seed that reproduces it.
struct Rng {
    var state: UInt64
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
    mutating func int(_ upper: Int) -> Int { Int(next() % UInt64(max(1, upper))) }
}

func modelCount(_ a: [UInt8], _ ra: Int, _ b: [UInt8], _ rb: Int, _ w: Int, _ h: Int, _ tol: Int) -> Int {
    var n = 0
    for y in 0..<h {
        for x in 0..<w {
            let i = y * ra + x * 4, j = y * rb + x * 4
            if (0..<3).contains(where: { abs(Int(a[i + $0]) - Int(b[j + $0])) > tol }) { n += 1 }
        }
    }
    return n
}

@main
struct FrameChange {
    static func main() {
        var cases = 0
        for seed in UInt64(1)...600 {
            var rng = Rng(state: seed)
            let w = 1 + rng.int(40), h = 1 + rng.int(30)
            let ra = w * 4 + rng.int(3) * 4 + rng.int(4)   // padded, sometimes unaligned
            let rb = w * 4 + rng.int(3) * 4 + rng.int(4)
            var a = (0..<(ra * h)).map { _ in UInt8(truncatingIfNeeded: rng.next()) }
            var b = [UInt8](repeating: 0, count: rb * h)
            for i in 0..<b.count { b[i] = UInt8(truncatingIfNeeded: rng.next()) }  // padding garbage
            for y in 0..<h { for x in 0..<(w * 4) { b[y * rb + x] = a[y * ra + x] } }
            // Perturb: none, a clustered box, scattered pixels, alpha only, or
            // a faint shimmer of ±1…5 around the tolerance.
            switch rng.int(5) {
            case 0: break
            case 1:
                let bx = rng.int(w), by = rng.int(h), bw = 1 + rng.int(w - bx), bh = 1 + rng.int(h - by)
                for y in by..<(by + bh) { for x in bx..<(bx + bw) { b[y * rb + x * 4 + rng.int(3)] &+= 1 + UInt8(rng.int(255)) } }
            case 2:
                for _ in 0..<rng.int(w * h + 1) { b[rng.int(h) * rb + rng.int(w) * 4 + rng.int(3)] ^= UInt8(1 + rng.int(255)) }
            case 3:
                for y in 0..<h { for x in 0..<w { b[y * rb + x * 4 + 3] ^= 0xFF } }
            default:
                for _ in 0..<rng.int(w * h + 1) {
                    let k = rng.int(h) * rb + rng.int(w) * 4 + rng.int(3)
                    b[k] = rng.int(2) == 0 ? b[k] &+ UInt8(1 + rng.int(5)) : b[k] &- UInt8(1 + rng.int(5))
                }
            }
            let tol = rng.int(3) == 0 ? 0 : rng.int(6)
            if rng.int(2) == 0 { swap(&a, &b) ; let model = modelCount(a, rb, b, ra, w, h, tol); check(a, rb, b, ra, w, h, model, tol, &rng, seed) }
            else { let model = modelCount(a, ra, b, rb, w, h, tol); check(a, ra, b, rb, w, h, model, tol, &rng, seed) }
            cases += 1
        }

        // The floor is a 1×16-point caret in backing pixels, clamped to 1×…4×.
        expect(burstChangeFloor(pixelScale: 1) == 16, "1× floor")
        expect(burstChangeFloor(pixelScale: 2) == 64, "2× floor")
        expect(burstChangeFloor(pixelScale: 0.5) == 16, "below 1× clamps")
        expect(burstChangeFloor(pixelScale: 9) == 256, "above 4× clamps")
        print("frame change: ok cases=\(cases)")
    }

    static func check(_ a: [UInt8], _ ra: Int, _ b: [UInt8], _ rb: Int, _ w: Int, _ h: Int,
                      _ model: Int, _ tol: Int, _ rng: inout Rng, _ seed: UInt64) {
        let limit = rng.int(2) == 0 ? rng.int(4) : rng.int(w * h + 2)
        let got = a.withUnsafeBytes { pa in
            b.withUnsafeBytes { pb in
                changedPixelCount(pa.baseAddress!, rowBytesA: ra, pb.baseAddress!, rowBytesB: rb,
                                  width: w, height: h, limit: limit, tolerance: tol)
            }
        }
        let want = model > limit ? limit + 1 : model
        expect(got == want, "seed \(seed): \(w)x\(h) limit=\(limit) tol=\(tol) model=\(model) got=\(got)")
    }
}
