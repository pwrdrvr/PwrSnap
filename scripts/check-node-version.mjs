#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), "..");
const nvmrcPath = resolve(repoRoot, ".nvmrc");
const expected = readFileSync(nvmrcPath, "utf8").trim();
const actual = process.version;

if (actual !== expected) {
  console.error(
    [
      `[check-node-version] expected Node ${expected} from .nvmrc, got ${actual}.`,
      "Run: source ~/.nvm/nvm.sh && nvm use",
      "Then re-run pnpm install from the repo root."
    ].join("\n")
  );
  process.exit(1);
}

const nvmDir = process.env.NVM_DIR ?? resolve(process.env.HOME ?? "", ".nvm");
const nvmExists = nvmDir.length > 0 && existsSync(nvmDir);
const isCi = process.env.CI === "true" || process.env.CI === "1";

if (nvmExists && !isCi) {
  const nodePath = process.execPath;
  const normalizedNvmDir = resolve(nvmDir);
  if (!nodePath.startsWith(`${normalizedNvmDir}/`)) {
    console.error(
      [
        `[check-node-version] Node ${actual} is not running from nvm.`,
        `node path: ${nodePath}`,
        `nvm dir: ${normalizedNvmDir}`,
        "Run: source ~/.nvm/nvm.sh && nvm use"
      ].join("\n")
    );
    process.exit(1);
  }
}
