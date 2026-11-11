import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { SizzleNarrationCuesSchema, SizzleTimelineSchema } from "@pwrsnap/shared";
import { expect, test } from "vitest";
import { z } from "zod";
import { getSizzleSkillEntry, sizzleSkillResources, sizzleSkillTool } from "../sizzle-skill";

test("the manifest covers every canonical file with its raw-byte size and SHA-256", async () => {
  const root = fileURLToPath(new URL("../../../../../../.agents/skills/pwrsnap-sizzle-reels/", import.meta.url));
  const paths = readdirSync(root, { recursive: true }).map(String)
    .filter((path) => statSync(join(root, path)).isFile()).sort();
  const manifest = await getSizzleSkillEntry();
  if (manifest.resources === "dynamic") throw new Error("Static skill needs a verifiable manifest");
  const actual = manifest.resources.map((file) => file.uri.slice("skill://pwrsnap-sizzle-reels/".length)).sort();
  expect(actual).toEqual(paths.map((path) => path.replaceAll("\\", "/")));
  for (const file of manifest.resources) {
    const bytes = readFileSync(join(root, file.uri.slice("skill://pwrsnap-sizzle-reels/".length)));
    expect(file.size).toBe(bytes.length);
    expect(file.digest).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
  }
});

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
