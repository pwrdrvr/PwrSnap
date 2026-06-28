// Single source of truth for copying a capture's rendered image preset to
// the clipboard. Every surface that offers a Low/Med/High copy — the tray
// popover, the post-capture float-over, the Library card body, and the
// ⌘1/⌘2/⌘3 keyboard shortcut — routes through here so they ALL put the
// same thing on the clipboard.
//
// Why this exists: PR #232 (export-filename work) drifted the Library card
// body AND the ⌘1/2/3 shortcut from `clipboard:copy` (image bytes) to
// `clipboard:copy-file` (a file URL), while the tray + float-over stayed on
// image bytes. The file-URL copy can't be pasted back into PwrSnap (under
// Universal Clipboard it reads back as "no image"). Per-surface dispatch
// calls let that drift slip in twice; funnelling through one helper makes
// it a single-line, single-test contract.

import {
  IMAGE_PRESET_COPY_PATH_VERB,
  IMAGE_PRESET_COPY_VERB
} from "@pwrsnap/shared";
import { dispatch } from "./pwrsnap";

export type ImageCopyPreset = "low" | "med" | "high";

/** Copy the capture's rendered preset to the clipboard as raw IMAGE BYTES
 *  (`clipboard:copy`). This is what pastes everywhere — back into PwrSnap
 *  (File → New → Paste from Clipboard), Claude, Slack, Mail. The verb is
 *  shared with the main-side float-over shortcut so the two can't drift. */
export function copyImagePreset(captureId: string, preset: ImageCopyPreset): void {
  void dispatch(IMAGE_PRESET_COPY_VERB, { captureId, preset });
}

/** Copy the POSIX path of the capture's rendered preset file as text
 *  (`clipboard:copy-path`) — the FILE chip's secondary affordance. Kept
 *  here so the path copy stays in lockstep across surfaces too. */
export function copyImagePresetPath(captureId: string, preset: ImageCopyPreset): void {
  void dispatch(IMAGE_PRESET_COPY_PATH_VERB, { captureId, preset });
}
