import AVFoundation
import CoreMedia

@available(macOS 13.0, *)
final class MicForwarder: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    let input: AVAssetWriterInput
    let writer: AVAssetWriter
    private(set) var samplesReceived: Int = 0
    private(set) var samplesAppended: Int = 0
    /// Whether any appended buffer rose above the silence floor. A muted
    /// or disconnected input still delivers buffers, so the append count
    /// alone reports a working microphone for a track holding nothing.
    private(set) var heardSound: Bool = false

    init(input: AVAssetWriterInput, writer: AVAssetWriter) {
        self.input = input
        self.writer = writer
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        append(sampleBuffer)
    }

    // Called only on the recorder's serial write queue. Microphone capture
    // starts during the countdown; discard pre-roll until screen capture
    // starts the writer's session on the shared host-clock timebase.
    func append(_ sampleBuffer: CMSampleBuffer) {
        samplesReceived += 1
        if writer.status == .writing &&
           CMSampleBufferDataIsReady(sampleBuffer) &&
           input.isReadyForMoreMediaData &&
           input.append(sampleBuffer) {
            samplesAppended += 1
            // Measured only until this source proves itself; see main.swift.
            if !heardSound && peakAmplitude(of: sampleBuffer, stopAt: audioSilenceFloor) >= audioSilenceFloor {
                heardSound = true
            }
        }
    }
}

// MARK: - Choosing the input by name

/// Strip one trailing " (…)" group. Chromium names a macOS input after its
/// CoreAudio name plus a parenthesised tag — the transport ("Desk Mic (USB)",
/// "Studio Mic (Built-in)") or a USB vendor:product pair — while
/// AVFoundation's `localizedName` is the bare CoreAudio name.
func strippingTrailingParenthetical(_ name: String) -> String {
    guard name.hasSuffix(")"), let open = name.range(of: " (", options: .backwards) else { return name }
    let stem = String(name[..<open.lowerBound])
    return stem.isEmpty ? name : stem
}

/// Index of the device the selector named, or nil when none matches.
///
/// An exact name wins over a tag-stripped one, so a device whose own name
/// ends in a parenthesis is never shadowed by another whose stripped label
/// happens to equal it. Two devices with one name are indistinguishable by
/// name; the first is taken, the same answer AVFoundation's own ordering
/// would give a user picking from a list of identical rows.
func indexOfMicrophone(named requested: String, among names: [String]) -> Int? {
    if let exact = names.firstIndex(of: requested) { return exact }
    let stem = strippingTrailingParenthetical(requested)
    if stem != requested, let tagged = names.firstIndex(of: stem) { return tagged }
    return nil
}
