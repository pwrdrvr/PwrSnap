// Which backend a caption provider selector runs on. Main (arming the caption
// fallback) and Settings (presenting it) must agree, so both read this.

/** "" and "codex" are Codex, and so is an `acp:<id>` whose agent is not
 *  enabled: the run resolver sends that to Codex too. Anything else is its
 *  own backend. */
export function enrichmentProviderBackend(
  provider: string | undefined,
  enabledAgentIds: readonly string[]
): string {
  if (provider === undefined || provider === "" || provider === "codex") return "codex";
  if (provider.startsWith("acp:") && !enabledAgentIds.includes(provider.slice("acp:".length))) return "codex";
  return provider;
}
