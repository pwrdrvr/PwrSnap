#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isCliEntrypoint } from "./lib/cli-entrypoint.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The root AGENTS.md is injected into every agent thread. Codex caps project
// instructions at `project_doc_max_bytes` (32 KiB by default) and silently
// drops everything past it: no error, no warning, the agent simply never sees
// the later rules. At 212,720 bytes the file was cut mid-sentence around line
// 760, so Codex agents never read most of the invariants in it. Claude Code
// loads the whole file, which made the same text ~53k tokens of every thread's
// first turn.
//
// The fix was progressive disclosure: topic rules live in docs/agents/*.md and
// the root keeps a one-line summary plus a "read this before ..." trigger.
// This gate keeps it that way. It fails when the root file grows past the cap,
// and when a docs/agents file is not linked from the root, because an unlinked
// topic file is a rule no agent is ever told to read.
export const AGENTS_MD_MAX_BYTES = 32 * 1024;
const ROOT_AGENTS = "AGENTS.md";
const TOPIC_DIR = "docs/agents";

export function checkAgentsMdSize(root = repoRoot) {
  const errors = [];
  const agentsPath = join(root, ROOT_AGENTS);
  if (!existsSync(agentsPath)) {
    return [`${ROOT_AGENTS} is missing`];
  }
  const bytes = statSync(agentsPath).size;
  if (bytes > AGENTS_MD_MAX_BYTES) {
    errors.push(
      `${ROOT_AGENTS} is ${bytes} bytes; the limit is ${AGENTS_MD_MAX_BYTES} ` +
        `(Codex's default project_doc_max_bytes truncates the rest silently). ` +
        `Move the detail into ${TOPIC_DIR}/ and leave a one-line summary.`,
    );
  }
  const text = readFileSync(agentsPath, "utf8");
  const topicDir = join(root, TOPIC_DIR);
  if (existsSync(topicDir)) {
    for (const name of readdirSync(topicDir).sort()) {
      if (!name.endsWith(".md")) continue;
      const link = `(${TOPIC_DIR}/${name})`;
      if (!text.includes(link)) {
        errors.push(`${TOPIC_DIR}/${name} is not linked from ${ROOT_AGENTS}`);
      }
    }
  }
  return errors;
}

function runCli() {
  const errors = checkAgentsMdSize();
  if (errors.length > 0) {
    for (const error of errors) console.error(`agents-md:check: ${error}`);
    process.exit(1);
  }
  const bytes = statSync(join(repoRoot, ROOT_AGENTS)).size;
  console.log(`agents-md:check: ${ROOT_AGENTS} is ${bytes} / ${AGENTS_MD_MAX_BYTES} bytes`);
}

if (isCliEntrypoint(import.meta.url)) {
  runCli();
}
