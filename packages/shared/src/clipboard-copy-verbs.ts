// The command verbs for copying a capture's rendered image preset to the
// clipboard. Shared between BOTH copy paths so they can never disagree:
//   • the renderer helper (renderer/src/lib/clipboard-copy.ts), used by the
//     tray, float-over, and Library card body / ⌘1·2·3, and
//   • the main-side float-over global shortcut (main/float-over.ts), which
//     fires while ANOTHER app has focus so the renderer keydown never runs.
//
// PR #232 drifted the Library surfaces to a file URL (`clipboard:copy-file`)
// while the others stayed on image bytes; centring the verb here means the
// "image bytes, not a file URL" decision lives in ONE place that both
// processes import.

/** Copy the rendered preset as raw IMAGE BYTES (pastes everywhere). */
export const IMAGE_PRESET_COPY_VERB = "clipboard:copy" as const;

/** Copy the rendered preset file's POSIX path as text (the FILE chip). */
export const IMAGE_PRESET_COPY_PATH_VERB = "clipboard:copy-path" as const;
