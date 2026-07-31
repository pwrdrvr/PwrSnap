import { dialog } from "electron";
import type { LocalAgentCapability } from "@pwrsnap/shared";

const CAPABILITY_LABELS: Record<LocalAgentCapability, string> = {
  "library.read": "Search library metadata",
  "capture.composite.read": "Read edited images",
  "capture.original.read": "Read original images (sensitive)",
  "capture.export": "Export and convert images",
  "capture.edit": "Edit images with AI",
  "trash.write": "Move captures to Trash (sensitive)",
  "sizzle.compose": "Create sizzle reels",
  "sizzle.preview.read": "Read low-resolution reel previews",
  "sizzle.full.read": "Read full-resolution reels (sensitive)"
};

export type LocalAgentPairingApprovalRequest = {
  name: string;
  capabilities: readonly LocalAgentCapability[];
};

export async function approveLocalAgentPairing(
  request: LocalAgentPairingApprovalRequest
): Promise<boolean> {
  const scopes = request.capabilities
    .map((capability) => `• ${CAPABILITY_LABELS[capability]}`)
    .join("\n");
  const response = await dialog.showMessageBox({
    type: "warning",
    title: "Pair a local agent with PwrSnap?",
    message: `${request.name} wants to access PwrSnap`,
    detail:
      `Only approve this request if you just initiated it on this Mac.\n\nRequested access:\n${scopes}`,
    buttons: ["Deny", "Allow"],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  return response.response === 1;
}
