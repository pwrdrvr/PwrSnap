# Changelog

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
