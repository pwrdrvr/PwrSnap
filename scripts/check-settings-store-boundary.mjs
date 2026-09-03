#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isCliEntrypoint } from "./lib/cli-entrypoint.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mainRoot = join(repoRoot, "apps/desktop/src/main");
const STORE = "settings/desktop-settings-store.ts";
const SERVICE = "settings/desktop-settings-service.ts";
const SETTINGS_HANDLER = "handlers/settings-handlers.ts";
const ACP_HANDLER = "handlers/acp-handlers.ts";
const EVENT_RELAY = "process-split/event-relay.ts";
const PROCESS_SPLIT_PEEK = "process-split/settings-peek.ts";
const INDEX = "index.ts";
const AGENT_COMMAND = "ai/agent-command.ts";
const AGENT_KIT_BINDINGS = "ai/agent-kit-bindings.ts";
const CODEX_DISCOVERY = "settings/codex-discovery.ts";
const CODEX_PROFILE_HANDLER = "handlers/codex-profile-handlers.ts";
const SETTINGS_VALIDATORS = "handlers/settings-validators.ts";

function* productionTypeScriptFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* productionTypeScriptFiles(path);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts")
    ) {
      yield path;
    }
  }
}

function sourceName(root, path) {
  return relative(root, path).split(sep).join("/");
}

function moduleSpecifiers(source) {
  const specifiers = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    if (match[1] !== undefined) specifiers.push(match[1]);
  }
  return specifiers;
}

function referencesModule(source, suffix) {
  return moduleSpecifiers(source).some(
    (specifier) =>
      specifier.startsWith(".") &&
      (specifier === `./${suffix}` || specifier.endsWith(`/${suffix}`))
  );
}

function allowed(name, allowedNames) {
  return allowedNames.includes(name);
}

export function checkSettingsStoreBoundary(root = mainRoot) {
  const failures = [];
  for (const path of productionTypeScriptFiles(root)) {
    const name = sourceName(root, path);
    const source = readFileSync(path, "utf8");
    const modules = moduleSpecifiers(source);

    if (source.includes("desktop-settings-service") && name !== STORE) {
      failures.push(
        `${name}: raw settings persistence is private; use getDesktopSettingsStore()`
      );
    }
    if (referencesModule(source, "codex-discovery") && name !== STORE) {
      failures.push(
        `${name}: raw Codex discovery/probes are private; use DesktopSettingsStore publications`
      );
    }
    if (
      modules.includes("@pwrdrvr/codex-discovery") &&
      !allowed(name, [
        AGENT_KIT_BINDINGS,
        CODEX_DISCOVERY,
        CODEX_PROFILE_HANDLER,
        SETTINGS_VALIDATORS
      ])
    ) {
      failures.push(
        `${name}: direct Codex kit discovery/probes are restricted to the store adapter or explicit profile handler`
      );
    }
    if (
      /\bdiscoverLocalAcp(?:AgentInstances|Agents)\b/.test(source) &&
      name !== STORE
    ) {
      failures.push(
        `${name}: raw ACP discovery is private; use DesktopSettingsStore publications`
      );
    }
    if (
      source.includes("pwrsnap-settings.json") &&
      !allowed(name, [STORE, PROCESS_SPLIT_PEEK])
    ) {
      failures.push(
        `${name}: direct settings-file access is forbidden; use getDesktopSettingsStore()`
      );
    }
    if (/\bnew\s+DesktopSettingsStore\b/.test(source) && name !== STORE) {
      failures.push(
        `${name}: do not create a second settings store; use getDesktopSettingsStore()`
      );
    }
    if (
      /\bpeekExperimentalProcessSplit\b/.test(source) &&
      !allowed(name, [PROCESS_SPLIT_PEEK, INDEX])
    ) {
      failures.push(
        `${name}: the synchronous settings peek is restricted to pre-ready role selection`
      );
    }
    if (
      /\badoptTrusted(?:Peer)?Snapshot\b/.test(source) &&
      !allowed(name, [STORE, SERVICE, INDEX])
    ) {
      failures.push(
        `${name}: trusted peer snapshots may only enter through the split-process relay`
      );
    }
    if (
      /\badoptTrustedPeerDiscoveryPublication\b/.test(source) &&
      !allowed(name, [STORE, INDEX])
    ) {
      failures.push(
        `${name}: trusted peer discovery publications may only enter through split-process startup wiring`
      );
    }
    if (
      /\bgetCurrentCodexDiscoveryPublication\b/.test(source) &&
      !allowed(name, [STORE, SETTINGS_HANDLER])
    ) {
      failures.push(
        `${name}: Codex publication export is restricted to the Settings discovery handler`
      );
    }
    if (
      /\bgetCurrentAcpDiscoveryPublication\b/.test(source) &&
      !allowed(name, [STORE, ACP_HANDLER])
    ) {
      failures.push(
        `${name}: ACP publication export is restricted to the Settings discovery handler`
      );
    }
    if (
      /\brelaySettingsDiscoveryPublicationToPeer\b/.test(source) &&
      !allowed(name, [EVENT_RELAY, SETTINGS_HANDLER, ACP_HANDLER])
    ) {
      failures.push(
        `${name}: discovery publication relay is restricted to explicit Settings discovery handlers`
      );
    }
    if (/\bexecAgentCommandSync\b/.test(source) && name !== AGENT_COMMAND) {
      failures.push(
        `${name}: synchronous agent probes are forbidden; consume a settings-store publication`
      );
    }
    if (
      /\[\s*["']--version["']/.test(source) &&
      !allowed(name, [STORE, CODEX_DISCOVERY])
    ) {
      failures.push(
        `${name}: direct binary version probes are forbidden; consume the store-published version`
      );
    }
    if (
      /\brefreshCodexDiscoveryForUserRequest\b/.test(source) &&
      !allowed(name, [STORE, SETTINGS_HANDLER])
    ) {
      failures.push(
        `${name}: forced Codex discovery is restricted to the explicit Settings Refresh handler`
      );
    }
    if (
      /\brefreshAcpDiscoveryForUserRequest\b/.test(source) &&
      !allowed(name, [STORE, ACP_HANDLER])
    ) {
      failures.push(
        `${name}: forced ACP discovery is restricted to the explicit Settings Refresh handler`
      );
    }
    if (
      /\btestCodexForUserRequest\b/.test(source) &&
      !allowed(name, [STORE, SETTINGS_HANDLER])
    ) {
      failures.push(
        `${name}: the live Codex probe is restricted to the explicit Settings Test handler`
      );
    }
    if (
      /\b(?:discoverCodexAuthProfiles|checkCodexAuthStatus)\b/.test(source) &&
      name !== CODEX_PROFILE_HANDLER
    ) {
      failures.push(
        `${name}: Codex profile filesystem/status probes are restricted to the explicit Settings profile handler`
      );
    }
  }

  const storeSource = readFileSync(join(root, STORE), "utf8");
  if (/\b(?:async\s+)?reload\s*\(/.test(storeSource)) {
    failures.push(
      `${STORE}: a callable reload API is forbidden; restart or apply a trusted peer snapshot`
    );
  }

  return failures.sort((left, right) => left.localeCompare(right));
}

function runCli() {
  const failures = checkSettingsStoreBoundary();
  if (failures.length > 0) {
    console.error("settings store boundary check failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log("settings store boundary check passed");
}

if (isCliEntrypoint(import.meta.url)) runCli();
