// PwrSnap recorder helper.
//
// Records a fixed display rect using ScreenCaptureKit (+ optional
// microphone via AVCaptureSession). Output is a single H.264/AAC
// .mp4 file written to the path the caller specifies. Driven by the
// main TypeScript process over stdin/stdout JSON-RPC:
//
//   start  → { "type": "start", "displayId": 1, "rect": { "x": …, "y": …,
//             "w": …, "h": … }, "outputPath": "/tmp/foo.mp4",
//             "systemAudio": true, "microphone": false }
//   stop   → { "type": "stop" }
//
// Notifies main:
//
//   started   → { "event": "started", "physicalRect": { x,y,w,h } }
//   stopped   → { "event": "stopped", "durationSec": 12.5,
//                "containerFormat": "mp4",
//                "hasSystemAudio": true, "hasMicrophoneAudio": false,
//                "outputPath": "/tmp/foo.mp4" }
//   error     → { "event": "error", "code": "...", "message": "..." }
//
// Why a Swift CLI and not a Node native module: same reasoning as
// window-list/main.swift — ABI-stable forever, no node-gyp dance,
// straightforward TCC integration.
//
// macOS minimum: 13.0 (ScreenCaptureKit + .capturesAudio +
// SCContentSharingPicker requires macOS 12+; mic device pickers stay
// AVFoundation and predate ScreenCaptureKit).

import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

// MARK: - I/O envelope

struct StartRequest: Decodable {
    let displayId: UInt32
    let rect: RectPayload
    let outputPath: String
    let systemAudio: Bool
    let microphone: Bool
    /// Optional wall-clock target (Date.now() ms) — Swift does setup
    /// immediately, then waits until this moment before calling
    /// `stream.startCapture()`. Lets the TS-side visible countdown
    /// run in parallel with the slow first-call `SCShareableContent`
    /// enumeration so the user doesn't see "1" frozen waiting for
    /// the cold launch.
    let captureAtMs: Double?
    /// Explicit PIDs to exclude from the SCContentFilter — our
    /// Electron main process + every renderer BrowserWindow PID.
    /// More targeted than bundle-ID matching, which in dev catches
    /// every Electron app (PwrAgent, VS Code, etc.) and broadens
    /// the daemon-side filter surface unnecessarily. Each PID is
    /// matched against `SCRunningApplication.processID`.
    let excludePids: [Int]?
}

struct RectPayload: Decodable {
    let x: Int
    let y: Int
    let w: Int
    let h: Int
}

enum Inbound: Decodable {
    case start(StartRequest)
    case stop

    enum CodingKeys: String, CodingKey { case type }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .type)
        switch kind {
        case "start":
            self = .start(try StartRequest(from: decoder))
        case "stop":
            self = .stop
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: c, debugDescription: "unknown type: \(kind)"
            )
        }
    }
}

/// Verbose diagnostic line to stderr. Carries an ISO timestamp +
/// elapsed-since-launch so we can pinpoint the exact point Swift
/// reaches in its lifecycle. The recorder is a separate process
/// per recording session — its stdout carries the structured
/// JSON-RPC events TS depends on, so we use stderr exclusively
/// for these diagnostic markers.
let recorderLaunchTime = Date()
func diag(_ message: String) {
    let elapsed = Date().timeIntervalSince(recorderLaunchTime)
    let line = String(format: "[recorder %.3fs] %@\n", elapsed, message)
    if let data = line.data(using: .utf8) {
        FileHandle.standardError.write(data)
    }
}

func emit(_ payload: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: payload, options: []) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    }
}

func emitError(_ code: String, _ message: String) {
    emit(["event": "error", "code": code, "message": message])
}

// MARK: - Recorder

@available(macOS 13.0, *)
final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private var assetWriter: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var audioInput: AVAssetWriterInput?
    private var micInput: AVAssetWriterInput?
    private var micSession: AVCaptureSession?
    private var startedAtCMTime: CMTime = .invalid
    private var startedAtWallClock: Date = Date()
    private var outputURL: URL?
    private var hasSystemAudio = false
    private var hasMicrophoneAudio = false
    private var firstSampleWritten = false
    private let writeQueue = DispatchQueue(label: "pwrsnap.recorder.write")
    /// Sample counters for end-of-recording diagnostics. The
    /// "popover shows nothing / file is 0 bytes" failure mode is
    /// invisible unless we log the totals — by the time TS sees a
    /// 0-byte file the recorder is already gone and there's nothing
    /// to debug. The counters live on the recorder so `stop()` can
    /// emit them right before exit.
    private var videoSamplesReceived: Int = 0
    private var videoSamplesAppended: Int = 0
    private var audioSamplesReceived: Int = 0
    private var audioSamplesAppended: Int = 0
    /// SCStream's `.microphone` output (macOS 14+). Unused by today's
    /// recorder — mic capture runs through AVCaptureSession — but
    /// counted so a stray sample shows up in the stop() diag totals
    /// rather than getting swallowed by an `@unknown default`.
    private var microphoneSamplesReceived: Int = 0
    /// Lifecycle phase observable by the SCStreamDelegate. Without
    /// this, didStopWithError can't tell whether the delegate fired
    /// during the openStream startup window (in which case we want
    /// to swallow + retry) vs. during an active recording (in which
    /// case we forward to TS as a hard failure).
    ///
    /// Transitions: `starting` → `active` (openStream emits "started")
    ///              → `stopped` (stop() finishes)
    private var streamPhase: String = "starting"
    /// Captured error from didStopWithError during the startup
    /// window. openStream polls this after startCapture returns to
    /// detect post-success daemon rejections (the -3805 case).
    private var streamStartError: Error?

    func start(req: StartRequest) async {
        diag("start() called displayId=\(req.displayId) rect=\(req.rect.x),\(req.rect.y) \(req.rect.w)x\(req.rect.h) captureAtMs=\(req.captureAtMs ?? -1) excludePids=\(req.excludePids ?? [])")
        outputURL = URL(fileURLWithPath: req.outputPath)
        // Defensive cleanup — overwrite any stale file at the path
        // (recorder picks a unique tmp path per session normally).
        try? FileManager.default.removeItem(at: outputURL!)

        // Prime the SCShareableContent cache early — first call is
        // the slow one (3-5s on cold launch, < 100ms once cached).
        // We do this BEFORE the captureAtMs sleep so the cold cost
        // overlaps with the visible countdown. The actual filter +
        // stream are built AFTER the sleep against a FRESH
        // SCShareableContent (see below) because the
        // SCRunningApplication references in the first snapshot
        // can be invalidated by the time we sleep through 3
        // seconds of countdown — the daemon then rejects the
        // stream-start with -3805 "application connection
        // interrupted". Re-querying right before startCapture
        // gives us a guaranteed-fresh list.
        diag("priming SCShareableContent")
        do {
            let primed = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: false)
            diag("primed: \(primed.displays.count) display(s), \(primed.applications.count) app(s)")
            for d in primed.displays {
                diag("  display id=\(d.displayID) size=\(d.width)x\(d.height)")
            }
        } catch {
            emitError("shareable_content_failed", "\(error)")
            return
        }

        let excludePids = Set(req.excludePids ?? [Int(getppid())])

        // sourceRect crops the captured frame to the user's rectangle
        // before encoding — cheaper than recording the whole screen
        // and trimming downstream.
        let cfg = SCStreamConfiguration()
        cfg.width = req.rect.w
        cfg.height = req.rect.h
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 60) // 60fps cap
        cfg.queueDepth = 5
        cfg.showsCursor = true
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.scalesToFit = false
        cfg.sourceRect = CGRect(
            x: CGFloat(req.rect.x),
            y: CGFloat(req.rect.y),
            width: CGFloat(req.rect.w),
            height: CGFloat(req.rect.h)
        )
        if req.systemAudio {
            cfg.capturesAudio = true
            cfg.sampleRate = 48_000
            cfg.channelCount = 2
            cfg.excludesCurrentProcessAudio = true
            hasSystemAudio = true
        }

        // NOTE: SCStream construction + addStreamOutput is DEFERRED
        // until after the captureAtMs sleep below. Creating the
        // stream now and then idling for 1–3s during the countdown
        // appears to let the ScreenCaptureKit daemon decide we've
        // abandoned the stream, then tear down the XPC connection
        // — surfacing as `SCStreamErrorDomain Code=-3805 "Failed
        // during stream due to application connection being
        // interrupted"` the instant we call startCapture. Building
        // the stream right before startCapture avoids the idle
        // window.

        // AVAssetWriter — H.264 video, AAC audio.
        let writer: AVAssetWriter
        do {
            writer = try AVAssetWriter(outputURL: outputURL!, fileType: .mp4)
        } catch {
            emitError("writer_init_failed", "\(error)")
            return
        }
        // shouldOptimizeForNetworkUse → write the moov atom at the
        // START of the file (the AVFoundation equivalent of ffmpeg's
        // `-movflags +faststart`). Without this, the moov lands at
        // the END of the file and `<video src=pwrsnap-capture://…>`
        // can't initialize playback without a full file scan — the
        // float-over and Library Focus pane both stay stuck on the
        // loading spinner.
        writer.shouldOptimizeForNetworkUse = true
        assetWriter = writer

        let videoSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: req.rect.w,
            AVVideoHeightKey: req.rect.h,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 8_000_000,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoMaxKeyFrameIntervalKey: 60
            ]
        ]
        let vi = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        vi.expectsMediaDataInRealTime = true
        if writer.canAdd(vi) { writer.add(vi) }
        videoInput = vi

        if req.systemAudio {
            let audioSettings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVNumberOfChannelsKey: 2,
                AVSampleRateKey: 48_000,
                AVEncoderBitRateKey: 192_000
            ]
            let ai = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
            ai.expectsMediaDataInRealTime = true
            if writer.canAdd(ai) { writer.add(ai) }
            audioInput = ai
        }

        if req.microphone {
            // Microphone capture goes through AVCaptureSession; the
            // samples land in the same AVAssetWriter as a second audio
            // track if the user wants both.
            let micSettings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVNumberOfChannelsKey: 1,
                AVSampleRateKey: 48_000,
                AVEncoderBitRateKey: 128_000
            ]
            let mi = AVAssetWriterInput(mediaType: .audio, outputSettings: micSettings)
            mi.expectsMediaDataInRealTime = true
            if writer.canAdd(mi) { writer.add(mi) }
            micInput = mi
            await setUpMicrophoneCapture(into: mi)
            hasMicrophoneAudio = true
        }

        // Sleep until the requested wall-clock capture time. The TS
        // side runs the visible countdown in parallel with our
        // (possibly slow) setup above; honoring captureAtMs aligns
        // the recorder's first frame with the visual "0" mark and
        // hides cold-launch latency. If we're already past the
        // target time (setup took longer than the countdown), skip
        // the sleep and start immediately — TS shows a "Starting…"
        // indicator while it waits for our `started` event.
        if let captureAtMs = req.captureAtMs {
            let nowMs = Date().timeIntervalSince1970 * 1000.0
            let waitMs = captureAtMs - nowMs
            diag("countdown sleep \(Int(waitMs))ms")
            if waitMs > 0 {
                try? await Task.sleep(nanoseconds: UInt64(waitMs * 1_000_000.0))
            }
        }

        // Re-fetch SCShareableContent and build the filter/stream
        // NOW (post-sleep). The cache was primed before the sleep
        // so this second call is < 100ms. Two reasons we rebuild
        // here instead of carrying the original snapshot through:
        //
        //  1) SCRunningApplication references in a 3-second-old
        //     SCShareableContent can be invalidated by the daemon
        //     (apps started/stopped during the countdown), and the
        //     stale refs in our SCContentFilter caused -3805
        //     "application connection interrupted" failures at
        //     startCapture time.
        //  2) The daemon also doesn't appreciate seeing an SCStream
        //     created and then sitting idle for 1–3s while we
        //     sleep. Building the stream right before startCapture
        //     avoids the idle window.
        //
        // We also do a single-shot retry with an EMPTY exclusion
        // list on -3805 — better to ship the recording with our
        // HUD visible than to fail entirely. (The HUD is small and
        // top-of-screen by default; a captured frame with it is
        // still useful.)
        diag("refetching SCShareableContent (post-sleep)")
        let freshDisplays: SCShareableContent
        do {
            freshDisplays = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: false)
        } catch {
            diag("SHARE-REFRESH-FAILED: \(error)")
            emitError("shareable_content_refresh_failed", "\(error)")
            return
        }
        diag("fresh: \(freshDisplays.displays.count) display(s), \(freshDisplays.applications.count) app(s)")
        for d in freshDisplays.displays {
            diag("  display id=\(d.displayID) size=\(d.width)x\(d.height) matchesReq=\(d.displayID == req.displayId)")
        }
        let matched = freshDisplays.displays.first(where: { $0.displayID == req.displayId })
        guard let display = matched ?? freshDisplays.displays.first else {
            emitError("no_display", "no display matched id \(req.displayId)")
            return
        }
        diag("using display id=\(display.displayID) (matchedRequested=\(matched != nil))")

        let started = await openStream(
            display: display,
            applications: freshDisplays.applications,
            excludePids: excludePids,
            cfg: cfg
        )
        diag("openStream attempt 1 returned \(started)")
        if started {
            startedAtWallClock = Date()
            emit([
                "event": "started",
                "physicalRect": [
                    "x": req.rect.x, "y": req.rect.y,
                    "w": req.rect.w, "h": req.rect.h
                ]
            ])
            return
        }

        // Fallback: retry once with no exclusion list. If the
        // daemon rejected us because of stale SCRunningApplication
        // refs in the filter, a no-exclusion filter sidesteps that
        // entirely. The HUD will appear in the recorded frame —
        // not ideal, but vastly better than the recording failing
        // outright.
        FileHandle.standardError.write(
            "[recorder] retrying with empty exclusion list after -3805\n"
                .data(using: .utf8)!
        )
        let retried = await openStream(
            display: display,
            applications: freshDisplays.applications,
            excludePids: [],
            cfg: cfg
        )
        diag("openStream attempt 2 returned \(retried)")
        if retried {
            startedAtWallClock = Date()
            emit([
                "event": "started",
                "physicalRect": [
                    "x": req.rect.x, "y": req.rect.y,
                    "w": req.rect.w, "h": req.rect.h
                ]
            ])
        } else {
            // Both attempts failed. openStream emitted the error
            // for non-3805 cases; for -3805 specifically (which
            // didn't trigger an emit), surface a final error here
            // so TS doesn't hang on startedPromise.
            emitError(
                "start_capture_failed",
                "ScreenCaptureKit rejected the stream with -3805 twice. Try restarting PwrSnap; if it persists, restart the Mac."
            )
        }
    }

    /**
     * Build the SCContentFilter from `applications` (filtered by
     * `excludePids`), create the SCStream, add outputs, and call
     * startCapture. Returns `true` on success, `false` if the
     * daemon rejected the stream with -3805 (caller retries),
     * and emits a fatal error + returns false on any other
     * failure.
     *
     * Handles two -3805 surfacing paths:
     *  1. startCapture throws synchronously with the error.
     *  2. startCapture succeeds, but didStopWithError fires
     *     asynchronously a few ms later (delegate-side rejection).
     *     We park for ~200ms post-startCapture to give the daemon
     *     time to surface this, then check `streamStartError`.
     */
    @available(macOS 13.0, *)
    private func openStream(
        display: SCDisplay,
        applications: [SCRunningApplication],
        excludePids: Set<Int>,
        cfg: SCStreamConfiguration
    ) async -> Bool {
        diag("openStream entered displayId=\(display.displayID) excludePids=\(excludePids.sorted())")
        // Reset per-attempt state. The delegate uses streamPhase to
        // decide whether to capture or forward errors, so this MUST
        // be reset before we touch SCStream.
        streamPhase = "starting"
        streamStartError = nil

        let excludedApps = applications.filter { excludePids.contains(Int($0.processID)) }
        diag("filter built: \(excludedApps.count) app(s) excluded")
        let filter = SCContentFilter(
            display: display,
            excludingApplications: excludedApps,
            exceptingWindows: []
        )
        diag("creating SCStream")
        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        diag("SCStream created, adding outputs")
        do {
            try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: writeQueue)
            if cfg.capturesAudio {
                try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: writeQueue)
            }
        } catch {
            diag("addStreamOutput failed: \(error)")
            emitError("add_output_failed", "\(error)")
            return false
        }
        stream = s
        diag("outputs added, calling startCapture")

        do {
            try await s.startCapture()
            diag("startCapture returned successfully")
        } catch let err as NSError {
            diag("startCapture threw: \(err.domain) code=\(err.code)")
            if isApplicationConnectionInterruptedError(err) {
                diag("→ -3805, signaling retry")
                stream = nil
                return false
            }
            emitError("start_capture_failed", "\(err)")
            return false
        }

        // Wait briefly for didStopWithError to potentially fire.
        diag("settle window 250ms")
        try? await Task.sleep(nanoseconds: 250_000_000)

        if let err = streamStartError as NSError? {
            diag("delegate fired during settle: \(err.domain) code=\(err.code)")
            streamStartError = nil
            stream = nil
            if isApplicationConnectionInterruptedError(err) {
                diag("→ -3805, signaling retry")
                return false
            }
            emitError("start_capture_failed", "\(err)")
            return false
        }

        diag("settle window clean, transitioning to active")
        streamPhase = "active"
        return true
    }

    private func isApplicationConnectionInterruptedError(_ err: NSError) -> Bool {
        return err.domain == "com.apple.ScreenCaptureKit.SCStreamErrorDomain" && err.code == -3805
    }

    private func setUpMicrophoneCapture(into input: AVAssetWriterInput) async {
        let session = AVCaptureSession()
        session.sessionPreset = .high
        guard let device = AVCaptureDevice.default(for: .audio),
              let micInputDevice = try? AVCaptureDeviceInput(device: device) else {
            return
        }
        if session.canAddInput(micInputDevice) { session.addInput(micInputDevice) }
        let micOutput = AVCaptureAudioDataOutput()
        if session.canAddOutput(micOutput) { session.addOutput(micOutput) }
        micOutput.setSampleBufferDelegate(MicForwarder(input: input), queue: writeQueue)
        session.startRunning()
        micSession = session
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer buf: CMSampleBuffer, of type: SCStreamOutputType) {
        // Per-type counter BEFORE the ready/writer guards so we can
        // tell "samples never reached the delegate" (counter at 0)
        // apart from "samples reached us but were dropped" (counter
        // > 0, append count = 0).
        switch type {
        case .screen: videoSamplesReceived += 1
        case .audio: audioSamplesReceived += 1
        case .microphone:
            // SCStream's microphone output type (macOS 14+) is unused
            // here — mic capture goes through AVCaptureSession in
            // setUpMicrophoneCapture(). Counted distinctly so future
            // mic-via-SCStream work is visible in the diag totals.
            microphoneSamplesReceived += 1
        @unknown default: break
        }
        guard CMSampleBufferDataIsReady(buf) else { return }
        guard let writer = assetWriter else { return }

        // SCStream emits FOUR kinds of screen samples and we only
        // want one of them. The status lives in an attachment under
        // SCStreamFrameInfo.status:
        //
        //   .complete  → a real frame with image data. APPEND.
        //   .idle      → the screen didn't change since the last
        //                frame; the buffer has no pixels. SKIP.
        //   .blank     → display blanked/sleeping. SKIP.
        //   .suspended → stream suspended. SKIP.
        //   .started/.stopped → lifecycle markers. SKIP.
        //
        // Why this matters: idle/marker samples still pass
        // CMSampleBufferDataIsReady (they have format descriptions),
        // but feeding them to the H.264 AVAssetWriterInput corrupts
        // the encoder pipeline. We saw 707 samples received, the
        // first 4 appended successfully, then the writer flipped to
        // .failed with "operation could not be completed" — the
        // signature of the encoder choking on a non-image sample
        // a few frames in. Apple's ScreenCaptureKit sample code
        // (`SCContentSharingPickerSample` etc.) does this same gate;
        // we have to as well.
        //
        // Audio samples have no status attachment — append directly.
        if type == .screen {
            guard let attachments = CMSampleBufferGetSampleAttachmentsArray(
                buf, createIfNecessary: false
            ) as? [[SCStreamFrameInfo: Any]],
                  let attachment = attachments.first,
                  let statusRaw = attachment[.status] as? Int,
                  let frameStatus = SCFrameStatus(rawValue: statusRaw),
                  frameStatus == .complete else {
                return
            }
        }

        if !firstSampleWritten {
            // Use the FIRST .complete frame's PTS as the session
            // start. (The screen guard above ensures we never enter
            // here on a non-.complete screen sample; an audio sample
            // arriving first is fine — audio PTS is on the same
            // host-clock timebase as video PTS in SCStream.)
            startedAtCMTime = CMSampleBufferGetPresentationTimeStamp(buf)
            let ok = writer.startWriting()
            diag("first sample: type=\(type) startWriting()->\(ok) writer.status=\(writer.status.rawValue) error=\(writer.error?.localizedDescription ?? "nil")")
            writer.startSession(atSourceTime: startedAtCMTime)
            firstSampleWritten = true
        }

        switch type {
        case .screen:
            if let vi = videoInput, vi.isReadyForMoreMediaData {
                if vi.append(buf) {
                    videoSamplesAppended += 1
                } else {
                    // Append failure usually means the writer
                    // transitioned to .failed; surface the cause
                    // once so we can diagnose without grepping.
                    if videoSamplesAppended < 10 || videoSamplesAppended % 100 == 0 {
                        diag("video append failed: writer.status=\(writer.status.rawValue) error=\((writer.error as NSError?)?.code ?? 0) \(writer.error?.localizedDescription ?? "nil")")
                    }
                }
            }
        case .audio:
            if let ai = audioInput, ai.isReadyForMoreMediaData {
                if ai.append(buf) { audioSamplesAppended += 1 }
            }
        case .microphone:
            // Mic samples from SCStream (macOS 14+) are deliberately
            // ignored — see microphoneSamplesReceived for why. If we
            // ever consolidate mic capture into SCStream, route the
            // append here. Until then dropping is correct.
            break
        @unknown default:
            break
        }
    }

    func stop() async {
        diag("stop() entered videoSamples=\(videoSamplesReceived)/\(videoSamplesAppended) audioSamples=\(audioSamplesReceived)/\(audioSamplesAppended) microphoneSamples=\(microphoneSamplesReceived) firstSampleWritten=\(firstSampleWritten)")
        guard let s = stream, let writer = assetWriter else {
            diag("stop() guard failed: stream=\(stream != nil) writer=\(assetWriter != nil)")
            return
        }
        do {
            try await s.stopCapture()
            diag("stopCapture() returned")
        } catch {
            diag("stopCapture() threw: \(error) — continuing to finalize")
        }
        micSession?.stopRunning()

        videoInput?.markAsFinished()
        audioInput?.markAsFinished()
        micInput?.markAsFinished()

        diag("writer.status pre-finish=\(writer.status.rawValue) error=\(writer.error?.localizedDescription ?? "nil")")
        await writer.finishWriting()
        diag("writer.status post-finish=\(writer.status.rawValue) error=\(writer.error?.localizedDescription ?? "nil")")

        // Check on-disk size for the diag log so a 0-byte failure
        // surfaces in the recorder's own logs, not just downstream.
        let onDiskSize: Int = {
            guard let path = outputURL?.path else { return -1 }
            return (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int) ?? -1
        }()
        diag("output file size=\(onDiskSize) bytes")

        let durationSec = Date().timeIntervalSince(startedAtWallClock)
        emit([
            "event": "stopped",
            "durationSec": durationSec,
            "containerFormat": "mp4",
            "hasSystemAudio": hasSystemAudio,
            "hasMicrophoneAudio": hasMicrophoneAudio,
            "outputPath": outputURL?.path ?? ""
        ])
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        let nserr = error as NSError
        diag("didStopWithError: phase=\(streamPhase) domain=\(nserr.domain) code=\(nserr.code)")
        // If the delegate fires during the openStream startup
        // window (BEFORE we've emitted "started" to TS), capture
        // the error so openStream can decide whether to retry or
        // surface it. Forwarding to TS at this point would race
        // openStream's own success/retry path.
        if streamPhase == "starting" {
            streamStartError = error
            return
        }
        emitError("stream_stopped", "\(error)")
    }
}

@available(macOS 13.0, *)
final class MicForwarder: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    let input: AVAssetWriterInput
    init(input: AVAssetWriterInput) { self.input = input }
    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        if input.isReadyForMoreMediaData { input.append(sampleBuffer) }
    }
}

// MARK: - Parent-death watchdog
//
// If Electron exits unexpectedly (crash, ⌘Q without proper teardown,
// SIGKILL) we don't want to be orphaned to launchd and keep recording
// forever. getppid() returns 1 the moment our parent dies and we get
// reparented to launchd; poll once a second and stop ourselves
// cleanly the instant that happens. Cleaner than relying on the
// caller to always SIGTERM us — Electron's main process can die
// in ways that don't run its `will-quit` handler at all.

@available(macOS 13.0, *)
func startParentWatchdog(_ recorder: Recorder) {
    let originalParent = getppid()
    Task.detached {
        while true {
            try? await Task.sleep(nanoseconds: 1_000_000_000) // 1s
            let current = getppid()
            // launchd is always pid 1; any change away from the
            // recorded original parent means our parent died and
            // we got reparented.
            if current != originalParent || current == 1 {
                FileHandle.standardError.write(
                    "[recorder] parent process gone (was \(originalParent), now \(current)) — stopping\n"
                        .data(using: .utf8)!
                )
                await recorder.stop()
                exit(0)
            }
        }
    }
}

// MARK: - Main loop

if #available(macOS 13.0, *) {
    let recorder = Recorder()
    startParentWatchdog(recorder)
    let handle = FileHandle.standardInput
    handle.waitForDataInBackgroundAndNotify()
    let center = NotificationCenter.default
    var inboundBuffer = Data()
    var observer: NSObjectProtocol? = nil
    observer = center.addObserver(forName: .NSFileHandleDataAvailable, object: handle, queue: nil) { _ in
        let data = handle.availableData
        if data.isEmpty {
            CFRunLoopStop(CFRunLoopGetCurrent())
            return
        }
        inboundBuffer.append(data)
        while let nl = inboundBuffer.firstIndex(of: 0x0A) {
            let line = inboundBuffer[..<nl]
            inboundBuffer.removeSubrange(...nl)
            guard !line.isEmpty else { continue }
            do {
                let cmd = try JSONDecoder().decode(Inbound.self, from: Data(line))
                switch cmd {
                case .start(let req):
                    Task { await recorder.start(req: req) }
                case .stop:
                    Task {
                        await recorder.stop()
                        // exit(0), NOT CFRunLoopStop(CFRunLoopGetCurrent()).
                        // A Task body runs on Swift's concurrency executor —
                        // some worker thread, not main — so
                        // CFRunLoopGetCurrent() returns that worker's run
                        // loop. Stopping it does nothing to the main thread,
                        // which keeps spinning CFRunLoopRunInMode and the
                        // process leaks. A leaked recorder keeps its
                        // SCStream attached to the ScreenCaptureKit daemon;
                        // the NEXT recording in the same PID then trips
                        // -3805 on both the stale stream AND the new one
                        // (the daemon revokes the previous "application
                        // connection" the instant a new stream registers,
                        // and the new stream sees the daemon-side state
                        // corruption as a startup rejection). exit(0)
                        // doesn't care which thread it's called from.
                        exit(0)
                    }
                }
            } catch {
                emitError("decode", "\(error)")
            }
        }
        handle.waitForDataInBackgroundAndNotify()
    }
    _ = observer
    while CFRunLoopRunInMode(.defaultMode, 86_400, false) == .timedOut { }
} else {
    emitError("unsupported_macos", "PwrSnap recorder requires macOS 13 or newer.")
    exit(1)
}
