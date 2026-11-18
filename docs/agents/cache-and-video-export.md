# Agent rules: Render cache, cache deletion and video export

This file holds rules that used to live in the root
[AGENTS.md](../../AGENTS.md), moved here verbatim so the root file stays
under Codex's 32 KiB project-doc cap. The root keeps a one-line summary of
each section below and says when to read this file. The rules here bind
exactly as they did there. A reference to a section that is not in this file
("see Workflow above", a heading quoted in a code comment) means the root
AGENTS.md or one of the other files in `docs/agents/`.

## Bake render cache — orphans are tolerated, not swept

Content-addressed cache; `BAKE_PIPELINE_VERSION` is in the hash, so a
bump orphans existing files. We do NOT auto-sweep — see
[docs/solutions/2026-05-28-bake-render-cache-orphans.md](../../docs/solutions/2026-05-28-bake-render-cache-orphans.md)
for rationale, when-to-bump rules, and the adjacent-code map.

## Every deleter of `<cacheRoot>` goes through the admission gate

**Nothing may `rm` inside `<cacheRoot>` without first taking
`withDerivedCacheCleanup`, and the five per-capture derived-video lanes —
the playback rendition, the waveform asset, the contact strip, the
poster frame and the activity track — must publish inside
`runGatedCacheWrite`.** Owner:
[derived-cache-gate.ts](../../apps/desktop/src/main/persistence/derived-cache-gate.ts).

The deleter half is absolute; the writer half is scoped, and the module
header says exactly which lanes are in and which are deliberately out
(MP4/GIF exports carry their own cancellation — a background trim must not
kill a user's export; render bakes re-derive in milliseconds, so an orphan
there is cheap). **A new writer that spends seconds under `<cacheRoot>` and
publishes by `rename` belongs behind the gate.**

The writers publish through a staging file and a final `rename`
([`publishMedia`](../../apps/desktop/src/main/sizzle/audio-extract.ts)). The
deleters `rm -rf` whole directories underneath them. Ungated, the
`rename` lands after the `rm -rf` and recreates the tree it was just
deleted from: purging a capture mid-remux left an orphaned
`<cacheRoot>/video/<deleted-id>/playback-*.mp4` that nothing would ever
collect — the capture row is gone, so no later `purgeCacheForCapture`
for that id can run — and "Clear cache" during preparation did not
clear, reporting a `clearedBytes` short by a whole recording.

The in-flight maps are not a substitute. They coalesce DUPLICATE WORK
and have no idea a deletion happened.

Six things that bite:

- **Both sides must register SYNCHRONOUSLY, before their first `await`.**
  A write registered in the gap after a cleanup's check runs against a
  directory the cleanup is about to remove. That is why
  `runGatedCacheWrite` takes a callback rather than a promise — by the
  time a caller could hand you a promise, it has already started.
- **Abort is not enough; you must DRAIN.** An aborted ffmpeg still holds
  its staging file open when `abort()` returns. The gate aborts, waits
  for every matching write to settle, and only then runs the cleanup —
  with admission still closed for the whole of it.
- **Cleanups serialize with each other.** Clear/Trim walk the whole root
  and a purge walks part of it, so two at once race an `rm -rf` against
  a `readdir` that already listed the entries. The chain is a
  `.catch`-ed tail so one failure does not poison every later cleanup.
- **Background migration queues new video requests.** It takes the same
  gate with `writeAdmission: "wait"`, so requests resume after migration
  settles instead of returning a terminal cancellation to a view that will
  not retry. Caller cancellation still removes the wait. Clear/Trim/purge
  retain default rejection and cancel matching queued requests as well as
  active writes; a queued request must never replay after deletion.
- **The drain is bounded, and re-entry is refused.** Without a bound, one
  write that never settles leaves admission closed and `cleanupTail`
  pending for the life of the process — every later write rejected, every
  later cleanup queued behind a promise that never resolves. And a cleanup
  callback that calls another gated cleanup would await a tail it is itself
  holding; that is caught by an `AsyncLocalStorage` marker, which (unlike a
  boolean) can tell a NESTED call from a merely concurrent one that should
  queue.
- **Split mode has no shared event loop to save you.** `video:*` is
  agent-owned and `storage:*` / `library:purge` are reached from the
  library, so the library forwards the whole operation over
  `storage:runCacheCleanup` and awaits it. Forwarding the OPERATION, not
  a cancellation, is deliberate: a "stop writing" message needs a lease
  with a release, and a crashed library never sends one. A library with
  no forwarder **fails closed** — not cleaning is safe, cleaning locally
  is the bug.

Pinned by
[derived-cache-gate.test.ts](../../apps/desktop/src/main/persistence/__tests__/derived-cache-gate.test.ts)
(the ordering) and
[derived-cache-cleanup-wiring.test.ts](../../apps/desktop/src/main/persistence/__tests__/derived-cache-cleanup-wiring.test.ts)
(that the three real deleters actually call it — the regression a fourth
deleter added later would otherwise ship silently).

## An MP4 with no audio choice gets the user's, never "every track"

**Every MP4 export resolves its audio through `resolveExportAudio`
([mp4-export-audio.ts](../../apps/desktop/src/main/recording/mp4-export-audio.ts)).
An omitted `audio` means the saved `recording.mp4IncludeMicrophone` /
`mp4IncludeSystemAudio` preference, narrowed to the tracks the take has,
and an unreadable preference means SILENT.** Pinned by
[mp4-export-audio.test.ts](../../apps/desktop/src/main/recording/__tests__/mp4-export-audio.test.ts)
and the `video:export` cases in
[recording-handlers-bus.test.ts](../../apps/desktop/src/main/handlers/__tests__/recording-handlers-bus.test.ts).

The MP4 row of every video export grid has Mic / System toggles, and they
exist because people forget the mic was on and send the take anyway. The
grid sends its choice explicitly on export, copy, path copy and drag. But
the tray's and the Library grid's ⌘4–⌘6 shortcuts dispatch
`clipboard:copyVideoFile` with no `audio`, and so can an HTTP/MCP caller.
Before this rule, omitted meant every recorded track, so a mic switched
off on the grid still shipped from a keystroke.

- **A new export verb, or a new caller of `exportVideoRange`, goes
  through `resolveExportAudio`.** Do not restate a default inline. Two
  copies of it had already drifted before this rule existed.
- **`recording.includeMicrophone` is not the export toggle.** It decides
  what a new recording CAPTURES. `mp4Include*` decides what an export
  KEEPS. The toggles default ON because recording audio is already
  opt-in, so any track that exists is one the user asked for.
- **An audio change cancels in-flight runs** (`useVideoExportPresets`
  keys its reset on it, the same way it does on the trim range). An
  encode started with the mic on must not finish onto the clipboard after
  the user switched it off.
- **The drag bridge refuses a malformed `audio`** rather than treating it
  as omitted (`parseVideoDragRequest` in `ipc.ts`). A malformed range
  still falls back to the default range.
