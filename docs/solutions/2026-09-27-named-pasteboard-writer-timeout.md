# Bound the named-image pasteboard writer

This records clipboard incident evidence and the containment added to PwrSnap.
It does not identify the cause of the macOS pasteboard service stall.

## Observations

The operator reported that pasting a PwrSnap image into PwrAgent and Claude
left both applications and remote desktop unresponsive, although SSH still
worked and an image had appeared. Resetting the desktop user’s `pboard`
restored responsiveness. The original blocked stacks were not captured.

The separate machine investigation reported the following preserved evidence
on 2026-09-27 (times EDT):

- macOS 26.6.2 (25G83), PwrSnap 1.1.7 and PwrAgent 1.1.1 using Electron
  41.10.7, Claude 2.9939.2 using Electron 44.4.3, and Splashtop 3.8.6.0.
- A 2880×1920 capture reused a 516,524-byte PNG. Two named-image helper
  failures were logged at 11:30:51, immediately followed by Electron fallback
  successes, around the replacement pasteboard service’s startup.
- Unified logs showed helper pasteboard connections lasting approximately
  23m54s, 4m33s, and 4m11s before reconnecting at that reset. These establish
  long-lived helpers, not the precise blocked call. Truncated application
  errors did not preserve their original exit codes or stderr.
- Splashtop’s last process start was part of approximately 42-second automatic
  relaunch cycles (35 cycles in the queried interval), not evidence of a user
  restart. The final process remained after pasteboard recovery. This does not
  establish whether Splashtop initiated or suffered from the blockage.
- Claude recorded a 170,358 ms main-process stall. Its heuristic sleep label
  does not establish causation.
- A bounded synthetic 2880×1920 shipped-helper probe completed: writer 33 ms,
  PNG read 12 ms, TIFF read 49 ms (about 16.6 MB). The cached incident PNG also
  completed: writer 13 ms, PNG read 10 ms, TIFF read 36 ms. Neither needed the
  independent recovery watchdog to reset the pasteboard.

Those probes did not reproduce the original multi-application/remote clipboard
synchronization sequence. Successful isolated reads neither rule out PwrSnap
nor establish a Splashtop, image-conversion, or owner-lifetime defect.

## Production path audit

The named writer, its TypeScript wrapper, and clipboard handlers were unchanged
between `v1.1.7` and investigation base `4dca8f5a`.

| Copy surface | Production boundary on macOS | Relevant behavior |
| --- | --- | --- |
| Tray, float-over, library image presets, image preset shortcuts | `clipboard:copy` → `writeNamedPngToPasteboard` | One-shot `PwrSnapPasteboardWriter`; eagerly writes PNG, file URL, and small private diagnostics marker. Electron image write is fallback. |
| Editor selected-layer copy | `clipboard:copyLayerFragment` → `writeMultiFormatClipboard` | `PwrSnapWindowList --write-clipboard`; eager private fragment and PNG via `declareTypes(owner: nil)` and `setData`; existing 10-second kill followed by Electron private-buffer fallback. |
| Image/video file copy | `clipboard:copy-file`, `clipboard:copyVideoFile` → `writeFileToClipboard` | Electron file-URL write and synchronous readback. |
| Image/video path and ordinary text copy | `clipboard:copy-path`, `clipboard:copyVideoPath`, `clipboard:copyText` | Electron text write. Chat message and CPU-profile text also have renderer text-clipboard calls. |

Capture persistence does not introduce another direct image writer. Main-side
float-over shortcuts use the same shared image-preset command. Drag preparation
exports a file for drag-and-drop, not an additional general-pasteboard copy.

Neither Swift image writer registers a lazy data provider. The named helper
constructs an `NSPasteboardItem` with eager data, clears the general pasteboard,
and writes that item directly; it does not transfer from a named pasteboard.
It then queries types/items before exiting. Which of these calls blocked in the
incident is unknown. Neither writer eagerly publishes TIFF; successful native
TIFF reads in the probes demonstrate conversion in those probe conditions only.

## Containment

Previously the named writer used `execFile` with no deadline. Multiple copies
could leave multiple children outstanding indefinitely. All helper failures
fell through to synchronous Electron clipboard writes in the main process.

The wrapper now terminates a stalled child with `SIGKILL` after 10 seconds and
waits for the child-process completion callback. A timeout propagates through
the alias/setup layer as `clipboard_timeout`, without an Electron fallback or
clipboard-change notification. A subsequent user copy remains available.
Unavailable helpers and ordinary nonzero exits retain the existing fallback.
Diagnostics record helper PID, elapsed milliseconds, timeout status, exit code,
and signal without logging command arguments, image bytes, or clipboard data.

This does not reset `pboard`, change published formats, serialize concurrent
copies, or make every clipboard API asynchronous. The layer-copy fallback,
file/text operations, clipboard reads, and a stall that begins after a
successful helper write remain outside this focused change.

## Regression evidence

A real fake child ignores `SIGTERM` and waits without using the system
clipboard. The regression asserts the production deadline kills it and rejects
instead of requesting fallback; an independent test watchdog also bounds the
pre-fix run. A handler regression asserts no Electron write or changed event
occurs on timeout, then verifies a later copy succeeds.

Both regressions failed with the original production source (26 other tests
passed). The fixed full unit suite passed 7,141 tests; lint and build passed.
The clipboard E2E addition uses fresh, separately bounded AppKit reader
processes after normal one-shot writers exit. Its run result belongs in the PR.
