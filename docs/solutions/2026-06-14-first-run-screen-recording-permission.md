# First-run Screen Recording permission — "Not yet requested" vs "Denied"

**Date:** 2026-06-14
**Reported symptom:** Brand-new install flow was self-contradictory:

1. User installs PwrSnap and launches it.
2. The app immediately opens Settings → System Permissions claiming
   Screen Recording was **Denied**, with an **Open System Settings**
   button.
3. Dead end: PwrSnap had never attempted a capture, so macOS never
   prompted, never recorded a decision, and **never added PwrSnap to the
   Privacy → Screen & System Audio Recording list**. The "Open System
   Settings" button drops the user on a pane where PwrSnap isn't even
   listed — there is no checkbox to flip.

## Root cause — macOS has no `not-determined` for screen

`systemPreferences.getMediaAccessStatus('screen')` is backed by the
**boolean** `CGPreflightScreenCaptureAccess()`. It returns only
`granted` or `denied` — it **never** returns `not-determined` for the
`screen` media type (unlike `microphone` / `camera`, which TCC tracks
with a real not-determined state).

So on a fresh install, before PwrSnap has ever tried to capture, screen
reads `denied` — **indistinguishable from an explicit denial**. The
existing System Permissions page had a `not-determined → "Request
access"` branch, but it was **dead code for screen**: that status never
occurs on real macOS. Every fresh user hit the `denied` arm and the
dead-end "Open System Settings" button.

The other half of the quirk: the *only* way PwrSnap gets listed in the
Privacy pane at all is to **attempt a real screen-capture API call**
(`desktopCapturer.getSources`). That call both shows the OS's own
consent dialog **and** registers the bundle ID in the pane. Until that
happens, routing the user to System Settings is pointless.

## The fix

Because macOS won't tell us "never asked" vs "denied", **PwrSnap
remembers it itself**: `Settings.recording.screenCapturePrompted`
(additive field, no `schemaVersion` bump; defaults `false`,
back-filled in `parseV1`).

### 1. Disambiguated UI (`SystemPermissionsPage.tsx`)

`permissions:readiness` now returns `PermissionReadinessReport` =
`RecordingReadiness` + `screenCapturePrompted`. The page synthesizes an
effective status for screen / system-audio: when not granted **and**
`screenCapturePrompted === false`, it shows **"Not yet requested"**
(neutral tone) with a **Request access** button that fires the real OS
prompt via `permissions:request` (→ `desktopCapturer.getSources`).
Once we've asked, it shows **"Denied"** with **Open System Settings**
plus relaunch guidance. `permissions:request` for screen/systemAudio now
**always** drives the prompt (it's only called when we haven't asked);
the handler sets `screenCapturePrompted` afterward.

### 2. Pre-capture gate (`capture/screen-permission-gate.ts`)

`guardScreenCapture()` is the single chokepoint every screen-capturing
command funnels through (`capture:interactive`, `capture:fullScreen`,
`capture:allScreens`, `capture:region`, `recording:start` — all
transports: renderer dispatch, global hotkeys, tray). It runs **before**
the selector's frozen-screen snapshot (which is all-black without the
grant). Three branches:

- **granted** → proceed.
- **not granted, never asked** → issue a real grab to fire the macOS
  prompt, record that we asked, then stop. **The OS dialog is the UI —
  we do NOT pop our own Settings window on top of it.** (Per product
  decision: we don't prompt the user ourselves; the OS does. We just
  need to *try* a grab so the OS prompts.)
- **not granted, asked before** → macOS won't prompt twice, so open
  Settings → System Permissions and stop.

"Continue if possible": the granted check reads `getMediaAccessStatus`,
which on some macOS versions flips to `granted` in-session right after
the user toggles the checkbox — those users flow straight into the
capture. Where it stays stale until relaunch, the next attempt routes to
Settings, whose copy says to relaunch. We **never force-relaunch** the
running process (passive guidance).

## Gotchas for anyone touching this

- **Do not** reintroduce a screen `not-determined` code path expecting
  macOS to produce it — it won't. `screenCapturePrompted` is the only
  signal that distinguishes never-asked from denied.
- **`desktopCapturer.getSources` is not a reliable *granted* check.**
  When denied it can still return a non-empty source array with
  **black** thumbnails. Use it to *trigger* the prompt, not to *detect*
  the grant. For the grant check, `getMediaAccessStatus` is authoritative
  (modulo the stale-until-relaunch lag).
- **`tccutil reset ScreenCapture`** clears macOS's decision *and* the
  Privacy-pane listing but leaves `screenCapturePrompted = true` in our
  settings, so the gate would route to a pane that no longer lists us.
  The gate tolerates this: a settings-read failure defaults to
  never-asked, and the worst case is one extra harmless prompt attempt.
  If this becomes a real complaint, re-prompt when
  `screenCapturePrompted` is true but the pane listing is gone (no clean
  API for "are we listed", so we'd just always try the prompt first).
- The separate `capture/permissions.ts` module (`checkPermission`,
  `openSystemSettingsForPermission`) is **unused** outside its own file
  (only `classifyCaptureError` is live, in `screencapture.ts`). Don't
  resurrect `checkPermission` as a competing gate.

## Touched files

- `packages/shared/src/protocol.ts` — `recording.screenCapturePrompted`,
  `PermissionReadinessReport`, `permissions:readiness` res.
- `apps/desktop/src/main/settings/desktop-settings-service.ts` — default
  + `parseV1`.
- `apps/desktop/src/main/handlers/settings-validators.ts` — allow the
  new boolean key.
- `apps/desktop/src/main/recording/recording-permissions.ts` — export
  `readScreenStatus` / `triggerScreenCapturePrompt`; screen/systemAudio
  request always drives the prompt.
- `apps/desktop/src/main/capture/screen-permission-gate.ts` — **new**
  gate + flag accessors.
- `apps/desktop/src/main/handlers/recording-handlers.ts` — readiness
  report, flag-marking on request, `recording:start` gate.
- `apps/desktop/src/main/handlers/capture-handlers.ts` — gate on the
  screen-capturing entrypoints.
- `apps/desktop/src/renderer/src/features/settings/pages/SystemPermissionsPage.tsx`
  — effective status, friendly copy.
- Tests: `screen-permission-gate.test.ts` (new), updated
  `recording-permissions.test.ts`.
