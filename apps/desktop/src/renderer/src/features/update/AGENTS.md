# features/update — AGENTS.md

The in-app update UI: the Library's update card, the compact rows in the tray
and float-over, Cancel, release-notes links, and the dev fake. **Before
changing any of it, or `auto-updater.ts`'s user-check path, read
[docs/agents/app-update-ui.md](../../../../../../../docs/agents/app-update-ui.md).**
It holds the full rules, and why each one exists. Reading code here needs none
of it.

- **Two channels, and they are not redundant.** `events:app-update:status`
  says what the updater is doing; `events:app-update:check-result` fires only
  for the Check for Updates… menu item. The live card needs both. A
  background download raises nothing.
- **In-flight gets a progress track; finished gets the countdown.**
- **The compact rows stay out of this.** Actionable states only.
- **Cancel is offered from `available`, so main must be ready by then.**
- **A cancel is not an error.** `canceled` is its own status.
- **Every wording has a downgrade twin.**
- **The `checking` tick is edge-triggered, so there is a snapshot beside
  it** (`app:update:userCheckRunning`, a count). The menu item goes over the
  bus.
- **The stand-in `checking` is held here, never written into the status.**
- **A newer release replaces a downloaded one.**
- **The dev fake is the only way to see any of this.**
- **A version the app names, it must also be able to describe.** Every
  surface that shows a version shows a `ReleaseNotesLink`, which takes a
  version, never a URL.
