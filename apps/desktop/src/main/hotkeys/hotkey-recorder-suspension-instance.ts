import { getMainLogger } from "../log";
import { HotkeyRecorderSuspension } from "./hotkey-recorder-suspension";

/** Process-wide native ownership lease shared by every PwrSnap-owned native
 * shortcut: configured bindings plus transient Float-Over, selector, and
 * recording-controller registrations. */
export const hotkeyRecorderSuspension = new HotkeyRecorderSuspension({
  logger: getMainLogger("pwrsnap:shortcut-recorder")
});
