# PwrSnap architecture and direction

The durable decisions — what PwrSnap is, and the shape choices that are
still true. It replaces the historical phase plans that used to live in
`docs/plans/` (pruned 2026-09-03); it deliberately carries **no** task
lists, phase order, or status tracking. Those belong in issues and PRs.

- **Enforcement rules** (the things a change can violate) live in
  [AGENTS.md](../AGENTS.md). This file explains *why*; AGENTS.md says
  *what you must not break*.
- **Post-incident notes** live in [docs/solutions/](solutions/).
- **Shipped-behavior docs** live beside this file — the
  [bundle format spec](architecture-bundle-format.md),
  [release runbook](desktop-release-runbook.md),
  [Windows guide](windows/README.md),
  [Windows port status](windows/port-status.md),
  [Windows signing](desktop-windows-signing.md),
  [ffmpeg builds](ffmpeg-build-reference.md),
  [third-party notices](third-party-license-notices.md),
  [third-party agents over MCP](mcp-third-party-agents.md).

## What PwrSnap is

A capture, annotate, and share tool that replaces SnagIt — ships on macOS
and Windows, MIT licensed, from PwrDrvr LLC.

The founding complaints it exists to answer: SnagIt's subscription pricing,
its sluggish region selector over remote desktop, its hand-tuned arrows that
look like needles on retina captures, a history browser that loses your place
when you edit, no AI, and a separate $300 product for video.

The shortest goal it is measured against is unchanged: **⌘⇧C → screenshot →
clipboard → paste into Slack.** Everything else is layered on top of that
path staying instant.

Two things it is **not**:

- **Not an image editor.** PwrSnap is an annotator. The layer model is
  plumbing that makes annotations composable and machine-writable — it is
  not an invitation to build Photoshop. New surface that only makes sense
  to someone editing images, rather than someone marking up a screenshot,
  is out of scope by default.
- **Not an AI product with a capture feature.** AI is a second user of the
  same primitives a human uses. An AI-placed arrow is an ordinary arrow that
  happens to carry `source: "ai"`.

## Storage: data, not pixels

The source raster is immutable. Every annotation is structured data, and the
composite is rendered on demand and cached, keyed by content.

This is the single decision the most code depends on. It is what makes
per-annotation undo a delete rather than a frame reconstruction, keeps one
raster on disk instead of two, lets AI propose an annotation as data the
user can accept or reject, and keeps OCR and search running against
unredacted pixels while the user sees the redacted composite.

The *shape* of that data has changed and will change again — the original
flat `overlays` SQLite table is gone, replaced by the v2 layer tree. The
principle is what carries forward, not the schema.

**Captures are files the user owns.** `.pwrsnap` bundles live in the user's
Documents folder (`~/Documents/PwrSnap` by default, relocatable), not buried
in application support. SQLite is an *index* over those bundles — fast
listing, search, and metadata — never the only copy of a user's work. A
wiped `userData` must cost the user their index, not their captures.

That choice is why `~/Documents` access is on the critical path, and why
main-thread synchronous reads under the captures roots are forbidden — see
AGENTS.md §"Never block the main thread on a TCC-gated path".

**Bundle format v2 (layer tree) is the only format.** See AGENTS.md
§"Bundle format v2" for the current rules, and
[docs/architecture-bundle-format.md](architecture-bundle-format.md) for the
format specification and its design rationale. Read that document's §Status
first; it marks which of its own sections are historical.

**A new annotation kind is invisible to the builds before it.** A vector
layer's `shape` is a zod discriminated union, so a build that predates a
kind cannot parse a layer that carries it. The freehand `stroke` kind (the
Draw tool: pen, marker, airbrush) is the current example. On a build without
it:

- The Library, editor, thumbnails and exports skip the stroke row (logged
  by `listLayerTree`) and render everything else. Strokes are missing from
  anything that build copies or exports.
- Edits that build makes to such a capture reach SQLite but not the
  bundle: repack refuses a durable history it cannot parse, so the
  `.pwrsnap` keeps its strokes and does not pick up those edits until a
  newer build repacks it.
- Opening or importing such a `.pwrsnap` (Finder, AirDrop) fails whole:
  the layer document does not parse. A copied layer fragment that holds a
  stroke fails its schema check the same way.
- A Draw slot in the tool bag reads as an empty slot. An unrelated
  settings write keeps it on disk; saving the bag from that build replaces
  it. `editor.toolStyles.draw` is an unknown key there and survives.

Nothing is lost on disk by opening a capture in an older build. What that
build cannot do is show the strokes, or move its own edits to the capture
into the bundle. Adding a kind is still additive (no `schemaVersion` bump),
but it is not free; weigh it against reusing an existing kind.

**Presenter cameras are separate sources.** In the capture selector the
camera is a source chip beside the microphone (`K`); arming it opens a live
preview, and its caret a device list. A sandboxed Electron renderer
records the selected camera to its own immutable file; it is never muxed into
or painted onto the screen original. `<capture-id>.camera` beside the screen
file holds the source and a timing/hash manifest. Copy, trash, restore and
purge treat both sources as one capture. Source time maps through a stored
camera-start minus screen-start offset (the native host clock converted through UTC on macOS,
gdigrab's input timestamp on Windows); an editor sync adjustment can refine it.
Earlier macOS recordings whose incompatible uptime epochs put the entire camera
hours outside the screen timeline are recovered on read by aligning their ends.
This is labelled estimated timing; the source, manifest and stored index remain
untouched. In UI copy CAMERA is the source (device, file, timeline lane) and
PRESENTER is the object drawn on the canvas; "avatar" is the schema's name only.
The presenter is edited as an object on the Library's video stage, never in a
form: select it, drag it (it snaps to the edges and centre lines), resize it
from a corner, and use the toolbar that rides above it for look, framing,
mirror, position, size and frame-step sync. The timeline's camera lane shows
where the camera ran, and dragging it is the sync control.
During native macOS recording, the same camera stream may appear in a
nonfocusable preview outside the recorded rectangle. Native ScreenCaptureKit
must confirm its explicit window exclusion before the preview becomes visible.
Missing exclusion, changed display geometry, or no free area hides the preview;
other platforms keep it hidden. Electron content protection alone is insufficient.

Background removal uses the bundled Apache-2.0 MediaPipe landscape selfie
segmenter in a worker on both platforms. It is a soft person mask, with
imperfect hair and fast-motion edges. Raw recording never depends on a mask
pass. Masks and composed videos are disposable caches keyed by source hash,
model revision and processing settings. Nothing uploads camera frames.
The agent owns presenter preparation in split mode; reel scenes request it
through the video command bus. Shared mask and composition jobs survive one
consumer cancelling while another still needs them. Cache cleanup aborts and
drains these jobs in the owning process before removing their files.
Crop, placement, size, mirror, background, outline shape, visibility and sync
adjustment are data: a Library default and optional independent overrides on
each reel scene. A scene inherits the recording's presenter until it is edited,
in the scene inspector or on the paused reel stage; either writes the scene's
own copy. Within one recording, a kept piece (between splits)
can carry its own presenter: these are source-time spans stored apart from
the cut list, so re-trimming never re-times them, and outside any span the
recording's presenter shows. Scene overrides replace both. A cut-out's edge
tightness ramps the soft mask with the same lookup in preview and in FFmpeg.
A recording nobody has edited gets a computed default
for its camera and canvas aspect (a head-and-shoulders cut-out flush in the
bottom-right, unmirrored). Every renderer resolves the style through the same
shared geometry (`packages/shared/src/presenter.ts`), and circle and rounded
outlines use one corner-radius rule in CSS and in the FFmpeg alpha mask, so the
stage preview and the exported file agree.
Preview overlays the camera at the screen's source time; export composes it
on the final reel canvas before applying cuts and speed changes, so letterboxing
the screen never moves the presenter. The delivered video is
opaque, and the original camera remains editable.

**Recorded audio remains editable.** On macOS, the capture selector
offers independent system-audio and microphone choices, both
opt-in, with a live level meter on the microphone. The original MP4
**retains separate tracks** — that is the invariant; everything else is
a rendering of it. Muting or replacing audio in a reel never changes the
original recording. The current Windows recorder is video-only, and main
gates the audio chips on the backend's own capability table — it simply
withholds the source set the selector would render — so a source that
cannot be recorded is absent from the UI, never present-but-doomed.

**Sources are chosen by device, before the take.** The microphone and
camera chips name the device the take will record from, and their device
pickers save the choice as `recording.microphoneDevice` / `.cameraDevice`
(`null` follows the system default). Turning a source on or off is still a
per-take decision that is never written back. A saved device carries
Chromium's `deviceId`, which the selector and the camera recorder open it by,
and its name. The name is the fallback when the per-profile salt changes the
id, and it is the only key the native microphone recorder can use:
AVFoundation knows nothing of Chromium ids, so `recording:start` carries
`microphoneDevice: { label }` and the recorder matches it against the
attached inputs' names, ignoring the trailing "(Built-in)" / "(USB)" tag
that Chromium adds. A name that matches nothing fails the start rather than
recording a different microphone than the chip showed. That failure is the
backstop, not the path a user meets: when the chip never opened the microphone
(a Quick Capture that only offers Record), Record first lists the inputs, and a
saved device that has gone opens the picker on the system default, with a note
saying so, instead of starting. A chip that did open the microphone already fell
back to the default and names it. The microphone picker's
gain check (a dBFS peak meter with a peak hold and a clip latch, and a short
record-and-play-back test) runs on the selector's own preview stream and keeps
the test in renderer memory. It never reaches the take or the disk, and it
does not exist once a take is live.

Because a two-track MP4 plays only its first track in ordinary players,
every path that hands audio to something outside PwrSnap mixes the
selected tracks into one AAC stream: MP4 export, native sizzle audio,
and in-app playback all do. Playback cannot filter on the way out, so it
asks `video:playback` for a URL and main answers with either the capture
itself or a cached, stream-copied rendition whose audio is the same mix
(`prepareVideoPlayback`). A recording whose audible track is not track 0
— system audio armed with nothing playing through it, in front of a good
microphone — is the case that needs it.

Keeping the stems in the source file is what leaves that door open:
mixing at record time would close it permanently, for every recording
already made.

**A video's edit is data too.** Trimming and cutting never touch the
recording. The edit is a list of KEPT spans in source time
(`VideoCaptureMetadata.segments`; the model is
`packages/shared/src/video-segments.ts`): a gap between spans is a cut,
touching spans are a split, and `defaultRange` stays the outer range so
every consumer that understands one range keeps working. Exports render
the spans and Library playback plays them (loop only decides whether the
edit repeats); the timeline never ripples. The Library timeline, MCP agents
(`pwrsnap_video_edit` → `video:edit`) and the in-app chat (`edit_video`)
all edit that one list, and the Library adopts an agent's edit as an
ordinary undoable change. Sizzle reels read the edit live: a video clip
plays its trim window minus the capture's interior cuts — and a clip with
no trim of its own takes the Library's current in/out as that window — so
editing a recording in the Library re-edits every reel that uses it on the
next preview and render. A clip that needs the removed footage back opts
out (`useCaptureCuts: false`) without touching the capture. Agents decide
what to cut without seeing a frame: `video:inspect` returns a
run-length-encoded on-screen activity track with the still stretches
already found. A stretch counts as still only if the picture holds AND the
recorded audio stays below speech level, because a static screen with someone
talking over it is content, not idle. One cached ffmpeg pass per capture
(`recording/video-activity.ts`), a derived-cache lane like the filmstrip
and waveform.

**A duplicate is an independent capture; the family is only a label.**
Duplicate (and Edit a Copy) makes a new capture with its own id, bundle and
rows. Choosing "with edits" carries the layer tree (re-keyed, because layer
ids are global) or the video's kept spans. Choosing base-only carries the
source pixels or recording alone. Enrichment is copied, not re-run. No copy
shares storage with or depends on its source, so trashing, purging or editing
one never reaches another. Lineage is two plain columns, `family_id` (the
root's id) and `duplicated_from`. They are deliberately NOT foreign keys: a
purged original must leave its copies' family intact. Both are mirrored in
the bundle manifest, following the rule that SQLite is an index and the bundle
holds the user's work, and both are read back from it
(`persistence/capture-lineage.ts`). Capture ids are global, so a manifest's
lineage ids are kept as they are. A `.pwrsnap` imported from another machine
keeps a foreign `family_id`, and later imports of its siblings or its root
regroup under it. The root's own row decides the family: a root already in
the library with no family is rooted, as duplicating it would. An import
remapped to a new id because the library already holds that id is recorded as
a copy of the capture that holds it, and the manifest written for it says so
under the new id. An edge that would close a `duplicated_from` cycle is
dropped. The boot filename pass already reads every live bundle's manifest,
and it fills lineage a rebuilt or restored database lost. It only fills empty
columns: where the row and its manifest disagree, the row wins and the
disagreement is logged. Videos have no bundle, so their lineage lives only in
SQLite (`capture/capture-duplicate.ts`,
`persistence/capture-families-repo.ts`). MCP agents reach the same verbs
(`pwrsnap_capture_duplicate` → `capture:duplicate`, plus the edit summary
and family reads), and so does the in-app chat (`duplicate_capture`), so
"make a blurred copy" is duplicate-then-edit on the copy's id. Neither
surface defaults `withEdits`: the Library's remembered choice is the user's,
never an agent's.

**A video copy that cannot be cloned runs in the background, and its row
appears only when the file is whole.** A clone (`/bin/cp -c` on macOS,
because Node's `COPYFILE_FICLONE` does not clone there; the FICLONE ioctl on
Linux) commits before `capture:duplicate` answers. Anything else, which
includes every Windows copy, answers at once with a job. The bytes stream
outside the captures-root lock so screenshots are not blocked. Progress goes
to every window on `events:capture-duplicate:job`, relayed across the process
split because `capture:*` is agent-owned. Screen and camera clones are attempted
outside the captures-root lock; if either needs a byte copy, that work belongs
to the same cancellable job. Until the commit, screen bytes live under
`<copy>.partial` and camera bytes under `<copy-id>.camera.partial`, and no row
points at them.
An intent row (`capture_duplicate_intents`) names the staging and destination
paths before anything is written. It is deleted in the transaction that
inserts the capture, so a crash leaves a record, and the next start removes
those paths and the camera directories derived from the copy id. Recovery
never lists the captures root
(`capture/file-copy.ts`, `capture/duplicate-jobs.ts`).

## AI uses the user's chosen agent or direct API

Built-in Codex and ACP connections remain available. Users can also configure
direct HTTP **connections**: OpenAI Responses, OpenAI-compatible Chat
Completions, and Anthropic Messages. Main makes these requests itself; no
agent, external proxy, or subprocess is required. Legacy text `/completions`
is a different protocol and is not supported.

Codex model choices come from the selected installation's live catalog.
Normal pickers hide GPT-5.5 and the GPT-5.6 family, each model only when its
own replacement is advertised, so a saved default never disappears without
being migrated. Saved Codex defaults move to advertised replacements:
GPT-5.5, GPT-5.6 (except Luna), and GPT-6-Sol move to GPT-6.1-Sol;
GPT-5.6-Luna moves to GPT-6-Luna. Discovery reconciles these defaults inside
the serialized settings store, including before automatic Codex enrichment.
Only explicit choices migrate. An unset enrichment model is PwrSnap's managed
default: it resolves per run to GPT-5.6-Luna or its advertised successor and
is never written to settings, so a later default change still reaches everyone
who never picked a model. GPT-6-Astra selections, existing threads, and ACP/direct API defaults retain
their configured models. Replacement capabilities and reasoning efforts
come from the catalog, never from the model's name.

A connection (`ai.customConnections`) is one endpoint: a stable UUID, a name,
the base URL, an explicit protocol, and public sign-in configuration (none,
API key, or OAuth). Models (`ai.customModels`) hang under a connection by
`connectionId` and carry only what differs per model: display name, exact
model ID, capabilities, and output limit. `custom:<modelUuid>` selects a model
in the existing chat and enrichment defaults. Removing a model or connection
leaves prior thread/default references unavailable; it never redirects a
prompt to a different provider. Both lists are main-owned — `settings:write`
refuses them and the `customModels:*` verbs are the only writers — so the
limits, id minting, and credential clean-up happen in one place. The first
cut stored one flat entry per model; its files are read, regrouped into
connections, and keep their stored keys.

Each connection owns at most one credential, `customModelCredential:<connectionId>`
in `DesktopSecretStore`, shared by every model under it and bound to the
connection's base URL and sign-in metadata. Repointing a connection (new URL,
new sign-in type, new OAuth endpoints) clears its credential rather than
sending it somewhere the user did not enter it; removing the connection clears
it too, and any credential no connection references is swept. No status read
decrypts secrets. Linux `basic_text`, unavailable storage, and locked
credentials never cause plaintext fallback. API keys are write-only inputs;
access and refresh tokens never enter renderer projections, settings, logs, or
exports.

OAuth supports documented public native-client authorization-code flows with
S256 PKCE, state, a loopback callback, serialized refresh, and local logout with
best-effort provider revocation. Users must supply the provider's authorization
and token endpoints plus a registered client ID (and scopes/resource where
required). A subscription or generic API URL does not establish API access.
Confidential clients requiring a client secret are not supported.

Display names prefer explicit `display_name` discovery metadata. For loopback
endpoints without that metadata, new entries suggest the model ID's filename
without `.gguf`, retaining size/quantization suffixes. This is a label only:
paths are never read and request IDs remain exact. Saved user names are never
replaced. Status and usage labels resolve the saved model by its UUID.
The Library's per-capture attribution comes only from recorded run metadata,
shown once. Current defaults describe the next Regenerate/Refresh action in
its tooltip; missing historical metadata never falls back to today's default.
Selecting a capture only reads its saved enrichment, including a saved failure.
It never starts or retries inference. Automatic enrichment is triggered when a
new capture is persisted; running it again requires an explicit user action.

Direct enrichment uses a FIFO queue per connection, shared by all its models,
through `@shutterstock/p-map-iterable`. The configurable parallelism defaults
to one for loopback endpoints and two elsewhere; a changed limit takes effect
after that connection's current queue drains. Waiting runs remain `queued`
and do not prepare images, decrypt credentials, or start a request deadline.
At admission, a run aged 15 minutes is failed without dispatch. Cancellation
immediately updates the run; queued cancellations leave tombstones that are
discarded at admission, and active cancellation aborts the HTTP request.
Each admitted direct enrichment gets a separate 15-minute model-call deadline.
Queued work retains its selected model and rejects a changed endpoint/protocol/
auth configuration rather than sending a capture to a new destination.

Custom capabilities are explicit. Image input is three-state — yes, no, or
unknown — and only an explicit yes sends an image or makes a model eligible for
captions. Discovery lists the connection's models and accepts only unambiguous
per-row metadata; `/props` vision applies only when a Chat Completions `/models`
identifies precisely one model. Names and URLs never imply vision, reasoning,
Fast mode, or prices; the operator confirms each model. Usage tokens are
recorded when returned, with custom pricing unavailable. Redirects are refused,
remote endpoints require HTTPS, HTTP is loopback-only, response sizes and
request duration are bounded, and server error bodies are not surfaced. A
401/403 is reported as a rejected credential so Settings can ask for it again.

Settings → AI Providers shows installed agents and direct connections side by
side; each connection is its own screen, edited in steps (where it is, how it
signs in, which models, which jobs use it) that save as they pass.

Direct chat reuses PwrSnap's local journal and streaming/cancellation lifecycle.
It supports text conversation and the current Library image when the model
accepts images, but has no editing tools or automatic library/reel access. Enrichment
sends app-prepared image bytes and validates the same structured result as the
agent paths. The model cannot execute code, read paths, call tools, or select
additional network destinations: only main's fixed inference request is made.

**Capture enrichment is a jailed, unattended path.** A screenshot is
untrusted input that can carry text engineered to steer a model. Enrichment
runs with no tools, no model-initiated network, no filesystem beyond the
agent scratch jail (or bounded image bytes for direct APIs), no inherited
Codex lifecycle hooks or notification commands, and no UI to
approve anything — enforced in the transport, not the prompt. This is
the most security-sensitive surface in the app; AGENTS.md §"Capture
enrichment runs in a sandbox jail" is the authority, including the measured
difference between the Codex and ACP postures.

**Tool-using AI belongs on the user-facing chat surfaces**, which have their
own approval policy and a human watching. Do not grow enrichment a tool to
make a feature work.

## Library: browsing must never lose your place

Grid and Reel are two **layouts** of one browse shell. Focus is an
orthogonal **takeover** you enter from either and exit back into.

The rule underneath: **viewing or editing a capture never reorders history.**
The incumbent's worst behavior was re-inserting an edited copy at the front
of recents, overwriting the spot you were looking at. Selecting is a
lightweight act that updates an inspector in place; entering the editor is
explicit.

The view-state union is the enforcement point — see
[library-view.ts](../apps/desktop/src/renderer/src/features/library/library-view.ts),
whose comment carries the transition rules. Inspector and overlay state
stays out of that union.

The Library is built to scale: keyset pagination, virtualized rows,
denormalized counts. It is not a fixture list, and changes there should be
measured against a seeded large library rather than a handful of captures.

## Process and transport shape

- **One command bus.** Every command routes through
  [command-bus.ts](../apps/desktop/src/main/command-bus.ts) — ipcMain, the
  local HTTP RPC surface, and MCP all dispatch through it, so there is
  exactly one place to register a command and one place to enforce auth and
  capability checks.
- **Renderers stay sandboxed.** `contextIsolation: true, sandbox: true,
  nodeIntegration: false`, without exception. Heavy work goes to the main
  process or a child process, never to a privileged renderer.
- **`Result` for anything crossing a process boundary.** Electron `invoke`
  strips `instanceof`, so handlers return
  `Result<Res, PwrSnapError>` rather than throwing across the gap.
- **Settings and secrets have exactly one substrate.** No sibling JSON
  files, no plaintext secrets, no second IPC channel. See AGENTS.md
  §"Settings substrate".
- **Local agents come in through one OAuth door.** PwrSnap serves MCP on
  loopback and is the OAuth 2.1 authorization server for it — dynamic
  client registration, PKCE, and its own native approval window. Third-
  party agents (Claude Code, Codex CLI) connect with their built-in OAuth
  clients; there is no second credential path and no helper to install.
  See [mcp-third-party-agents.md](mcp-third-party-agents.md).

## Direction — open and deliberately unresolved

- **Sizzle composition engine.** The reel composer ships, but the original
  plan named Remotion as its engine and that was retracted on license
  grounds. Remotion is on the do-not-look list in AGENTS.md §"Dependency
  licensing" — do not read its source, docs, or examples. A replacement
  engine is an open research item.
- **Windows.** Ships signed, with a known backlog tracked in
  [docs/windows/port-status.md](windows/port-status.md) §Status. No Arm64
  package yet; no distributed Linux desktop build.
- **Cloud sync and alternate storage targets** (Drive / Dropbox / S3 / R2)
  are named goals with no shipped implementation. Nothing in the current
  storage model blocks them — bundles are already portable files.

## When this document is wrong

Fix it in the same PR as the change that made it wrong. It is short on
purpose: a living document that nobody trusts is worse than no document,
and the pruned phase plans are the cautionary example — they carried
`status: active` and unchecked task lists over features that had shipped
months earlier.
