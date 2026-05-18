# Changelog

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
