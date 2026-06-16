---
date: 2026-06-15
topic: cursor-capture-control
---

# Cursor Capture Control

## Problem Frame

PwrSnap users have no control over the mouse cursor in captures. Video
**always** records the cursor (hardcoded `showsCursor = true` in the native
recorder) with no way to turn it off; images **never** include the cursor (the
macOS `screencapture` CLI drops it and offers no flag to keep it). Users who
want a cursor in a screenshot (to point at something) can't get one, and users
who want a clean screencast can't remove it.

The fix is one "capture cursor" concept that both modes honor. Because of how
the OS works, the two modes differ in what "control" can mean:

- **Video** composites the cursor into every frame, so the only possible
  control is a *pre-capture on/off* decision. It can never be edited out later.
- **Images** can carry the cursor as its own **layer** — captured exactly as it
  looked and where it was — which the user can then select, move, or delete in
  the editor. This is forgiving: even with capture-cursor on, an unwanted cursor
  is one delete away.

## Requirements

- **R1.** A single "Capture cursor" concept governs whether the pointer is
  included in captures, exposed as **two independent per-mode defaults**:
  `video` and `image`. Both default **ON**.
- **R2.** **Video — on:** the recording includes the cursor (today's behavior,
  preserved). **Video — off:** the recording omits the cursor. The decision is
  applied before recording starts and is fixed for that recording.
- **R3.** **Image — on:** the cursor is captured as its own layer — its real
  appearance (the actual system cursor image, correct for the display's scale)
  positioned where it was on screen. **Image — off:** no cursor is captured
  (today's behavior).
- **R4.** The image cursor layer is a normal, **selectable / movable /
  deletable** layer named "Cursor", placed on top of the capture. It is not
  locked — the user can grab it immediately. Deleting or moving it and then
  exporting/copying reflects the change.
- **R5.** Each mode's default is persisted in **Settings**. A quick **inline
  toggle** on an existing pre-capture surface (the region selector) lets the
  user flip the cursor on/off for the current capture **without a new blocking
  window**. Capture speed is unchanged when the toggle isn't touched.
- **R6.** For **region** and **window** captures, the image cursor layer is
  included only when the pointer falls within the captured bounds; otherwise no
  cursor layer is added even when the setting is on.

## Success Criteria

- With defaults untouched: video still shows the cursor, and an image now
  carries a deletable cursor layer. Turning a mode's setting off removes the
  cursor from that mode's output.
- A user can capture an image with the cursor, then select → move → delete the
  cursor in the editor, and the exported / copied result honors the edit.
- The captured image cursor matches what was on screen — correct shape (arrow,
  I-beam, hand, resize, etc.), position, and scale (retina-correct).
- No new blocking step is added to the capture flow; flipping the cursor for one
  capture is a single click on a surface that already appears.

## Scope Boundaries

- **Video cursor is never post-capture-editable.** It is baked into the pixels;
  making it a deletable layer in video is out of scope (impossible without a
  re-render/compositing engine — see plan §"Phase 6").
- No cursor-emphasis features: no click highlights / ripples, spotlight,
  cursor-zoom, or motion smoothing. This is presence + position only.
- No custom cursor replacement, restyling, or swapping the captured cursor for a
  different glyph.
- macOS only, consistent with the macOS-first phase scope. Cross-platform
  deferred.
- The inline toggle applies to the **current capture only**; changing the saved
  default is done in Settings (see Outstanding Questions if this should stick).

## Key Decisions

- **One concept, two independent per-mode defaults, both ON.** Preserves video's
  current behavior exactly; gives images WYSIWYG-but-forgiving behavior since the
  cursor is a deletable layer. Independent toggles because the modes' natural
  uses differ.
- **Image cursor = a deletable `RasterLayer`, reusing the existing v2 layer
  model.** The compositor (`composeV2` in `compose-tree.ts`) already renders an
  arbitrary raster at an arbitrary `x,y`, so no compositor changes are needed;
  the layer is inserted into the initial tree at capture time
  (`persistCaptureFromTempV2`). Lowest carrying cost, full post-hoc control.
- **No dedicated pre-capture config window.** Capture speed is the product's core
  value; a blocking config window before every capture regresses it. Control
  lives as a Settings default + an inline toggle on the region selector that
  already shows pre-capture.

## Dependencies / Assumptions

- **Settings substrate** (`@pwrsnap/shared` `Settings`/`SettingsPatch` +
  `DesktopSettingsService`): add the two per-mode defaults as an additive,
  nested change with defaults in `defaultSettings()`. No `schemaVersion` bump
  (additive). Renderer reads via the settings context.
- **Video off** requires plumbing a `showsCursor` flag from TypeScript through
  the recorder's `StartRequest` into the Swift binary (`main.swift`), replacing
  the hardcoded `true`.
- **Image on** requires net-new capture-time **cursor sampling** — the cursor's
  image, hotspot, and global screen position at the capture moment — which does
  not exist today. Mechanism is the central technical unknown (below).

## Outstanding Questions

### Resolve Before Planning

_(none — product shape is settled; the open items below are technical and are
better answered during planning/research.)_

### Deferred to Planning

- **[Affects R3][Needs research]** How do we obtain the *other app's* actual
  cursor sprite for a still image? macOS cursors are per-app/per-window;
  `NSCursor.currentSystemCursor` reflects our own process, not the foreground
  app. Candidate directions: capture the still via ScreenCaptureKit (which can
  include the cursor) instead of the `screencapture` CLI and diff a
  with-cursor vs without-cursor frame to extract the sprite + position; or a
  CoreGraphics/private-API path. Evaluate fidelity, latency, and permissions.
- **[Affects R3, R6][Technical]** Exactly *when* is the cursor sampled? During a
  **region** capture the on-screen cursor is our selection crosshair, so we must
  sample the user's real cursor (likely at hotkey-trigger time, before the
  selector takes over) and reconcile its position against the chosen region.
  Window and full-display captures are simpler.
- **[Affects R2, R5][Technical]** Where exactly does the inline toggle render and
  how does it reach `recording:start` before the SCStream begins (region
  selector toolbar is the primary candidate; recording HUD / tray are optional
  secondary surfaces)?
- **[Affects R5][User decision — minor]** Should flipping the inline toggle
  persist as the new default, or apply only to the current capture? Current
  assumption: per-capture only; defaults change in Settings.
- **[Affects R4][Technical]** Cursor layer z-order, naming, and whether it
  carries any provenance marker (`source`) distinguishing it from user-drawn
  layers; confirm export/copy paths include it.

## Next Steps

→ `/ce:plan` for structured implementation planning.
