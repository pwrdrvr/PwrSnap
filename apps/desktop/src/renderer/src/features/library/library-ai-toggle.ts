export type LibraryAiToggleAction = "disable" | "configure" | "consent" | "enable";

export function resolveLibraryAiToggleAction(params: {
  aiEnabled: boolean;
  aiConsentAcceptedAt: string | null;
  codexAvailable: boolean | undefined;
}): LibraryAiToggleAction {
  if (params.aiEnabled) return "disable";
  if (params.codexAvailable === false) return "configure";
  if (params.aiConsentAcceptedAt === null) return "consent";
  return "enable";
}
