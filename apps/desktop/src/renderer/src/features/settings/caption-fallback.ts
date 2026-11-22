// Settings → AI Features → Captions: what the caption fallback control offers.
//
// Main arms `ai.enrichmentFallback` whenever it names another backend than
// the primary (`enrichmentFallbackFor`). Behind a Codex primary it is used
// only when the Mac is offline, so the control there leaves Codex out, says
// "offline", and turning it on starts from a model that runs on this Mac.

/** One entry of the fallback's provider picker. */
export type CaptionFallbackOption = { value: string; label: string; disabled?: boolean };

/** Whether a provider selector runs on Codex: "" / "codex", or an ACP agent
 *  that is not enabled (main runs that on Codex too). */
export function runsOnCodex(provider: string | undefined, enabledAgentIds: readonly string[]): boolean {
  if (provider === undefined || provider === "" || provider === "codex") return true;
  return provider.startsWith("acp:") && !enabledAgentIds.includes(provider.slice("acp:".length));
}

/** The fallback a switch turned on stores. Behind Codex: the first pickable
 *  model that runs on this Mac, or null when there is none (nothing would
 *  caption offline, so the switch is disabled). Behind anything else: `{}`,
 *  Codex on PwrSnap's managed caption default, as before. */
export function captionFallbackOnValue(input: {
  primaryOnCodex: boolean;
  options: readonly CaptionFallbackOption[];
  onDevice: (provider: string) => boolean;
}): { provider?: string } | null {
  if (!input.primaryOnCodex) return {};
  const choice = input.options.find((option) => option.disabled !== true && input.onDevice(option.value));
  return choice === undefined ? null : { provider: choice.value };
}
