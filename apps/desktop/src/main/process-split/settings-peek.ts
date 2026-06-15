// Synchronous, dependency-light peek at `experimental.processSplit`
// for boot-time role resolution. The role must be known before
// `app.whenReady()` (the single-instance lock and Dock policy depend
// on it), and the settings service is async — so this reads the file
// directly, read-only, no service instance. Any failure (missing
// file, unreadable JSON, absent field) returns the shipped default:
// OFF (single-process). Must match `defaultSettings()`. Never writes;
// the substrate's single-writer rule is untouched.

import { readFileSync } from "node:fs";

export function peekExperimentalProcessSplit(settingsFilePath: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(settingsFilePath, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) return false;
    const experimental = (raw as { experimental?: unknown }).experimental;
    if (typeof experimental !== "object" || experimental === null) return false;
    const value = (experimental as { processSplit?: unknown }).processSplit;
    return typeof value === "boolean" ? value : false;
  } catch {
    return false;
  }
}
