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
    let firstSample = packet * count
    let values = (0..<count).map { index -> Float in
        let seconds = Double(firstSample + index) / 48_000
        let phase = 2 * Double.pi * 440 * seconds
        return amplitude * Float(sin(phase))
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

// Write directly to stderr so a killed process still identifies the last
// native operation. Buffered stdout used to leave reader-start hangs blank.
func stage(_ message: String) {
    FileHandle.standardError.write(Data(("roundtrip: \(message)\n").utf8))
}

func checkPlanarStereo() throws {
    // ScreenCaptureKit can deliver one Float32 buffer per channel.
    // Give the channels different amplitudes so reading only one fails.
    var asbd = AudioStreamBasicDescription(
        mSampleRate: 48_000, mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagIsNonInterleaved,
        mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4,
        mChannelsPerFrame: 2, mBitsPerChannel: 32, mReserved: 0
    )
    var format: CMAudioFormatDescription?
    try check(CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &asbd,
        layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil,
        extensions: nil, formatDescriptionOut: &format) == noErr, "planar format")
    var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 48_000),
        presentationTimeStamp: CMTime(value: 1, timescale: 1), decodeTimeStamp: .invalid)
    var source: CMSampleBuffer?
    try check(CMSampleBufferCreate(allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false,
        makeDataReadyCallback: nil, refcon: nil, formatDescription: format,
        sampleCount: 4, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
        sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &source) == noErr, "planar sample")
    let list = AudioBufferList.allocate(maximumBuffers: 2)
    defer { free(list.unsafeMutablePointer) }
    list.unsafeMutablePointer.pointee.mNumberBuffers = 2
    var values: [Float] = [0.25, -0.25, 0.25, -0.25, 0.5, 0.5, 0.5, 0.5]
    try values.withUnsafeMutableBytes { bytes in
        for channel in 0..<2 {
            list[channel] = AudioBuffer(mNumberChannels: 1, mDataByteSize: 16,
                mData: bytes.baseAddress!.advanced(by: channel * 16))
        }
        try source!.setDataBuffer(fromAudioBufferList: list.unsafePointer, flags: .audioBufferListAssure16ByteAlignment)
    }
    try check(CMSampleBufferSetDataReady(source!) == noErr, "ready planar sample")
    var telemetry = AudioSampleTelemetry()
    telemetry.appended(source!)
    let normal = telemetry.report(at: DispatchTime.now().uptimeNanoseconds)
    try check(abs((normal["rms"] as? Double ?? -1) - sqrt(0.15625)) < 0.0001, "RMS combines both planes")
    telemetry.setMuted(true)
    guard let silent = telemetry.bufferForWriting(source!) else {
        try check(false, "muting must preserve the planar sample layout")
        return
    }
    try check(CMSampleBufferGetNumSamples(silent) == 4 &&
              CMSampleBufferGetPresentationTimeStamp(silent) == timing.presentationTimeStamp, "mute preserves timing")
    try silent.withAudioBufferList { buffers, _ in
        try check(buffers.count == 2 && buffers.allSatisfy { $0.mNumberChannels == 1 && $0.mDataByteSize == 16 },
                  "mute preserves both PCM planes")
    }
    telemetry.appended(silent)
    try check(telemetry.report(at: DispatchTime.now().uptimeNanoseconds)["rms"] as? Double == 0, "both planes are silent")
}

@main
struct MicrophoneRoundtrip {
    static func main() async throws {
        let url = URL(fileURLWithPath: CommandLine.arguments[1])
        try checkPlanarStereo()
        var clipping = AudioSampleTelemetry()
        clipping.appended(try sample(packet: 0, amplitude: 0.99))
        let clippedAt = DispatchTime.now().uptimeNanoseconds
        try check(clipping.report(at: clippedAt)["clipping"] as? Bool == true, "accepted peak above -1 dBFS clips")
        try check(clipping.report(at: clippedAt + 1_500_000_000)["clipping"] as? Bool == true, "clip latch holds")
        try check(clipping.report(at: clippedAt + 1_500_000_001)["clipping"] as? Bool == false, "clip latch expires")
        stage("create tone writer")
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
        let preRoll = forwarder.reportAudio(at: DispatchTime.now().uptimeNanoseconds)
        try check(preRoll["lastInputAgeMs"] is Double && preRoll["lastSampleAgeMs"] is NSNull && preRoll["rms"] is NSNull,
                  "rejected pre-roll proves input is present but must never contribute to written telemetry")
        stage("start tone writer")
        try check(writer.startWriting(), "start writing")
        writer.startSession(atSourceTime: CMTime(value: 20, timescale: 1))
        let expectedRMS = 0.3 / sqrt(2.0)
        for packet in 0..<48 {
            if packet == 12 || packet == 36 {
                let observed = forwarder.reportAudio(at: DispatchTime.now().uptimeNanoseconds)
                let targetRMS = packet == 12 ? expectedRMS : 0
                try check(abs((observed["rms"] as? Double ?? -1) - targetRMS) < 0.001,
                          "accepted samples must reflect the active mute interval")
                try check(observed["muted"] as? Bool == (packet == 36), "report carries the writer's mute state")
                forwarder.setMuted(packet == 12)
            }
            let deadline = Date().addingTimeInterval(5)
            while !input.isReadyForMoreMediaData && Date() < deadline {
                try await Task.sleep(nanoseconds: 1_000_000)
            }
            try check(input.isReadyForMoreMediaData, "AAC encoder stalled")
            forwarder.append(try sample(packet: packet))
        }
        let observed = forwarder.reportAudio(at: DispatchTime.now().uptimeNanoseconds)
        try check(abs((observed["rms"] as? Double ?? -1) - expectedRMS) < 0.001,
                  "accepted sine-wave RMS must follow its analytic amplitude / sqrt(2)")
        try check(observed["lastSampleAgeMs"] is Double, "written sample carries a timestamp")
        stage("finish tone writer appended=\(forwarder.samplesAppended)")
        input.markAsFinished()
        await writer.finishWriting()
        stage("tone writer completed")
        try check(writer.status == .completed, "finish AAC: \(writer.error?.localizedDescription ?? "unknown")")
        forwarder.append(try sample(packet: 48))
        try check(forwarder.samplesReceived == 50 && forwarder.samplesAppended == 48, "sample lifecycle counts")
        // Silence detection over real Float32 PCM. A tone must register as
        // heard; digital silence must not, or a recording claims to have
        // captured a microphone that produced nothing — which is what made
        // a silent track play back at full volume with no explanation.
        try check(forwarder.heardSound, "a 0.3-amplitude tone must register as heard")

        stage("create quiet writer")
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
        let silence = quiet.reportAudio(at: DispatchTime.now().uptimeNanoseconds)
        try check(silence["rms"] as? Double == 0 && silence["lastSampleAgeMs"] is Double,
                  "the writer accepted four silent buffers")
        let gap = quiet.reportAudio(at: DispatchTime.now().uptimeNanoseconds + 2_001_000_000)
        try check(gap["rms"] is NSNull && (gap["lastSampleAgeMs"] as? Double ?? 0) > 2_000,
                  "a sample gap has no RMS and carries the age of the last write")
        stage("finish quiet writer appended=\(quiet.samplesAppended)")
        quietInput.markAsFinished()
        await quietWriter.finishWriting()
        stage("quiet writer completed status=\(quietWriter.status.rawValue)")
        try check(quietWriter.status == .completed, "finish quiet AAC: \(quietWriter.error?.localizedDescription ?? "unknown")")
        try check(quiet.samplesAppended == 4, "silent buffers still append")
        try check(!quiet.heardSound, "digital silence must not register as heard")

        let asset = AVURLAsset(url: url)
        stage("load audio tracks")
        let tracks = try await asset.loadTracks(withMediaType: .audio)
        try check(tracks.count == 1, "one encoded microphone track")
        // AVAssetReader's PCM output creates an AudioQueue render pipeline.
        // On a fresh macOS account that can initialize an input device and
        // block at a microphone permission prompt. AVAudioFile decodes the
        // file offline, with no audio engine, capture session, or device.
        stage("open offline PCM decoder")
        let file = try AVAudioFile(forReading: url, commonFormat: .pcmFormatFloat32, interleaved: false)
        try check(file.processingFormat.channelCount == 1 && file.processingFormat.sampleRate == 48_000, "decoded PCM format")
        guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 4096) else {
            throw NSError(domain: "MicrophoneRoundtrip", code: 1, userInfo: [NSLocalizedDescriptionKey: "PCM decode storage"])
        }
        stage("decode offline PCM")
        // AAC has a transition region at each mute edge. Measure the interior
        // of each interval independently so a shifted or shortened track
        // cannot pass by containing the right total audible energy.
        let intervals = [2400..<10000, 15000..<34000, 39000..<46700]
        var sums = [0.0, 0.0, 0.0]
        var decoded = 0
        while file.framePosition < file.length {
            try file.read(into: buffer)
            try check(buffer.frameLength > 0, "PCM decoder must advance")
            guard let values = buffer.floatChannelData?[0] else {
                throw NSError(domain: "MicrophoneRoundtrip", code: 1, userInfo: [NSLocalizedDescriptionKey: "decoded Float32 PCM"])
            }
            for index in 0..<Int(buffer.frameLength) {
                if let interval = intervals.firstIndex(where: { $0.contains(decoded + index) }) {
                    sums[interval] += Double(values[index] * values[index])
                }
            }
            decoded += Int(buffer.frameLength)
        }
        stage("decoded \(decoded) samples")
        let levels = zip(sums, intervals).map { sqrt($0.0 / Double($0.1.count)) }
        let duration = try await asset.load(.duration).seconds
        try check(decoded >= 48_000 && abs(levels[0] - expectedRMS) < 0.03 &&
                  levels[1] < 0.0025 && abs(levels[2] - expectedRMS) < 0.03,
                  "one encoded track must retain tone, silence and resumed tone at the same offsets: \(levels)")
        try check(duration >= 1 && duration < 1.2, "host-clock timestamps must be rebased to clip time")
        print("microphone AAC roundtrip: appended=\(forwarder.samplesAppended) decoded=\(decoded) rms=\(levels) duration=\(duration)")
    }
}
