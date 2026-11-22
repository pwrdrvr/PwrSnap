import AVFoundation
import CoreMedia

/// Amplitude below which a buffer is treated as silence, ~-60 dBFS.
///
/// Well under anything a person would call audible, and comfortably above
/// the dither/noise floor an encoder leaves behind when it round-trips a
/// genuinely empty track (a measured all-zero system tap decodes at about
/// -91 dBFS, i.e. 2.8e-5).
let audioSilenceFloor: Float = 0.001

/// Audio samples accepted by one writer input. Accessed only on its write
/// queue. Input callbacks advance a separate clock so writer backpressure
/// and missing input can be distinguished, including during digital silence.
struct AudioSampleTelemetry {
    private var lastInput: UInt64?
    private var lastSample: UInt64?
    private var lastClip: UInt64?
    private var window = AudioLevels()
    private(set) var heardSound = false
    private(set) var muted = false

    mutating func setMuted(_ muted: Bool) {
        guard self.muted != muted else { return }
        self.muted = muted
        window = AudioLevels()
        lastClip = nil
    }

    func bufferForWriting(_ sample: CMSampleBuffer) -> CMSampleBuffer? {
        muted ? silentPCM(matching: sample) : sample
    }

    mutating func received(_ sample: CMSampleBuffer) {
        if CMSampleBufferGetNumSamples(sample) > 0 {
            lastInput = DispatchTime.now().uptimeNanoseconds
        }
    }

    mutating func appended(_ sample: CMSampleBuffer, at now: UInt64 = DispatchTime.now().uptimeNanoseconds) {
        guard CMSampleBufferGetNumSamples(sample) > 0 else { return }
        lastSample = now
        accumulateLevels(of: sample, into: &window)
        heardSound = heardSound || window.peak >= audioSilenceFloor
    }

    mutating func report(at now: UInt64) -> [String: Any] {
        // -1 dBFS. Hold the indicator for 1.5s from the measured window.
        if window.peak >= 0.8912509 { lastClip = now }
        let reading: [String: Any] = [
            "muted": muted,
            "clipping": lastClip.map { now - $0 <= 1_500_000_000 } ?? false,
            "rms": window.rms.map { $0 as Any } ?? NSNull(),
            "lastSampleAgeMs": lastSample.map { Double(now - $0) / 1_000_000 as Any } ?? NSNull(),
            "lastInputAgeMs": lastInput.map { Double(now - $0) / 1_000_000 as Any } ?? NSNull()
        ]
        window = AudioLevels()
        return reading
    }
}

/// Keep the armed AAC track and its original timing when muted. The writer
/// gets fresh silence with the same PCM layout. If the source changes to an
/// unreadable format, drop that packet while muted rather than forwarding it.
private func silentPCM(matching sample: CMSampleBuffer) -> CMSampleBuffer? {
    guard let format = CMSampleBufferGetFormatDescription(sample),
          let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
          asbd.mFormatID == kAudioFormatLinearPCM else { return nil }
    let samples = CMSampleBufferGetNumSamples(sample)
    guard samples > 0 else { return nil }
    let signedOrFloat = asbd.mFormatFlags & (kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsFloat) != 0
    let unsigned8Bit = asbd.mBitsPerChannel == 8 &&
        (asbd.mBytesPerFrame == 1 || asbd.mBytesPerFrame == asbd.mChannelsPerFrame)
    guard signedOrFloat || unsigned8Bit else { return nil }
    return try? sample.withAudioBufferList { original, _ -> CMSampleBuffer? in
        guard let largestBuffer = original.map(\.mDataByteSize).max(), largestBuffer > 0,
              let bytes = calloc(1, Int(largestBuffer)) else { return nil }
        defer { free(bytes) }
        if !signedOrFloat { memset(bytes, 0x80, Int(largestBuffer)) }

        let silence = AudioBufferList.allocate(maximumBuffers: original.count)
        defer { free(silence.unsafeMutablePointer) }
        silence.unsafeMutablePointer.pointee.mNumberBuffers = UInt32(original.count)
        for (index, buffer) in original.enumerated() {
            silence[index] = AudioBuffer(mNumberChannels: buffer.mNumberChannels,
                mDataByteSize: buffer.mDataByteSize, mData: bytes)
        }
        var timing = CMSampleTimingInfo()
        var output: CMSampleBuffer?
        guard CMSampleBufferGetSampleTimingInfo(sample, at: 0, timingInfoOut: &timing) == noErr,
              CMSampleBufferCreate(allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false,
                makeDataReadyCallback: nil, refcon: nil, formatDescription: format,
                sampleCount: samples, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
                sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &output) == noErr,
              let output,
              CMSampleBufferSetDataBufferFromAudioBufferList(output, blockBufferAllocator: nil,
                blockBufferMemoryAllocator: nil, flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
                bufferList: silence.unsafePointer) == noErr,
              CMSampleBufferSetDataReady(output) == noErr else { return nil }
        return output
    }
}

private struct AudioLevels {
    var peak: Float = 0
    var sumOfSquares: Double = 0
    var sampleCount = 0

    var rms: Double? { sampleCount > 0 ? min(1, sqrt(sumOfSquares / Double(sampleCount))) : nil }

    mutating func add(_ value: Double) {
        guard value.isFinite else { return }
        peak = max(peak, Float(abs(value)))
        sumOfSquares += value * value
        sampleCount += 1
    }
}

/// Scan the writer's PCM once for both the live RMS and the post-take
/// sound check. Normalize each channel sample before combining its energy.
private func accumulateLevels(of sampleBuffer: CMSampleBuffer, into levels: inout AudioLevels) {
    guard let format = CMSampleBufferGetFormatDescription(sampleBuffer),
          let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
          asbd.mFormatID == kAudioFormatLinearPCM else { return }

    // Non-interleaved stereo needs one AudioBuffer per channel, and a
    // stack-allocated AudioBufferList only has room for one. Allocate
    // through `AudioBufferList.allocate` rather than raw memory bound to
    // a single AudioBufferList: binding `capacity: 1` binds only the
    // 24-byte head, so every `mBuffers[i]` past index 0 would be read
    // through memory never bound as `AudioBuffer` — undefined behavior
    // the optimizer is entitled to break, in the one function whose
    // 0-return silently drops an audio track.
    let isNonInterleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
    let channels = Int(max(1, asbd.mChannelsPerFrame))
    let maxBuffers = isNonInterleaved ? channels : 1
    let list = AudioBufferList.allocate(maximumBuffers: maxBuffers)
    defer { free(list.unsafeMutablePointer) }
    let listBytes = AudioBufferList.sizeInBytes(maximumBuffers: maxBuffers)

    var blockBuffer: CMBlockBuffer?
    guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sampleBuffer,
        bufferListSizeNeededOut: nil,
        bufferListOut: list.unsafeMutablePointer,
        bufferListSize: listBytes,
        blockBufferAllocator: nil,
        blockBufferMemoryAllocator: nil,
        flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
        blockBufferOut: &blockBuffer
    ) == noErr else { return }
    defer { withExtendedLifetime(blockBuffer) {} }

    let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
    let isSigned = (asbd.mFormatFlags & kAudioFormatFlagIsSignedInteger) != 0
    let isBigEndian = (asbd.mFormatFlags & kAudioFormatFlagIsBigEndian) != 0
    let isAlignedHigh = (asbd.mFormatFlags & kAudioFormatFlagIsAlignedHigh) != 0
    let bits = Int(asbd.mBitsPerChannel)
    // For a non-interleaved buffer `mBytesPerFrame` is already per-channel;
    // for an interleaved one it covers every channel in the frame. A zero
    // (some descriptions leave it unset) falls back to the bit width.
    let frameBytes = Int(asbd.mBytesPerFrame)
    let samplesPerFrame = isNonInterleaved ? 1 : channels
    let bytesPerSample = frameBytes > 0 ? frameBytes / samplesPerFrame : (bits + 7) / 8
    guard bytesPerSample > 0 else { return }

    for buffer in list {
        guard let data = buffer.mData else { continue }
        let byteCount = Int(buffer.mDataByteSize)

        if isFloat && bits == 32 {
            let count = byteCount / MemoryLayout<Float>.size
            let samples = data.bindMemory(to: UInt32.self, capacity: count)
            for i in 0..<count {
                let raw = isBigEndian ? UInt32(bigEndian: samples[i]) : UInt32(littleEndian: samples[i])
                levels.add(Double(Float(bitPattern: raw)))
            }
        } else if isFloat && bits == 64 {
            let count = byteCount / MemoryLayout<Double>.size
            let samples = data.bindMemory(to: UInt64.self, capacity: count)
            for i in 0..<count {
                let raw = isBigEndian ? UInt64(bigEndian: samples[i]) : UInt64(littleEndian: samples[i])
                levels.add(Double(bitPattern: raw))
            }
        } else if !isFloat && bits == 8 {
            let count = byteCount
            let samples = data.bindMemory(to: UInt8.self, capacity: count)
            for i in 0..<count {
                let raw = isSigned ? Int(Int8(bitPattern: samples[i])) : Int(samples[i]) - 128
                levels.add(Double(raw) / 128.0)
            }
        } else if !isFloat && bits == 16 {
            let count = byteCount / MemoryLayout<Int16>.size
            let samples = data.bindMemory(to: Int16.self, capacity: count)
            for i in 0..<count {
                let raw = isBigEndian ? Int16(bigEndian: samples[i]) : samples[i]
                levels.add(Double(raw) / 32768.0)
            }
        } else if !isFloat && bits == 24 && bytesPerSample == 3 {
            // Packed 24-bit: three bytes per sample, no container. Read the
            // bytes directly and sign-extend from bit 23.
            let count = byteCount / 3
            let bytes = data.bindMemory(to: UInt8.self, capacity: byteCount)
            for i in 0..<count {
                let b0 = UInt32(bytes[i * 3])
                let b1 = UInt32(bytes[i * 3 + 1])
                let b2 = UInt32(bytes[i * 3 + 2])
                let unsigned = isBigEndian
                    ? (b0 << 16) | (b1 << 8) | b2
                    : (b2 << 16) | (b1 << 8) | b0
                let signed = Int32(bitPattern: unsigned << 8) >> 8
                levels.add(Double(signed) / 8_388_608.0)
            }
        } else if !isFloat && (bits == 24 || bits == 32) && bytesPerSample == 4 {
            // 32-bit container. A full 32-bit sample, or a 24-bit one
            // parked in the high bits (aligned-high) or the low 24
            // (aligned-low, sign-extended by CoreAudio — re-extend anyway
            // so a zero-padded producer cannot read as a huge positive).
            let count = byteCount / MemoryLayout<Int32>.size
            let samples = data.bindMemory(to: Int32.self, capacity: count)
            let fullWidth = bits == 32 || isAlignedHigh
            let divisor: Double = fullWidth ? 2_147_483_648.0 : 8_388_608.0
            for i in 0..<count {
                var raw = isBigEndian ? Int32(bigEndian: samples[i]) : samples[i]
                if !fullWidth { raw = (raw << 8) >> 8 }
                levels.add(Double(raw) / divisor)
            }
        }
    }
}
