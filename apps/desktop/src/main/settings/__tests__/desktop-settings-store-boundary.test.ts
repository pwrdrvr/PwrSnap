import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const MAIN_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function productionTypeScriptFiles(directory = MAIN_ROOT): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...productionTypeScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

function productionRelativePath(path: string): string {
  return relative(MAIN_ROOT, path).replaceAll("\\", "/");
}

describe("desktop settings store ownership boundary", () => {
  test("only the store imports the raw settings persistence service", () => {
    const offenders = productionTypeScriptFiles().flatMap((path) => {
      const source = readFileSync(path, "utf8");
      if (!source.includes("desktop-settings-service")) return [];
      const name = productionRelativePath(path);
      return name === "settings/desktop-settings-store.ts" ? [] : [name];
    });
    expect(offenders).toEqual([]);
  });

  test("only the store invokes installed-agent discovery", () => {
    const offenders = productionTypeScriptFiles().flatMap((path) => {
      const source = readFileSync(path, "utf8");
      const importsRawDiscovery =
        /import[\s\S]*?\bdiscoverLocalAcpAgentInstances\b[\s\S]*?from\s+["']@pwrdrvr\/agent-acp["']/.test(
          source
        ) ||
        /import[\s\S]*?\bdiscoverCodexCommands\b[\s\S]*?from\s+["'].\/codex-discovery["']/.test(
          source
        );
      if (!importsRawDiscovery) return [];
      const name = productionRelativePath(path);
      return name === "settings/desktop-settings-store.ts" ? [] : [name];
    });
    expect(offenders).toEqual([]);
  });

  test("the only direct settings JSON read is the pre-ready process-split peek", () => {
    const rawReaders = productionTypeScriptFiles().flatMap((path) => {
      const source = readFileSync(path, "utf8");
      if (!/readFileSync\(settingsFilePath/.test(source)) return [];
      return [productionRelativePath(path)];
    });
    expect(rawReaders).toEqual(["process-split/settings-peek.ts"]);

    const startupAppearance = readFileSync(
      join(MAIN_ROOT, "settings/startup-appearance.ts"),
      "utf8"
    );
    expect(startupAppearance).not.toMatch(/node:fs|readFileSync|JSON\.parse/);
  });
});
