# Sizzle Reels — Plan

**Status:** MVP shipped on `main` as PR #124. Phase 2 (in-Library
project surfacing) + Phase 3a (video scenes + crossfade transitions)
shipped on PR #130 (branch `feat/sizzle-videos-and-library`). The
Library → Sizzle Reels… menu opens a dedicated composer window that
can compose voiced ken-burns slideshows AND video clips with
crossfade transitions, rendering to MP4 via ffmpeg. Settings → AI
Providers grows an OpenAI API key field. Projects appear inline as
cells in the day-grouped Library grid alongside image/video
captures; click opens them in the dedicated Sizzle window. Phase 3
WebCodecs in-renderer preview remains deferred to a follow-up PR.

This document covers the design decisions, what is in vs out, and
the follow-up work the design mock implies.

## Source of inputs

- Design handoff: [design/PwrSnap Sizzle Reels.html](../../design/PwrSnap%20Sizzle%20Reels.html)
  + sibling `design/src/Sizzle*.jsx` and `design/src/sizzle.css`.
- Right-rail base: branch `feat/right-rail-chat-tab` (merged into
  this branch; provides `RightActivityBar`, layout-toggle chips,
  Library DetailRail pin/last-tab persistence).
- Prior art: [/Users/huntharo/github/openclaw-codex-app-server-videos](https://github.com/pwrdrvr/openclaw-codex-app-server-videos)
  — earlier PwrDrvr sizzle reel that the user built with Remotion +
  OpenAI TTS. Only the TTS script structure (per-scene mp3, ffmpeg
  concat) and project shape were used as reference; the composition
  engine is a clean-room replacement (see "Licensing constraint"
  below).

## Licensing constraint — no Remotion

Per [CLAUDE.md](../../CLAUDE.md) §"Dependency licensing", **Remotion
is on the do-not-look list** (Remotion License is source-available
with commercial-use restrictions). That extends to its skill repo
([remotion-dev/skills](https://github.com/remotion-dev/skills)) and
its docs. The composer here is plain ffmpeg `filter_complex` —
`zoompan` for ken-burns + audio concat — driven from a TypeScript
scene-graph. No Remotion-pattern leakage; no `npm install remotion`.

If a richer composition engine is wanted later (real timeline,
transitions, captions, multiple audio tracks), candidates that ARE
license-compatible (MIT / Apache / BSD-style):

| Candidate | License | Notes |
|---|---|---|
| Plain ffmpeg `filter_complex` | LGPL/GPL (binary use is fine) | What we ship today. Scales to slideshows + audio concat; fights you on per-clip captions and complex transitions. |
| `editly` (npm) | MIT | Higher-level wrapper around ffmpeg. Worth looking at for transitions / captions. |
| WebCodecs in a worker + offscreen canvas + `mp4-muxer` | MIT/CC0 | Real React-driven preview that records to MP4 in-process. Highest fidelity to the "play it before rendering" experience the mock shows. |
| Native AVFoundation in a Swift extension | n/a (macOS API) | Fastest. Bigger lift. |

I'd prefer WebCodecs + offscreen canvas when we want to add the
horizontal NLE preview from the mock — the renderer already exists
as a React tree, so we'd record what we already paint.

## What this MVP ships

- **Menu**: File menu → Library → Sizzle Reels…
- **Window** (`createSizzleWindow`): singleton `#stage=sizzle`,
  titlebar/hiddenInset to match Settings.
- **Projects substrate**: JSON file at
  `userData/sizzle-projects.json` (atomic-rename writes, parse-fail
  quarantines). Not in Settings — project bodies (scenes + scripts)
  are unbounded enough to not belong in the small-config substrate
  (see CLAUDE.md "Settings substrate" §what-this-is-not-for).
- **Composer**:
  - `apps/desktop/src/main/sizzle/tts.ts` — OpenAI `/v1/audio/speech`
    client, content-addressed cache at `userData/sizzle-cache/tts/`.
  - `apps/desktop/src/main/sizzle/composer.ts` — ffmpeg ken-burns
    slideshow with `zoompan` (alternating in/out per scene) + audio
    concat demuxer.
  - `apps/desktop/src/main/handlers/sizzle-handlers.ts` — bus
    handlers (`sizzle:open|list|create|update|delete|render|revealOutput`).
- **Secrets**: `openaiApiKey` added to `DesktopSettingsSecretName`
  union + `KNOWN_SECRET_NAMES`. Settings → AI Providers grows an
  "OpenAI (Sizzle Reels voiceover)" card reusing the existing
  `GrokKeyControl` plaintext-never-crosses-the-bus pattern.
- **Renderer**:
  - `apps/desktop/src/renderer/src/features/sizzle/SizzleApp.tsx`
    + `sizzle.css` — left rail (projects) + main editor (scenes
    list, voice/provider/resolution dropdowns, render footer with
    progress bar, Reveal in Finder).
  - Capture picker modal pulls from `library:list` and shows
    `pwrsnap-cache://` thumbs.
- **Live progress**: `events:sizzle:render:progress` broadcast on
  every TTS scene + every ffmpeg time line.
- **Output**: `~/Movies/PwrSnap/<sanitized-name>-<id>.mp4`,
  H.264 1080p or 720p, AAC audio.

## What ships now (after PR #124 + PR #130)

- ✅ Dedicated Sizzle composer window — Library → Sizzle Reels… (or
  the "+ New Sizzle Reel" sidebar CTA in Library) opens it.
- ✅ Voiced ken-burns slideshows (image scenes) — OpenAI TTS +
  ffmpeg `zoompan`.
- ✅ **Video scenes (PR #130 §Phase 3a)** — the picker accepts
  `kind === "video"` records. Per-scene trim mini-control (start/end
  seconds, seeded from `record.video.defaultRange`). Per-scene
  audioSource: `auto | native | voiceover | muted` — `auto` resolves
  to `voiceover` when a script is set, `native` when empty. The
  composer extracts native-audio for video scenes via a small
  `ffmpeg -ss -t -vn` pre-pass.
- ✅ **Crossfade transitions (PR #130 §Phase 3a)** — `SizzleScene`
  grows `transition: "cut" | "crossfade"`. Default for new scenes is
  `"crossfade"` (the visual win we want). Editor exposes a chip
  between scene rows. Composer left-folds `xfade=duration=0.4` into
  the filter graph; audio side is cuts-only this round (acrossfade
  deferred — documented limitation, narration-style content
  tolerates it).
- ✅ **In-Library project surfacing (PR #130 §Phase 2)** — projects
  appear INLINE as cells in the day-grouped grid (NOT in a separate
  project-mode pane and NOT enumerated by name in the sidebar — the
  user explicitly rejected both as not-Library-shaped). The
  `FixtureBackedRecords` adapter projects each `SizzleProject` into
  a `Capture` view-model with `kind: "project"` and a synthetic
  `app: "_sizzle_"` key. Day-bucket pivots on `project.modifiedAt`
  so freshly-edited reels float up near recent captures.
- ✅ **Types sidebar filter (PR #130 §Phase 2)** — Images / Videos /
  Projects three-way multi-pick. Sits in the left sidebar alongside
  Source App. Plain click toggles; shift-click acts as "Only this".
  Each row carries `aria-pressed` so screen readers report it as a
  toggle.
- ✅ **Project tab on the right rail (PR #130 §Phase 2/Slice C)** —
  4th tab on `RightActivityBar`. Lists the project's scenes in
  order, kind chip per row, total duration, "Open editor" CTA.
- ✅ **Live progress** — `events:sizzle:render:progress` broadcasts
  on every TTS scene + every ffmpeg time line.
- ✅ **Hardware-encoded H.264** — `h264_videotoolbox` (macOS
  Apple-native, BSD-shaped licensing) NOT libx264 (GPL); see
  CLAUDE.md §"License posture" and issue #127 for the bundled-ffmpeg
  follow-up.

## What still does NOT ship (vs the full mock)

- ❌ Horizontal NLE timeline + Storyboard timeline variants. Only
  the Script-vertical layout ships.
- ❌ AI Chat tool-calls ("Edited transitions · 5 changes" with
  Keep/Undo).
- ❌ Drag-to-reorder scenes — up/down arrows only.
- ❌ Multi-target export modal (MP4 + YouTube + X). MP4 to disk
  only.
- ❌ Captions burn-in.
- ❌ Voice "Record yourself" / "Upload" — TTS only.
- ❌ Auto-cut diff notice in the waveform.
- ❌ Pop out / dock-in choice — sizzle is always a window.
- ❌ Audio cross-fades between scenes — video cross-fades only;
  audio side is cuts. Acceptable for narration-style content.
- ❌ Native-audio + voiceover mixing/ducking — per-scene picks one
  audio source, not both.
- ❌ Phase 3 WebCodecs in-renderer preview — deferred to its own PR
  (architectural shift, see §Phase 3 below).

## Phased follow-up

### Phase 1 — close the loop on the MVP

- Verify with a real OpenAI API key: set it in Settings → AI
  Providers, create a sizzle, add a few image captures, render.
  Output should land at `~/Movies/PwrSnap/`.
- If ffmpeg's zoompan jitters at high zoom, switch to per-scene
  pre-rendered MP4s + concat demuxer (smoother but a few times
  slower).
- Add an E2E test that creates a project, stubs out OpenAI to a
  local file, and confirms the MP4 lands.

### Phase 2 — promote sizzle into the Library — **SHIPPED on PR #130**

What we **actually built** (which diverges from the original design
mock — kept here as honest archaeology):

- ✅ Sidebar `Types` multi-pick (Images / Videos / Projects). Each
  row carries `aria-pressed` for accessibility. Shift-click =
  "Only this".
- ✅ Projects rendered as cells INLINE in the day-grouped grid via
  `FixtureBackedRecords.projectToFixture` — they live alongside
  image/video captures in the same virtualized grid. Day-bucket
  pivots on `project.modifiedAt`. This was the user's explicit ask
  after an initial iteration that put projects in a separate band
  at the top of the grid + per-project rows in the sidebar.
- ✅ Right-rail Project tab (4th tab on `RightActivityBar`). Lists
  scenes in order; "Open editor" returns to the dedicated Sizzle
  window. Tab persistence via the existing `library.sidebarTab`
  setting (extended to allow `"project"`).
- ✅ "+ New Sizzle Reel" sidebar CTA (single project-creation
  affordance — no per-project rows; the grid is the project list).

What we explicitly **did NOT build** (after the user pushed back on
the initial design):

- ❌ `LibraryView` mode `"project"` — initially built and removed.
  Projects aren't a filter pane; they're items in the library list.
- ❌ Per-project rows in the sidebar — initially built and removed.
  Doesn't scale past ~1 project. The grid IS the project list.
- ❌ +/✓ add-capture overlay across the grid (the "add captures to
  project" mode in the mock) — superseded by editing scenes in the
  dedicated Sizzle window via "Open editor".
- ❌ Fake "Smart Filters" sidebar section (Pinned / Bug repros /
  Has annotations) — removed at user's request.

### Phase 3 — composer architectural follow-ups

#### Phase 3a — video scenes + crossfade transitions — **SHIPPED on PR #130**

- ✅ Discriminated `SceneInput` (image | video) in the composer.
- ✅ Video branch: `-ss start -t duration -i video.mp4`, no
  zoompan, voiceover-overrun handled by `tpad=stop_mode=clone`.
- ✅ Per-scene `audioSource: "auto" | "native" | "voiceover" | "muted"`.
- ✅ `xfade=duration=0.4` chain between scenes when
  `transition === "crossfade"`. Audio side stays cuts (documented
  limitation; tracked in the §"What still does NOT ship" list).
- ✅ Tests for the composer args contract; Darwin-gated specs for
  the actual ffmpeg invocation (the codec contract assertion is
  cross-platform so Linux CI still catches regressions).

#### Phase 3b — WebCodecs in-renderer preview + ffmpeg render — **DEFERRED**

Architecturally distinct enough to deserve its own PR:

- Move the composition graph into the renderer (offscreen canvas
  + image bitmaps) so the editor can play back what it draws.
- For final render, either record the canvas with `MediaRecorder`
  → MP4-muxer, or hand the graph back to the main-process ffmpeg
  pipeline.
- Adds transition support (cross-fade variations, dip-to-black,
  push, slide) and per-scene captions because rendering is
  React-driven instead of `filter_complex`.
- Sandboxing — the preview renderer must keep
  `contextIsolation: true, sandbox: true, nodeIntegration: false`
  per CLAUDE.md "Renderers stay sandboxed". Render orchestration
  (the ffmpeg child process) stays in the main process.

### Phase 4 — multi-destination export + auth

- YouTube + X OAuth flows.
- Render presets per destination (1080p, 4K, square).
- The mock's per-destination Bitrate / Captions toggles.

### Phase 5 — AI Chat surface

- Project-scoped Codex thread (see `codex:ask` — already wired).
- Tool-calls modify the project graph + emit a diff that the
  composer turns into "Edited transitions · 5 changes" cards with
  Keep/Undo.

## Open questions for the user

(Lifted from the design notes in [design/PwrSnap Sizzle Reels.html](../../design/PwrSnap%20Sizzle%20Reels.html))

1. **Project window vs Library main-pane** — MVP chose "dedicated
   window." The mock shows it embedded in the Library. Which is
   canonical?
2. **What does "New Project" do** — MVP just creates a blank
   project and selects it. Mock alternative: drop you straight
   into add-captures mode in the Library grid.
3. **Project kinds beyond Sizzle Reels** — slide-deck packets,
   bug-repro reels, etc. Today we only model one kind.
4. **xAI TTS** — placeholder in the UI; xAI's audio API isn't
   wired up yet. Confirm whether to add it now or keep OpenAI-only.

## Files touched

### PR #124 (MVP)

```
packages/shared/src/protocol.ts                              (+types, +commands)
packages/shared/src/ipc.ts                                   (+sizzleRenderProgress)
apps/desktop/src/main/settings/desktop-secret-store.ts       (+openaiApiKey)
apps/desktop/src/main/window.ts                              (+createSizzleWindow)
apps/desktop/src/main/index.ts                               (+menu, +register)
apps/desktop/src/main/sizzle/sizzle-store.ts                 (new)
apps/desktop/src/main/sizzle/tts.ts                          (new)
apps/desktop/src/main/sizzle/composer.ts                     (new)
apps/desktop/src/main/handlers/sizzle-handlers.ts            (new)
apps/desktop/src/renderer/src/App.tsx                        (+sizzle stage)
apps/desktop/src/renderer/src/features/sizzle/SizzleApp.tsx  (new)
apps/desktop/src/renderer/src/features/sizzle/sizzle.css     (new)
apps/desktop/src/renderer/src/features/settings/pages/AIProvidersPage.tsx
                                                             (+OpenAI key card)
```

### PR #130 (Phase 2 + Phase 3a)

```
packages/shared/src/protocol.ts                              (+SizzleMediaTrim, +SizzleAudioSource, +SizzleTransition,
                                                              +SIZZLE_CROSSFADE_SEC, +library:listByIds,
                                                              +sizzle:toggleScene, +sizzle:previewSceneAudio,
                                                              SizzleScene gains mediaTrim/audioSource/transition,
                                                              LibrarySidebarTab += "project")
packages/shared/src/ipc.ts                                   (+sizzleProjectsChanged broadcast channel)
apps/desktop/src/main/sizzle/composer.ts                     (discriminated SceneInput, xfade chain, tpad pad,
                                                              h264_videotoolbox codec, AbortSignal plumbing)
apps/desktop/src/main/sizzle/audio-extract.ts                (new — extract native-audio + synth silence helpers)
apps/desktop/src/main/sizzle/sizzle-store.ts                 (sanitizeScenes on READ too, for old-project back-compat)
apps/desktop/src/main/handlers/sizzle-handlers.ts            (resolveAudioSource, scene duration =
                                                              max(trim, voiceoverDur+0.35), projects:changed broadcast
                                                              on every mutation, sizzle:toggleScene handler)
apps/desktop/src/main/handlers/sizzle-validators.ts          (+mediaTrim, +audioSource, +transition validators,
                                                              relaxed empty-script for video scenes,
                                                              +listByIds + toggleScene validators)
apps/desktop/src/main/handlers/library-handlers.ts           (+library:listByIds handler — drops missing + soft-deleted,
                                                              returns rows in input order)
apps/desktop/src/renderer/src/lib/useSizzleProjects.ts       (new — fetch + subscribe hook, soft-delete-ready)
apps/desktop/src/renderer/src/features/library/captures.ts   (Capture.kind non-optional, +PROJECT_APP_KEY constant,
                                                              +kind: "project")
apps/desktop/src/renderer/src/features/library/adapter.ts    (+projectToFixture, FixtureBackedRecords gains projects)
apps/desktop/src/renderer/src/features/library/Library.tsx   (sidebar Types section with aria-pressed,
                                                              +"New Sizzle Reel" CTA, CellThumb project branch,
                                                              onSelectCell dispatches sizzle:open for projects)
apps/desktop/src/renderer/src/features/library/DetailRail.tsx (4th tab: Project)
apps/desktop/src/renderer/src/features/sizzle/SizzleApp.tsx  (picker accepts videos, per-scene trim/audio dropdown,
                                                              transition chip, voiceover-overruns-trim hint)
apps/desktop/src/renderer/src/styles/tokens.css              (+--media-scrim-bg/text/shadow theme-invariant tokens)
apps/desktop/src/renderer/src/styles/library.css             (+psl__type-row, +psl__cell-project*,
                                                              +psl__nav--cta for the New Sizzle Reel CTA)
apps/desktop/src/renderer/src/features/library/__tests__/adapter.test.ts
                                                             (+projectToFixture + FixtureBackedRecords tests)
```
