# Changelog

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
