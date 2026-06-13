// Library-process activation for user-facing window opens.
//
// The supervisor `spawn()`s the library child directly, so Launch
// Services never activates it the way a Finder/Dock launch would.
// A non-active app's `win.show()`/`win.focus()` orders the window in
// but leaves it BEHIND the user's frontmost app (a Library window
// opening behind the terminal reads as "nothing happened"). Only
// `app.focus({ steal: true })` — NSApp activateIgnoringOtherApps —
// brings the process forward.
//
// Library-role-only on purpose: in combined mode the existing window
// choreography already works, and the agent must never activate.

import { app } from "electron";
import { getRuntimeProcessRole } from "../process-role";

export function activateForUserSurface(): void {
  if (process.platform !== "darwin") return;
  if (getRuntimeProcessRole() !== "library") return;
  app.focus({ steal: true });
}
