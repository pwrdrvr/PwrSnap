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

/// What the recorder knows about one attached input, for matching the
/// selector's label against it. The selector's label is Chromium's, and on
/// this machine (macOS 26, Electron 41) it is not always the CoreAudio name:
///
///   CoreAudio / AVFoundation      Chromium
///   "Desk Mic"                    "Desk Mic (Built-in)"           tag added
///   "Meeting Audio"               "Meeting Audio Device (Virtual)" the input's
///                                                                  data source
///   "Someone's Earbuds Pro"       "Earbuds"                       a Bluetooth
///                                                                  product name
///
/// (Measured with real devices; the names here are stand-ins.)
struct MicrophoneCandidate {
    /// `AVCaptureDevice.localizedName`, which is the CoreAudio device name.
    let name: String
    /// The name of the input's current data source, when it has one.
    /// Chromium labels such an input by it.
    let sourceName: String?
    /// Chromium names a Bluetooth headset by its product name, without the
    /// owner's name macOS shows.
    let bluetooth: Bool

    init(name: String, sourceName: String? = nil, bluetooth: Bool = false) {
        self.name = name
        self.sourceName = sourceName
        self.bluetooth = bluetooth
    }
}

/// Index of the device the selector named, or nil when none matches.
///
/// In order: the device name exactly, then without Chromium's trailing tag;
/// the data source name, the same two ways; and last, the ONE Bluetooth
/// input whose name contains the label as whole words. An exact name wins
/// over a tag-stripped one, so a device whose own name ends in a
/// parenthesis is never shadowed by another whose stripped label happens to
/// equal it. Two devices with one name are indistinguishable by name; the
/// first is taken, the same answer AVFoundation's own ordering would give a
/// user picking from a list of identical rows. Two Bluetooth inputs that
/// both contain the label are NOT a match: guessing between two headsets
/// would record a microphone the chip did not name.
func indexOfMicrophone(named requested: String, among candidates: [MicrophoneCandidate]) -> Int? {
    let stem = strippingTrailingParenthetical(requested)
    let keys = stem == requested ? [requested] : [requested, stem]
    for key in keys {
        if let index = candidates.firstIndex(where: { $0.name == key }) { return index }
    }
    for key in keys {
        if let index = candidates.firstIndex(where: { $0.sourceName == key }) { return index }
    }
    let containing = candidates.indices.filter {
        candidates[$0].bluetooth && containsWords(candidates[$0].name, stem)
    }
    return containing.count == 1 ? containing[0] : nil
}

/// Index of the device the selector named, matched on device names alone.
func indexOfMicrophone(named requested: String, among names: [String]) -> Int? {
    indexOfMicrophone(named: requested, among: names.map { MicrophoneCandidate(name: $0) })
}

/// Whether `phrase` appears in `text` with no letter or digit either side.
func containsWords(_ text: String, _ phrase: String) -> Bool {
    guard !phrase.isEmpty else { return false }
    var from = text.startIndex
    while let found = text.range(of: phrase, range: from..<text.endIndex) {
        let before = found.lowerBound == text.startIndex ? nil : text[text.index(before: found.lowerBound)]
        let after = found.upperBound == text.endIndex ? nil : text[found.upperBound]
        let isWordChar: (Character?) -> Bool = { $0.map { $0.isLetter || $0.isNumber } ?? false }
        if !isWordChar(before) && !isWordChar(after) { return true }
        from = text.index(after: found.lowerBound)
    }
    return false
}
