import { readFileSync } from "node:fs";
import fc from "fast-check";
import { SizzleNarrationCuesSchema, SizzleTimelineSchema } from "@pwrsnap/shared";
import { expect, test } from "vitest";
import { z } from "zod";
import { sizzleSkillResources, sizzleSkillTool } from "../sizzle-skill";

test("every bundled skill file equals its canonical source and its relative Markdown links resolve in the catalog", () => {
  const catalog = new Map(sizzleSkillResources.map((file) => [file.uri, file]));
  for (const file of catalog.values()) {
    const source = new URL(`../../../../../../.agents/skills/pwrsnap-sizzle-reels/${file.path}`, import.meta.url);
    expect(file.text).toBe(readFileSync(source, "utf8"));
    for (const match of file.text.matchAll(/\]\(([^)]+)\)/g)) {
      const link = match[1]!;
      if (/^https?:/.test(link)) continue;
      expect(catalog.has(new URL(link, file.uri).href), link).toBe(true);
    }
  }
});

test("untrusted skill paths can select only a bundled catalog entry", () => {
  const schema = z.object(sizzleSkillTool.inputSchema);
  const paths = sizzleSkillResources.map((file) => file.path);
  fc.assert(fc.property(fc.oneof(fc.string(), fc.constantFrom(...paths)), (path) => {
    const parsed = schema.safeParse({ path });
    expect(parsed.success).toBe(paths.some((allowed) => allowed === path));
  }));
});

test("the served timeline and phrase-cue examples validate against the shipped tool schemas", () => {
  let examples = 0;
  for (const file of sizzleSkillResources) {
    for (const match of file.text.matchAll(/```json\n([\s\S]*?)\n```/g)) {
      const example = JSON.parse(match[1]!);
      if ("version" in example) SizzleTimelineSchema.parse(example);
      else SizzleNarrationCuesSchema.parse(example.cues);
      examples++;
    }
  }
  expect(examples).toBeGreaterThan(0);
});
