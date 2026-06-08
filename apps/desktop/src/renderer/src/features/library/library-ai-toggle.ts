export type LibraryAiToggleAction = "disable" | "configure" | "consent" | "enable";

export function resolveLibraryAiToggleAction(params: {
  aiEnabled: boolean;
  aiConsentAcceptedAt: string | null;
  /** Whether the SELECTED enrichment backend (Codex or the chosen ACP agent)
   *  is usable. `false` routes to configuration; `undefined` (still
   *  discovering) proceeds to consent/enable rather than blocking. */
  providerAvailable: boolean | undefined;
}): LibraryAiToggleAction {
  if (params.aiEnabled) return "disable";
  if (params.providerAvailable === false) return "configure";
  if (params.aiConsentAcceptedAt === null) return "consent";
  return "enable";
}
