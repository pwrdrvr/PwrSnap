import AVFoundation
import CoreMedia

@available(macOS 13.0, *)
final class MicForwarder: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    let input: AVAssetWriterInput
    let writer: AVAssetWriter
    private(set) var samplesReceived: Int = 0
    private(set) var samplesAppended: Int = 0

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
        }
    }
}
