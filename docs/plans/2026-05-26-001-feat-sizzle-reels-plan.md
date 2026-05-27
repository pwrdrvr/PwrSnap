# Sizzle Reels — Plan

**Status:** MVP shipped on this branch. The Library → Sizzle Reels…
menu opens a dedicated composer window that can compose voiced
ken-burns slideshows from existing captures and render them to MP4
via ffmpeg. Settings → AI Providers grows an OpenAI API key field.

This document covers the design decisions, what is in vs out of the
MVP, and the follow-up work the design mock implies.

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

## What this MVP does NOT ship (vs the mock)

Cut intentionally for the deadline; design lives in `design/src/Sizzle*.jsx`.

- ❌ In-library project mode (project chips in left rail, +/✓
  add-capture overlay on every cell). The composer is a separate
  window in MVP.
- ❌ Right-rail "Project Assets" tab — would be the 4th tab on the
  shared `RightActivityBar`. Right-rail merge from `feat/right-rail-chat-tab`
  gives us the foundation.
- ❌ Horizontal NLE timeline + Storyboard timeline variants. Only
  the Script-vertical layout ships.
- ❌ AI Chat tool-calls ("Edited transitions · 5 changes" with
  Keep/Undo).
- ❌ Transition picker between scenes — composer hardcodes
  scene-cuts. `xfade` is a one-filter swap when wanted.
- ❌ Drag-to-reorder scenes — up/down arrows only.
- ❌ Multi-target export modal (MP4 + YouTube + X). MP4 to disk
  only.
- ❌ Captions burn-in.
- ❌ Voice "Record yourself" / "Upload" — TTS only.
- ❌ Auto-cut diff notice in the waveform.
- ❌ Pop out / dock-in choice — sizzle is always a window.

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

### Phase 2 — promote sizzle into the Library

Match the mock more faithfully:

- Add `LibraryViewMode = "all" | "project"`.
- Sidebar `Types` multi-pick + `Sizzle reels` list (the design
  already exists in `design/src/SizzleApp.jsx` → `LeftSidebar`).
- Add captures via the existing capture grid with +/✓ overlay.
- Right rail: add `Project Assets` as 4th `RightActivityBar` tab.
  Re-uses `useSettings` for tab persistence (we already store the
  Library DetailRail last-tab + pin via the Settings substrate
  per the right-rail branch).

### Phase 3 — switch composer to WebCodecs preview + ffmpeg render

- Move the composition graph into the renderer (offscreen canvas
  + image bitmaps) so the editor can play back what it draws.
- For final render, either record the canvas with `MediaRecorder`
  → MP4-muxer, or hand the graph back to the main-process ffmpeg
  pipeline.
- Adds transition support (cross-fade, dip-to-black, push, slide)
  and per-scene captions because rendering is React-driven instead
  of `filter_complex`.

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
