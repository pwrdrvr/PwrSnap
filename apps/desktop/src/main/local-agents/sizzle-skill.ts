import { ok } from "@pwrsnap/shared";
import { z } from "zod";
import { ProtocolError, type McpServer } from "@modelcontextprotocol/server";
import { SkillsExtension, skillEntry } from "@modelcontextprotocol/server/ext/skills";
import skill from "../../../../../.agents/skills/pwrsnap-sizzle-reels/SKILL.md?raw";
import timeline from "../../../../../.agents/skills/pwrsnap-sizzle-reels/references/timeline.md?raw";
import agentMetadata from "../../../../../.agents/skills/pwrsnap-sizzle-reels/agents/openai.yaml?raw";
import type { AnyLocalAgentMcpTool } from "./mcp-tool-registry";

// Embed the canonical repo skill in the desktop bundle. Installed apps never
// depend on a checkout, arbitrary file paths, or a documentation network fetch.
export const SIZZLE_SKILL_URI = "skill://pwrsnap-sizzle-reels/SKILL.md";
const paths = ["SKILL.md", "references/timeline.md", "agents/openai.yaml"] as const;
const files = [
  {
    path: paths[0],
    name: "pwrsnap-sizzle-reels",
    title: "PwrSnap Sizzle Reels skill",
    description: "Author and revise launch/demo reels from app footage with continuous narration, phrase-timed pictures, music and QA.",
    text: skill
  },
  {
    path: paths[1],
    name: "pwrsnap-sizzle-reels-timeline",
    title: "Sizzle timeline reference",
    description: "Tool workflow, editable timeline examples, launch template, narration cues, audio policies and render QA.",
    text: timeline
  },
  {
    path: paths[2],
    name: "pwrsnap-sizzle-reels-agent-metadata",
    title: "Sizzle skill agent metadata",
    description: "UI metadata for the PwrSnap Sizzle Reels skill.",
    text: agentMetadata
  }
] as const;

export const sizzleSkillResources = files.map((file) => ({
  ...file,
  uri: `skill://pwrsnap-sizzle-reels/${file.path}`,
  mimeType: file.path.endsWith(".md") ? "text/markdown" : "application/yaml"
}));

// The official SDK parses every frontmatter field, validates the skill and
// publishes the complete raw-byte SHA-256/size manifest. No hand-copied YAML.
let entry: ReturnType<typeof skillEntry> | undefined;
export function getSizzleSkillEntry(): ReturnType<typeof skillEntry> {
  return entry ??= skillEntry("pwrsnap-sizzle-reels", Object.fromEntries(
    sizzleSkillResources.map((file) => [file.path, file.text])
  ));
}

export function attachSizzleSkill(mcp: McpServer, authorize: () => Promise<void>): void {
  new SkillsExtension({
    strict: true,
    cacheHint: { ttlMs: 0, cacheScope: "private" },
    source: {
      async list({ cursor }) {
        await authorize();
        if (cursor !== undefined) throw new ProtocolError(-32602, "Unknown skill cursor");
        return { skills: [await getSizzleSkillEntry()] };
      },
      async get(uri) {
        await authorize();
        return uri === SIZZLE_SKILL_URI ? getSizzleSkillEntry() : undefined;
      },
      async read(uri) {
        await authorize();
        const file = sizzleSkillResources.find((file) => file.uri === uri);
        return file === undefined ? undefined : { text: file.text, mimeType: file.mimeType };
      },
      async listResources() {
        await authorize();
        const { frontmatter } = await getSizzleSkillEntry();
        return sizzleSkillResources.map(({ text: _text, path: _path, ...metadata }) => ({
          ...metadata,
          ...(metadata.uri === SIZZLE_SKILL_URI ? { description: frontmatter.description } : {})
        }));
      }
    }
  }).attach(mcp);
}

export const sizzleSkillTool: AnyLocalAgentMcpTool = {
  name: "pwrsnap_sizzle_skill",
  title: "Read PwrSnap Sizzle Reels Skill",
  description: "Read the bundled skill before building or revising a launch/demo video through PwrSnap. Covers real app footage, one continuous voiceover, word-timed scene transitions, supplied or sample-free music, ducking, editable bindings, previews and final QA. Omit path for SKILL.md; read references/timeline.md for concrete inputs and examples. Returns the same Markdown as MCP resources/list and resources/read, matching this desktop release. Read-only; no inference, rendering, private-media access or media budgets.",
  inputSchema: { path: z.enum(paths).default("SKILL.md") },
  requiredCapabilities: [],
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  },
  dispatch: async ({ path }) => ok({
    ...sizzleSkillResources.find((file) => file.path === path)!,
    resources: sizzleSkillResources.map(({ text: _text, ...metadata }) => metadata)
  })
};
