# Synthetic AAC round trip blocked on microphone permission

The native microphone round-trip test timed out after 30 seconds with an
empty stdout/stderr report. Both the full suite and the isolated test failed
on macOS 26.6.2 with Swift 6.2.3. Compilation succeeded.

## Cause and evidence

The production `MicForwarder` appended all 48 synthetic tone buffers. The
tone writer and the four-buffer silent writer both finished successfully.
The blocked operation was **`AVAssetReader.startReading()`**, not
`AVAssetWriter.finishWriting()`.

A read-only process sample showed this stack:

```text
AVAssetReader.startReading
AVAssetReaderTrackOutput._enableTrackExtractionReturningError
FigAudioQueueRenderPipelineCreate
AudioQueueObject.DoIONodeConnect
AQMEIO_HAL.SelectDevice
AudioDeviceCreateIOProcID_mac_imp
HALC_ProxyObject.SetPropertyData
mach_msg2_trap
```

The operator found a system microphone permission prompt and approved it.
The unchanged original fixture then passed 20 consecutive runs. Explicit
PCM sample-rate/channel settings, a detached decode task, and a
production-style main run loop had all still timed out before approval.
Those experiments did not fix the problem.

The PCM reader's AudioQueue pipeline was initializing hardware IO even
though the fixture supplied synthetic samples and opened no capture device.
The prompt explains why the apparent host stall disappeared after approval.
There is no evidence of a production microphone forwarding or AAC encoding
failure. An independent FFmpeg decode also recovered 49,152 samples with
RMS 0.212 from the original encoded file.

## Fix and regression

The fixture keeps the production forwarder and real AVFoundation AAC writer.
It now decodes the MP4 with `AVAudioFile` into Float32 PCM, without an audio
engine or device. Track count, sample count, amplitude, clip duration,
pre-roll/post-finish behavior, and silence detection remain checked. The
30-second native process deadline remains unchanged.

The test-only `tests/no-device-io.c` dylib interposes both
`AudioDeviceCreateIOProcID` and `AudioDeviceCreateIOProcIDWithBlock`. Either
call exits immediately with an explicit diagnostic before reaching hardware.
A probe using an invalid device verifies both interceptors; the test also
requires the guard's load message. This works even when the operator already
has a TCC microphone grant, so that grant cannot hide a regression.

With this guard, the original fixture exits 97 on hardware IO initialization;
the offline decoder passes 20 consecutive runs, recovering 49,152 samples,
RMS 0.212, and duration 1.024 seconds. The dylib is compiled in the test's
temporary directory, injected only into its children, and never shipped.

Native stages go directly to stderr. The JavaScript harness includes those
stages and exit/signal/killed fields in its failure message before cleaning
up. A bounded stalled-child test verifies that timeout diagnostics survive.

Do not resolve this synthetic test by pre-granting microphone access,
resetting TCC, changing audio devices, skipping the round trip, or extending
its timeout. Genuine capture tests need their own explicit device/TCC
contract; this file-only test must stay independent of it.
