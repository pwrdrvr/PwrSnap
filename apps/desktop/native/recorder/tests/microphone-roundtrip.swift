// A real AAC round trip through the production microphone sample writer.
// No screen capture, microphone device, or TCC access is used.
import AVFoundation
import CoreMedia
import Foundation

func check(_ condition: Bool, _ message: String) throws {
    if !condition { throw NSError(domain: "MicrophoneRoundtrip", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
}

func sample(packet: Int, amplitude: Float = 0.3) throws -> CMSampleBuffer {
    let count = 1024
    var format = AudioStreamBasicDescription(
        mSampleRate: 48_000, mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
        mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4,
        mChannelsPerFrame: 1, mBitsPerChannel: 32, mReserved: 0
    )
    var description: CMAudioFormatDescription?
    try check(CMAudioFormatDescriptionCreate(
        allocator: kCFAllocatorDefault, asbd: &format, layoutSize: 0,
        layout: nil, magicCookieSize: 0, magicCookie: nil,
        extensions: nil, formatDescriptionOut: &description
    ) == noErr, "audio format")
    var block: CMBlockBuffer?
    try check(CMBlockBufferCreateWithMemoryBlock(
        allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: count * 4,
        blockAllocator: kCFAllocatorDefault, customBlockSource: nil,
        offsetToData: 0, dataLength: count * 4, flags: 0, blockBufferOut: &block
    ) == noErr, "sample storage")
    let values = (0..<count).map { index in
        amplitude * Float(sin(2 * Double.pi * 440 * Double(packet * count + index) / 48_000))
    }
    let status = values.withUnsafeBytes { bytes in
        CMBlockBufferReplaceDataBytes(with: bytes.baseAddress!, blockBuffer: block!, offsetIntoDestination: 0, dataLength: bytes.count)
    }
    try check(status == noErr, "sample bytes")
    var timing = CMSampleTimingInfo(
        duration: CMTime(value: 1, timescale: 48_000),
        presentationTimeStamp: CMTime(value: Int64(20 * 48_000 + packet * count), timescale: 48_000),
        decodeTimeStamp: .invalid
    )
    var result: CMSampleBuffer?
    try check(CMSampleBufferCreateReady(
        allocator: kCFAllocatorDefault, dataBuffer: block!, formatDescription: description!,
        sampleCount: count, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
        sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &result
    ) == noErr, "sample buffer")
    return result!
}

@main
struct MicrophoneRoundtrip {
    static func main() async throws {
        let url = URL(fileURLWithPath: CommandLine.arguments[1])
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVNumberOfChannelsKey: 1, AVSampleRateKey: 48_000,
            AVEncoderBitRateKey: 128_000
        ])
        input.expectsMediaDataInRealTime = true
        writer.add(input)
        let forwarder = MicForwarder(input: input, writer: writer)
        forwarder.append(try sample(packet: -1))
        try check(forwarder.samplesAppended == 0, "countdown pre-roll must be dropped")
        try check(writer.startWriting(), "start writing")
        writer.startSession(atSourceTime: CMTime(value: 20, timescale: 1))
        for packet in 0..<48 {
            let deadline = Date().addingTimeInterval(5)
            while !input.isReadyForMoreMediaData && Date() < deadline {
                try await Task.sleep(nanoseconds: 1_000_000)
            }
            try check(input.isReadyForMoreMediaData, "AAC encoder stalled")
            forwarder.append(try sample(packet: packet))
        }
        input.markAsFinished()
        await writer.finishWriting()
        try check(writer.status == .completed, "finish AAC: \(writer.error?.localizedDescription ?? "unknown")")
        forwarder.append(try sample(packet: 48))
        try check(forwarder.samplesReceived == 50 && forwarder.samplesAppended == 48, "sample lifecycle counts")
        // Silence detection over real Float32 PCM. A tone must register as
        // heard; digital silence must not, or a recording claims to have
        // captured a microphone that produced nothing — which is what made
        // a silent track play back at full volume with no explanation.
        try check(forwarder.heardSound, "a 0.3-amplitude tone must register as heard")

        let quietWriter = try AVAssetWriter(
            outputURL: url.deletingLastPathComponent().appendingPathComponent("quiet.mp4"),
            fileType: .mp4
        )
        let quietInput = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVNumberOfChannelsKey: 1, AVSampleRateKey: 48_000,
            AVEncoderBitRateKey: 128_000
        ])
        quietInput.expectsMediaDataInRealTime = true
        quietWriter.add(quietInput)
        let quiet = MicForwarder(input: quietInput, writer: quietWriter)
        try check(quietWriter.startWriting(), "start quiet writing")
        quietWriter.startSession(atSourceTime: CMTime(value: 20, timescale: 1))
        for packet in 0..<4 {
            let deadline = Date().addingTimeInterval(5)
            while !quietInput.isReadyForMoreMediaData && Date() < deadline {
                try await Task.sleep(nanoseconds: 2_000_000)
            }
            quiet.append(try sample(packet: packet, amplitude: 0))
        }
        quietInput.markAsFinished()
        await quietWriter.finishWriting()
        try check(quiet.samplesAppended == 4, "silent buffers still append")
        try check(!quiet.heardSound, "digital silence must not register as heard")

        let asset = AVURLAsset(url: url)
        let tracks = try await asset.loadTracks(withMediaType: .audio)
        try check(tracks.count == 1, "one encoded microphone track")
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: tracks[0], outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMIsFloatKey: true, AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsNonInterleaved: false
        ])
        reader.add(output)
        try check(reader.startReading(), "start PCM decoding")
        var sum = 0.0
        var decoded = 0
        while let buffer = output.copyNextSampleBuffer() {
            guard let data = CMSampleBufferGetDataBuffer(buffer) else { continue }
            var values = [Float](repeating: 0, count: CMBlockBufferGetDataLength(data) / 4)
            let status = values.withUnsafeMutableBytes { bytes in
                CMBlockBufferCopyDataBytes(data, atOffset: 0, dataLength: bytes.count, destination: bytes.baseAddress!)
            }
            try check(status == noErr, "decoded PCM bytes")
            for value in values { sum += Double(value * value) }
            decoded += values.count
        }
        try check(reader.status == .completed, "complete PCM decoding")
        let rms = sqrt(sum / Double(max(1, decoded)))
        let duration = try await asset.load(.duration).seconds
        try check(decoded >= 48_000 && rms > 0.1, "audible microphone PCM must survive AAC")
        try check(duration >= 1 && duration < 1.2, "host-clock timestamps must be rebased to clip time")
        print("microphone AAC roundtrip: appended=\(forwarder.samplesAppended) decoded=\(decoded) rms=\(rms) duration=\(duration)")
    }
}
