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
/// Returns 0 for any buffer that cannot be read as PCM. Failing toward
/// "silent" is the safe direction: a source we could not measure is not
/// claimed as captured.
func peakAmplitude(of sampleBuffer: CMSampleBuffer) -> Float {
    guard let format = CMSampleBufferGetFormatDescription(sampleBuffer),
          let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
          asbd.mFormatID == kAudioFormatLinearPCM else { return 0 }

    // Size the list first: non-interleaved stereo needs one AudioBuffer per
    // channel, and a stack-allocated AudioBufferList only has room for one.
    var sizeNeeded = 0
    guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sampleBuffer,
        bufferListSizeNeededOut: &sizeNeeded,
        bufferListOut: nil,
        bufferListSize: 0,
        blockBufferAllocator: nil,
        blockBufferMemoryAllocator: nil,
        flags: 0,
        blockBufferOut: nil
    ) == noErr, sizeNeeded > 0 else { return 0 }

    let raw = UnsafeMutableRawPointer.allocate(
        byteCount: sizeNeeded,
        alignment: MemoryLayout<AudioBufferList>.alignment
    )
    defer { raw.deallocate() }
    let listPointer = raw.bindMemory(to: AudioBufferList.self, capacity: 1)

    var blockBuffer: CMBlockBuffer?
    guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sampleBuffer,
        bufferListSizeNeededOut: nil,
        bufferListOut: listPointer,
        bufferListSize: sizeNeeded,
        blockBufferAllocator: nil,
        blockBufferMemoryAllocator: nil,
        flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
        blockBufferOut: &blockBuffer
    ) == noErr else { return 0 }

    let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
    let bits = asbd.mBitsPerChannel
    var peak: Float = 0

    for buffer in UnsafeMutableAudioBufferListPointer(listPointer) {
        guard let data = buffer.mData else { continue }
        let byteCount = Int(buffer.mDataByteSize)
        if isFloat && bits == 32 {
            let count = byteCount / MemoryLayout<Float>.size
            let samples = data.bindMemory(to: Float.self, capacity: count)
            for i in 0..<count { peak = max(peak, abs(samples[i])) }
        } else if !isFloat && bits == 16 {
            let count = byteCount / MemoryLayout<Int16>.size
            let samples = data.bindMemory(to: Int16.self, capacity: count)
            for i in 0..<count { peak = max(peak, abs(Float(samples[i]) / 32768.0)) }
        } else if !isFloat && bits == 32 {
            let count = byteCount / MemoryLayout<Int32>.size
            let samples = data.bindMemory(to: Int32.self, capacity: count)
            for i in 0..<count { peak = max(peak, abs(Float(samples[i]) / 2_147_483_648.0)) }
        }
    }
    return peak
}
