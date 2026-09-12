import AVFoundation
import CoreMedia

/// Amplitude below which a buffer is treated as silence, ~-60 dBFS.
///
/// Well under anything a person would call audible, and comfortably above
/// the dither/noise floor an encoder leaves behind when it round-trips a
/// genuinely empty track (a measured all-zero system tap decodes at about
/// -91 dBFS, i.e. 2.8e-5).
let audioSilenceFloor: Float = 0.001

/// Peak absolute amplitude (0...1) of a linear-PCM sample buffer.
///
/// This exists because a sample COUNT cannot tell "this source captured
/// audio" from "this source captured six seconds of digital silence". A
/// muted input, or a system tap with nothing playing through it, still
/// delivers buffers on schedule and still appends them — so counting
/// appends reports a healthy source for a track that holds nothing. That
/// is what made a recording claim system audio it never had, and what made
/// the preview play a silent track while the waveform drew the microphone.
///
/// Pass `stopAt` to bail out as soon as the peak reaches a threshold. The
/// callers only ever ask "did this cross the floor", and the answer is
/// still correct for that question while the scan gets to stop early. The
/// default returns the exact peak, so a measurement probe can keep using
/// this as a plain peak meter.
///
/// **Every readable layout must actually be read.** Returning 0 is not a
/// harmless "unknown" — 0 means "this source captured nothing", and that
/// answer deletes the track from every export and from the preview mix.
/// Handling only the formats we happened to test made a 24-bit USB
/// interface report a full take of narration as silent, so the branch
/// chain below covers every linear-PCM shape CoreAudio can hand us:
/// float32/64, and 8/16/24/32-bit integer, packed or 32-bit-aligned,
/// little- or big-endian. The final `return 0` is now reachable only for
/// genuinely non-PCM data.
func peakAmplitude(
    of sampleBuffer: CMSampleBuffer,
    stopAt threshold: Float = .greatestFiniteMagnitude
) -> Float {
    guard let format = CMSampleBufferGetFormatDescription(sampleBuffer),
          let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
          asbd.mFormatID == kAudioFormatLinearPCM else { return 0 }

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
    ) == noErr else { return 0 }

    let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
    let isBigEndian = (asbd.mFormatFlags & kAudioFormatFlagIsBigEndian) != 0
    let isAlignedHigh = (asbd.mFormatFlags & kAudioFormatFlagIsAlignedHigh) != 0
    let bits = Int(asbd.mBitsPerChannel)
    // For a non-interleaved buffer `mBytesPerFrame` is already per-channel;
    // for an interleaved one it covers every channel in the frame. A zero
    // (some descriptions leave it unset) falls back to the bit width.
    let frameBytes = Int(asbd.mBytesPerFrame)
    let samplesPerFrame = isNonInterleaved ? 1 : channels
    let bytesPerSample = frameBytes > 0 ? frameBytes / samplesPerFrame : (bits + 7) / 8
    guard bytesPerSample > 0 else { return 0 }

    var peak: Float = 0

    for buffer in list {
        guard let data = buffer.mData else { continue }
        let byteCount = Int(buffer.mDataByteSize)

        if isFloat && bits == 32 {
            let count = byteCount / MemoryLayout<Float>.size
            let samples = data.bindMemory(to: Float.self, capacity: count)
            for i in 0..<count {
                peak = max(peak, abs(samples[i]))
                if peak >= threshold { return peak }
            }
        } else if isFloat && bits == 64 {
            let count = byteCount / MemoryLayout<Double>.size
            let samples = data.bindMemory(to: Double.self, capacity: count)
            for i in 0..<count {
                peak = max(peak, Float(abs(samples[i])))
                if peak >= threshold { return peak }
            }
        } else if !isFloat && bits == 8 {
            let count = byteCount
            let samples = data.bindMemory(to: Int8.self, capacity: count)
            for i in 0..<count {
                peak = max(peak, abs(Float(samples[i]) / 128.0))
                if peak >= threshold { return peak }
            }
        } else if !isFloat && bits == 16 {
            let count = byteCount / MemoryLayout<Int16>.size
            let samples = data.bindMemory(to: Int16.self, capacity: count)
            for i in 0..<count {
                let raw = isBigEndian ? Int16(bigEndian: samples[i]) : samples[i]
                peak = max(peak, abs(Float(raw) / 32768.0))
                if peak >= threshold { return peak }
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
                peak = max(peak, abs(Float(signed) / 8_388_608.0))
                if peak >= threshold { return peak }
            }
        } else if !isFloat && (bits == 24 || bits == 32) && bytesPerSample == 4 {
            // 32-bit container. A full 32-bit sample, or a 24-bit one
            // parked in the high bits (aligned-high) or the low 24
            // (aligned-low, sign-extended by CoreAudio — re-extend anyway
            // so a zero-padded producer cannot read as a huge positive).
            let count = byteCount / MemoryLayout<Int32>.size
            let samples = data.bindMemory(to: Int32.self, capacity: count)
            let fullWidth = bits == 32 || isAlignedHigh
            let divisor: Float = fullWidth ? 2_147_483_648.0 : 8_388_608.0
            for i in 0..<count {
                var raw = isBigEndian ? Int32(bigEndian: samples[i]) : samples[i]
                if !fullWidth { raw = (raw << 8) >> 8 }
                peak = max(peak, abs(Float(raw) / divisor))
                if peak >= threshold { return peak }
            }
        }
    }
    return peak
}
