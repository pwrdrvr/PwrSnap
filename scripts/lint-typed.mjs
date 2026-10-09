import { spawnSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseSync } from "oxc-parser";
import { isCliEntrypoint } from "./lib/cli-entrypoint.mjs";

const root = resolve(import.meta.dirname, "..");
export function typedLintFiles(directory = root) {
  const config = JSON.parse(readFileSync(resolve(directory, "oxlint.typed.json"), "utf8"));
  return [...globSync(config.overrides.flatMap((override) => override.files),
    { cwd: directory, exclude: config.ignorePatterns })].sort();
}

export function typedLintPaths(directory = root) {
  const config = JSON.parse(readFileSync(resolve(directory, "oxlint.typed.json"), "utf8"));
  // Send directories to the CLI, not hundreds of filenames: the latter can
  // exceed Windows' command-line limit. Derive roots from the same inventory.
  return [...new Set(config.overrides.flatMap((override) => override.files).map((pattern) => {
    const wildcard = pattern.search(/[?*{[]/);
    if (wildcard < 0) return pattern;
    const prefix = pattern.slice(0, wildcard);
    return prefix.endsWith("/") ? prefix.slice(0, -1) : dirname(prefix);
  }))];
}

// A syntax-lint suppression must not hide a receiver bug in the typed pass.
// Parse comments: strings and regexes containing directive text are harmless.
export function typedSuppressionLines(filename, source) {
  if (!source.includes("eslint") && !source.includes("oxlint")) return [];
  const { comments } = parseSync(filename, source);
  return comments.filter(({ value }) => {
    const directive = value.split("--")[0].trim();
    const disable = /^(?:eslint|oxlint)-disable(?:-next-line|-line)?(?:\s+([\s\S]*))?$/.exec(directive);
    if (disable) {
      const rules = (disable[1] ?? "").trim().split(/[,\s]+/).filter(Boolean);
      return rules.length === 0 || rules.some((rule) => rule === "unbound-method" || rule.endsWith("/unbound-method"));
    }
    return /^eslint\s/.test(directive) && directive.includes("unbound-method");
  }).map(({ start }) => source.slice(0, start).split("\n").length);
}

if (isCliEntrypoint(import.meta.url)) {
  const files = typedLintFiles();
  const failures = files.flatMap((file) => typedSuppressionLines(file, readFileSync(resolve(root, file), "utf8"))
    .map((line) => `${file}:${line}: unbound-method cannot be suppressed inline; preserve the receiver`));
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else {
    const result = spawnSync(process.execPath,
      [resolve(root, "node_modules/oxlint/bin/oxlint"), "--config", "oxlint.typed.json", ...typedLintPaths()],
      { cwd: root, stdio: "inherit" });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
}
