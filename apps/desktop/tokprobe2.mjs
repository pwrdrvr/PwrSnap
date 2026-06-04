import { CodexOneShotClient } from "@pwrdrvr/agent-client";
const CODEX = "/Applications/Codex.app/Contents/Resources/codex";
const schema = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } };
const OLD = { web_search: "disabled", include_permissions_instructions: false, include_apps_instructions: false, include_collaboration_mode_instructions: false, include_environment_context: false, skills: { include_instructions: false }, features: { apps: false, plugins: false, tool_suggest: false, image_generation: false, multi_agent: false, goals: false } };
const variants = {
  "current(OLD keys)": OLD,
  "+skills.bundled=off": { ...OLD, skills: { include_instructions: false, bundled: { enabled: false } } },
  "0133: skills.bundled+tools.web_search": { skills: { include_instructions: false, bundled: { enabled: false } }, tools: { web_search: false } },
};
async function probe(label, cfg, i) {
  const client = new CodexOneShotClient({ command: CODEX, serviceName: "pwrsnap", workspaceDir: "/tmp/pwrsnap-tp2-" + i, threadConfig: cfg, logger: { debug(){}, info(){}, warn(){}, error(){} } });
  try {
    const r = await client.run({ prompt: 'Reply {"ok":true}.', outputSchema: schema, baseInstructions: "Output only JSON.", effort: "low", model: "gpt-5.4-mini" });
    const u = r.tokenUsage ?? {};
    console.log(`${label.padEnd(38)} input=${(u.inputTokens??0)+(u.cachedInputTokens??0)} (uncached=${u.inputTokens} cached=${u.cachedInputTokens??0})`);
  } catch (e) { console.log(`${label.padEnd(38)} ERROR ${e.message}`); }
  await client.close?.();
}
let i = 0;
for (const [label, cfg] of Object.entries(variants)) { await probe(label, cfg, i++); }
process.exit(0);
