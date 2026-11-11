import { ok } from "@pwrsnap/shared";
import { z } from "zod";
import skill from "../../../../../.agents/skills/pwrsnap-sizzle-reels/SKILL.md?raw";
import timeline from "../../../../../.agents/skills/pwrsnap-sizzle-reels/references/timeline.md?raw";
import type { AnyLocalAgentMcpTool } from "./mcp-tool-registry";

// Embed the canonical repo skill in the desktop bundle. Installed apps never
// depend on a checkout, arbitrary file paths, or a documentation network fetch.
export const SIZZLE_SKILL_URI = "pwrsnap://skills/pwrsnap-sizzle-reels/SKILL.md";
const paths = ["SKILL.md", "references/timeline.md"] as const;
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
  }
] as const;

export const sizzleSkillResources = files.map((file) => ({
  ...file,
  uri: `pwrsnap://skills/pwrsnap-sizzle-reels/${file.path}`,
  mimeType: "text/markdown"
}));

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
