# Changelog

## v1.0.0-beta.17 - 2026-06-13

This is the "ready to open the doors" beta: the macOS dogfood build is more
polished, the Windows port is real enough to track in public, and the agentic
capture loop is sharper from first launch through export.

- Added the first Windows GUI path: tray, float-over controls, capture flow,
  window picker, custom window chrome, and installer work are now in-tree.
- Added launch-at-login with tray-only startup so PwrSnap can be present
  without throwing a full Library window in your face.
- Made capture startup and selector behavior more resilient: snapshots stay
  side-effect free, the replacement selector warms up sooner, macOS selectors
  rebuild after hide/show transitions, and selector windows re-raise when the
  system tries to bury them.
- Improved AI enrichment with Kimi/ACP model support, Fast/Thinking mode
  labels, accurate provider naming, quieter ACP logs, and export filenames
  based on enrichment stems.
- Tightened macOS permission handling by detecting and surfacing TCC denials
  when PwrSnap cannot read the captures folder.
- Took startup latency seriously with a profiling harness and by moving
  login-shell PATH work off the critical path.
- Polished the everyday surfaces: tray shortcuts match Settings, float-over
  countdowns resume correctly after saving AI drafts, and tray/float-over
  colors now line up with the Library's black ramp.
- Kept image exports practical by reusing source-width presets instead of
  needlessly resizing captures.
- Promoted the Windows cross-platform port plan and captured the current
  gotchas so the open-source work has a visible map.

## v1.0.0-beta.16 - 2026-06-07

- Added capture selection-mode affordances, including a crosshair cursor,
  Escape step-back behavior, and drag-to-redraw support.
- Switched chat, enrichment, and Settings AI flows to consume
  `@pwrdrvr/agent-kit`.
- Improved Grok and ACP enrichment with cleaner JSON handling, correct model
  reporting, and friendlier model names.
- Fixed Codex discovery path display and auxiliary-window placement on the
  source display.
- Prevented Sizzle narration truncation.
- Improved Windows portability for build, typecheck, and unit-test paths.
- Updated Electron, Playwright, and electron-log dependencies.

## v1.0.0-beta.15 - 2026-06-04

- Trimmed and fully wired the Settings surface for the release.
- Switched the desktop app to consume the published Codex protocol package.
- Fixed Library tile and frame hover flicker so grid previews no longer pulse
  during hover interactions.

## v1.0.0-beta.14 - 2026-06-03

- Added reel duplication from the Sizzle Composer and Library.
- Restored Sizzle Library reel covers and previews, and guarded video trim
  fitting for safer sequence rendering.
- Improved capture flow and AI enrichment polish across six user-facing fixes.
- Surfaced Codex turn errors instead of silently dropping them.
- Fixed preview synchronization and repaired the dev Electron runtime path.
- Refined editor toolbar icons and kept highlight preview opacity consistent.
- Added Escape cancellation for the recording lead-in countdown.

## v1.0.0-beta.13 - 2026-06-01

- Added Sizzle sequence scenes plus a sequence editor with real waveforms, auto
  beat timing, drag reorder, and undo support.
- Added AI usage cost observability and an AI enrichment budget breaker across
  Codex-backed surfaces.
- Fixed Codex thread isolation for PwrSnap chat and capture metadata pipelines.
- Exposed chat-driven layer style updates in the editor.
- Changed the Shape tool shortcut to `S`.
- Prepared repository metadata and docs for the MIT open-source release,
  including PwrDrvr/PwrAgent brand-orange parity notes.
- Updated runtime and tooling dependencies, including React, better-sqlite3,
  Zod, Vite, Vitest, Geist Mono, and Node 24 type pinning.
- Improved settings safety by disabling secret replacement until the value has
  actually been edited.

## v1.0.0-beta.12 - 2026-05-30

- Routed external `.pwrsnap` capture opens through the main Library Focus
  editor instead of the retired standalone editor window.
- Added Library Back and Forward history controls so Finder-opened captures can
  return to the previous Library view.
- Fixed Library grid selection tracking by selected capture id.
- Added single-instance `.pwrsnap` file-open handoff so Finder-launched
  processes forward queued file paths to the running app before exiting.
- Upgraded GitHub Actions cache usage to the Node.js 24-backed v5 action.

## v1.0.0-beta.11 - 2026-05-30

- Replaced the redistributed FFmpeg binary with PwrSnap's pinned custom-built
  LGPL FFmpeg, including release-published source archives and SHA-256 sidecars.
- Renamed `.pwrsnap` bundles with readable capture filenames based on capture
  time, source app, effective filename, and a short content hash.
- Made Codex filename suggestions become the effective filename by default
  while preserving explicit user overrides.
- Fixed New from Clipboard so pasting copied capture pixels creates a new
  independent capture instead of returning the original source row.
- Removed the remaining v1 image bundle read/write and migration paths now that
  the library has moved to v2-only image bundles.

## v1.0.0-beta.10 - 2026-05-29

- Added Sizzle Composer Chat, bringing the shared agent chat substrate into the
  sizzle composition workflow.
- Added AI enrichment controls for managing capture enrichment behavior.
- Fixed sizzle project date handling so project timestamps stay stable.

## v1.0.0-beta.9 - 2026-05-29

- Added Library Chat, a live Codex-powered agent surface that can browse, edit,
  and redact captures from the Library.
- Added Project Asset Cart support for collecting captures into Sizzle Reel
  projects, backed by the new Library search and metadata lookup substrate.
- Wired Library search into the topbar search input.
- Added the Shape tool with rectangle, square, circle, oval, and parallelogram
  options.
- Added a right-click editor context menu for layer operations, including Escape
  handling that closes open context menus without dropping the current selection.
- Wired the six-card video export grid into the tray and float-over surfaces.
- Improved v1-to-v2 migration by removing the v1 capture write path and
  deferring/offloading the boot sweep to avoid startup crashes.
- Fixed editor effect fidelity so rotated blur and pixelate previews match the
  baked output.
- Fixed capture and permissions polish, including keeping the Library visible
  after capture cancel and triggering first-run TCC prompts for Screen Recording
  and System Audio.
- Documented the bake render cache model as content-addressed with tolerated
  orphan entries.

## v1.0.0-beta.8 - 2026-05-28

- Added Sizzle Reels MVP and Phase 2/3a project-mode work, including narrated
  Ken Burns reels from captures, videos, and crossfade transitions.
- Added Full Screen and All Screens capture modes.
- Added per-format small, medium, and large video export presets with copy and
  drag parity.
- Added the vertical Library right rail with Info, OCR, and Chat tabs.
- Added editor multi-selection, keyboard nudging, paste, z-order controls, and
  rotation support.
- Improved text annotation fidelity with WYSIWYG display/edit behavior,
  output-resolution text rendering, direct layer selection, and live glyph
  dragging.
- Fixed video capture/library polish, including source-app logging, keeping the
  capture window on top, video-specific GIF/MP4 export presets, and Paste from
  Clipboard menu refresh after in-app copy.
- Fixed tray and layout regressions, including the missing TrayMenu effect
  import, scrollable Library sidebar overflow, and narrow-stage toolbar wrapping.
- Fixed Sizzle Reel rendering on GitHub-hosted macOS runners by allowing
  VideoToolbox to fall back to Apple's software encoder when a hardware
  compression session is unavailable, and by using explicit bitrate settings
  that work in both VideoToolbox hardware and software modes.
- Moved IPC envelope coverage from Desktop E2E into faster Vitest coverage.

## v1.0.0-beta.5 - 2026-05-26

- Fixed v2 crop handling so crop is treated as a viewport: text, arrows, blur,
  and image layers keep their absolute source positions across crop, undo, and
  Reset.
- Fixed editor arrow rendering with pixel-space SVG output, thickness-scaled
  heads, and golden-ratio proportions.
- Added export-surface integration coverage for the main export, copy, and
  render paths.
- Fixed v2 medium-copy behavior so Copy MED returns the rendered composite
  instead of the bare source image.
- Fixed the AI Providers settings page to use the real Codex caption model
  picker.
- Fixed Library metadata to show the real app version and made Quick Capture
  hotkey changes apply live.
- Corrected README AI-provider claims to describe the existing provider-routing
  behavior accurately.

## v1.0.0-beta.4 - 2026-05-25

- Fixed the beta.3 packaged-app startup failure by explicitly shipping the
  Sharp `@img` native bindings, libvips dylibs, and ffmpeg Darwin binaries
  outside `app.asar`, with release verification that fails if they are missing.
- Added the `.pwrsnap` bundle storage format as the system of record, including
  bundle migration/reconciliation, layer-tree groundwork, and thumbnail/source
  handling that no longer depends on paired PNG files.
- Added macOS Quick Look Thumbnail and Preview extensions for `.pwrsnap`
  bundles, plus diagnostic tooling and thumbnail preference fixes for Finder.
- Expanded the editor with v1 polish, zoom/pan, undo/redo, draggable toolbar,
  v2 tool UX, dual-format rendering, lazy doctor checks, and three blur styles.
- Improved AI annotation and enrichment flows across the float-over, Library
  sidebar, capture titles, descriptions, tags, and sensitive-content metadata.
- Improved visual fidelity and app metadata with full-color source app icons,
  composite thumbnails, theme/accent cleanup, grid-cell polish, and tray preview
  consistency.
- Fixed capture and shell integration issues around Library z-order, Dock icon
  behavior, render-cache re-extraction, legacy composite migration toasts, and
  Linux `window.show` fallback behavior.
- Updated release and dependency policy docs to ban restricted-license
  dependencies and keep release packaging checks aligned with the shipped app.

## v1.0.0-beta.3 - 2026-05-19

- Added fast video capture support, including the native recorder pipeline,
  ffmpeg runtime packaging, video persistence, and playback/export surfaces.
- Added Codex-powered capture enrichment so new snaps can get generated
  titles, descriptions, suggested tags, and sensitive-content review metadata.
- Improved tray responsiveness by pre-warming the popover at boot and polished
  the last-snap preview aspect ratio to match the float-over surface.
- Cleaned up desktop build noise by silencing Swift recorder warnings,
  removing redundant main-process dynamic imports, and allowing the ffmpeg
  installer postinstall script needed for release packaging.
- Updated the release workflow artifact actions to versions that run on the
  Node.js 24 action runtime.

## v1.0.0-beta.2 - 2026-05-18

- Fixed universal macOS release packaging so the prebuilt window-list helper
  and Sharp's Darwin optional dependencies merge cleanly into the signed app.
- Tightened the native helper build cache so release builds rebuild the helper
  whenever a universal binary is required but the cached output is single-arch.

## v1.0.0-beta.1 - 2026-05-18

- Added app updates, update channel settings, and an update-ready banner so
  dogfood builds can move forward from inside PwrSnap.
- Added Settings coverage for themes, editable hotkeys, storage cache controls,
  developer-menu visibility, and app/tray entry points.
- Added Timed (5s) capture, native file drag, clipboard image paste, cache-path
  copying, and stronger tray last-snap actions.
- Improved capture reliability for window selection, source app filtering,
  capture preview timing, focus handling, and raw image clipboard formats.
- Improved library scale and polish with 100k-capture seeding, isolated filter
  state, optimized PNG copies, trash UX, and source-filter test hardening.
- Shipped MIT community standards, third-party license notices, bundled release
  documents, universal macOS DMG/ZIP artifacts, the stable `PwrSnap.dmg`
  download alias, and environment-gated Apple signing secrets.

## v1.0.0-alpha.3 - 2026-05-06

- Restored the missing tray icon in the packaged desktop app.

## v1.0.0-alpha.2 - 2026-05-06

- Decode the GitHub Actions `CSC_LINK` signing certificate secret to a
  temporary `.p12` file before invoking electron-builder.
- Re-cut the desktop alpha after the failed `v1.0.0-alpha.1` tag run.

## v1.0.0-alpha.1 - 2026-05-06

- Fixed the macOS entitlements plist so codesign can parse it during packaged
  builds.
- Re-cut the first desktop alpha after the failed `v1.0.0-alpha.0` tag run.

## v1.0.0-alpha.0 - 2026-05-06

- First closed-source desktop alpha for macOS arm64 dogfooding.
- Added the ScreenCaptureKit-powered capture flow with region/window modes,
  snap-to-window selection, source-app tracking, and focus-safe overlay
  choreography.
- Added the local library with grid, reel, and focus views, including thumbnail
  cache-busting, sticky day labels, filmstrip navigation, and detail-rail copy
  actions.
- Added editing and rendering support for arrows, rectangles, highlights, blur,
  text overlays, and correctly sized compositing/copy exports.
- Added tray and float-over surfaces with dynamic sizing, copy presets, and
  hardened popover dismissal behavior.
- Added the macOS release pipeline: custom DMG background, signed/notarized
  packaging workflow, metadata checks, asar-content verification, and CI gates.
