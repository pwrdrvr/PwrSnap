#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isCliEntrypoint } from "./lib/cli-entrypoint.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Electron fuses are flipped into the packaged binary at build time and are
// invisible from inside the running app -- there is no API that reads them
// back, so no test, no E2E run, and no code review of `apps/desktop/src` can
// observe a wrong one. The only feedback is a shipped installer. That is why
// the posture is pinned here, in `pnpm lint` (so on every PR), instead of only
// in `pnpm release:check`, which would find a regression at tag time.
//
// Each entry below names WHY the value is what it is. A fuse whose value is
// merely "the default" does not belong here; this file is for the ones where
// flipping the value silently changes what users get.
const ELECTRON_BUILDER = "apps/desktop/electron-builder.yml";

const REQUIRED_FUSES = {
  // Blocks ELECTRON_RUN_AS_NODE, which would otherwise turn the signed,
  // notarized app bundle into a general-purpose Node interpreter that inherits
  // its TCC grants (screen recording, Documents) and its keychain access.
  runAsNode: false,

  // MUST stay false -- this one is a UX invariant, not a hardening one, so it
  // is the entry most likely to be "fixed" back to true by a well-meaning
  // security pass. Enabling it makes Electron fetch the app's Safe Storage key
  // from the login keychain when the network service starts, before any window
  // exists, on every launch. PwrSnap stores no cookies (every window loads
  // file:// or data:; outbound HTTP goes through main-process Node fetch,
  // which has no Chromium cookie jar), so the fuse protects nothing and buys a
  // macOS keychain password prompt at startup for any binary not already on
  // that keychain item's access list. Revisit ONLY if a BrowserWindow starts
  // loading a remote origin that sets cookies worth protecting -- and then fix
  // the startup prompt deliberately rather than accepting it.
  // docs/solutions/2026-09-11-startup-keychain-prompt-cookie-encryption.md
  enableCookieEncryption: false,

  // Both would let an attacker who can set environment variables run their own
  // code inside the signed bundle.
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,

  // Together these are what make the asar the only code the app will load, and
  // make tampering with it fail closed.
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
};

/**
 * Parse the top-level `electronFuses:` block out of electron-builder.yml.
 *
 * Deliberately not a YAML dependency: this runs in `pnpm lint` on every PR and
 * the block is a flat scalar map, so a block reader is enough and cannot drag
 * a parser version into the lint path. Returns a `name -> raw string` map.
 */
export function parseElectronFusesBlock(yaml) {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => /^electronFuses:\s*(?:#.*)?$/.test(line));
  if (start === -1) return undefined;

  const fuses = {};
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue; // blank or whole-line comment
    if (!/^\s/.test(line)) break; // dedent to column 0 ends the block
    const match = /^\s+([A-Za-z0-9_]+):\s*(.*?)\s*$/.exec(line);
    if (match === null) {
      // A nested or non-scalar entry means the shape changed out from under
      // this reader. Surfacing it is the point -- do not guess.
      return { __parseError: `unexpected line in electronFuses block: ${JSON.stringify(line)}` };
    }
    fuses[match[1]] = match[2].replace(/\s+#.*$/, "");
  }
  return fuses;
}

export function checkElectronFusesPolicy(root = repoRoot) {
  const failures = [];

  let yaml;
  try {
    yaml = readFileSync(resolve(root, ELECTRON_BUILDER), "utf8");
  } catch (error) {
    return [
      `${ELECTRON_BUILDER} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }

  const fuses = parseElectronFusesBlock(yaml);
  if (fuses === undefined) {
    return [`${ELECTRON_BUILDER} has no top-level electronFuses block`];
  }
  if (fuses.__parseError !== undefined) {
    return [`${ELECTRON_BUILDER} ${fuses.__parseError}`];
  }

  for (const [name, expected] of Object.entries(REQUIRED_FUSES)) {
    const actual = fuses[name];
    if (actual === undefined) {
      failures.push(
        `${ELECTRON_BUILDER} electronFuses.${name} is missing; it must be explicitly ${expected}`,
      );
      continue;
    }
    if (actual !== String(expected)) {
      failures.push(
        `${ELECTRON_BUILDER} electronFuses.${name} must be ${expected}, got ${JSON.stringify(actual)}`,
      );
    }
  }

  return failures.sort((a, b) => a.localeCompare(b));
}

function runCli() {
  const failures = checkElectronFusesPolicy();
  if (failures.length > 0) {
    console.error("electron fuses policy check failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log("electron fuses policy check passed");
}

export { isCliEntrypoint, REQUIRED_FUSES };

if (isCliEntrypoint(import.meta.url)) {
  runCli();
}
