import type { LocalAgentCapability } from "@pwrsnap/shared";

export const LOCAL_AGENT_CAPABILITY_LABELS: Record<LocalAgentCapability, string> = {
  "library.read": "Search library metadata",
  "capture.composite.read": "Read edited images",
  "capture.original.read": "Read original images",
  "capture.export": "Export and convert images",
  "capture.edit": "Edit images with AI",
  "trash.write": "Move captures to Trash",
  "sizzle.compose": "Create sizzle reels",
  "sizzle.assets.import": "Import local media into reels",
  "sizzle.preview.read":
    "Render low-resolution reel previews (may use billable TTS/network access, write cache files, and update project state)",
  "sizzle.full.read":
    "Render full-resolution reels (may use billable TTS/network access, write to Videos, and update project state)"
};

export const LOCAL_AGENT_CAPABILITY_DETAILS: Record<LocalAgentCapability, string> = {
  "library.read": "Reads capture titles, OCR snippets, tags, and other searchable metadata.",
  "capture.composite.read":
    "Reads images as currently shown, including visible edits and redactions.",
  "capture.original.read":
    "Reads source pixels and may reveal content hidden by crops or redactions.",
  "capture.export": "Creates downloadable image or PDF derivatives from permitted source images.",
  "capture.edit": "Changes captures by sending edit instructions through PwrSnap-owned AI threads.",
  "trash.write": "Moves captures out of the library and into recoverable PwrSnap Trash.",
  "sizzle.compose": "Creates and changes reel projects through PwrSnap-owned AI threads.",
  "sizzle.preview.read": "Reads low-resolution rendered reel media.",
  "sizzle.full.read": "Reads full-resolution rendered reel media."
};
