// Codex auth-profile management for Settings → AI.
//
// Three command-bus verbs wrap @pwrdrvr/codex-discovery so the renderer can
// enumerate the user's Codex auth profiles (each a CODEX_HOME directory under
// `~/.codex/profiles` plus the System default `~/.codex`), create a new one,
// and (re-)login a profile through Codex's OAuth flow:
//
//   • codex:profiles:list   — discover + per-profile auth status + identity
//   • codex:profiles:create — createCodexAuthProfile + normalize/validate name
//   • codex:profiles:login  — CodexLoginManager.startProfileLogin (opens the
//                             scraped OAuth URL via shell.openExternal)
//
// Selecting the active profile is a plain `settings:write` patch to
// `codex.profile` (existing verb) — there is no separate "select" command;
// the persisted string IS the selection. This module never persists profile
// metadata: it derives everything from disk via the kit at read time.
//
// The kit packages are Electron-free. The ONLY Electron-touching seam is the
// single `CodexLoginManager` constructed here with PwrSnap's
// `shell.openExternal` (via agent-kit-bindings) injected — the host owns its
// lifetime, so `disposeCodexProfileHandlers()` kills any in-flight login
// children on app teardown.

import {
  CodexLoginManager,
  checkCodexAuthStatus,
  createCodexAuthProfile,
  discoverCodexAuthProfiles,
  resolveCodexHomeForProfile,
  resolveDefaultCodexHome,
  type CodexAuthProfileCandidate
} from "@pwrdrvr/codex-discovery";
import { err, ok } from "@pwrsnap/shared";
import type {
  DesktopCodexAuthProfile,
  DesktopCodexAuthProfileList,
  DesktopCodexAuthProfileStatus,
  DesktopCodexProfileLoginResult,
  PwrSnapError,
  Result,
  Settings
} from "@pwrsnap/shared";
import { openExternal, toAgentKitLogger } from "../ai/agent-kit-bindings";
import { bus } from "../command-bus";
import { getMainLogger } from "../log";
import { resolveCodexCommand } from "../settings/codex-discovery";
import {
  validateCodexProfileCreate,
  validateCodexProfileLogin
} from "./settings-validators";

const log = getMainLogger("pwrsnap:codex-profile-handlers");

/** Read settings via the bus so the handlers ride the same substrate as the
 *  rest of main. Injectable for tests. */
export type SettingsReader = () => Promise<Settings>;

async function defaultSettingsReader(): Promise<Settings> {
  const result = await bus.dispatch("settings:read", {}, { principal: "ipc" });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/** Resolve the Codex CLI command the same way the settings service does:
 *  honor a pinned path, else fall through to discovery (which itself falls
 *  back to the bare `codex` on $PATH). Never throws — a clean ENOENT later
 *  surfaces through the spawn. */
async function resolveCommandForSettings(settings: Settings): Promise<string> {
  const configured =
    settings.codex.mode === "pinned" && settings.codex.pinnedPath !== ""
      ? settings.codex.pinnedPath
      : "codex";
  try {
    const resolved = await resolveCodexCommand({
      command: configured,
      env: process.env
    });
    return resolved.command;
  } catch {
    return configured;
  }
}

function toProfileStatus(
  status: "authenticated" | "unauthenticated" | "failed"
): DesktopCodexAuthProfileStatus {
  return status;
}

/** Map a kit discovery candidate + its (already-resolved) auth status onto
 *  the protocol shape the renderer consumes. */
function toDesktopProfile(
  candidate: CodexAuthProfileCandidate,
  status: DesktopCodexAuthProfileStatus,
  identity: { email?: string; planType?: string }
): DesktopCodexAuthProfile {
  return {
    name: candidate.name,
    displayName: candidate.displayName,
    codexHome: candidate.codexHome,
    selected: candidate.selected,
    hasAuthFile: candidate.hasAuthFile,
    status,
    ...(identity.email !== undefined ? { email: identity.email } : {}),
    ...(identity.planType !== undefined ? { planType: identity.planType } : {})
  };
}

function toCodexError(
  code: string,
  message: string,
  cause?: unknown
): PwrSnapError {
  return { kind: "settings", code, message, cause };
}

// ---- single login manager (the only Electron-touching seam) ----

let loginManager: CodexLoginManager | null = null;

function ensureLoginManager(): CodexLoginManager {
  if (loginManager === null) {
    loginManager = new CodexLoginManager({
      logger: toAgentKitLogger("pwrsnap:codex-login"),
      openExternal
    });
  }
  return loginManager;
}

/** Kill any in-flight `codex login` children. Call on app teardown. */
export function disposeCodexProfileHandlers(): void {
  loginManager?.dispose();
  loginManager = null;
}

/** Test seam: inject a fake manager (or reset to null). Production never
 *  touches this. */
export function __setCodexLoginManagerForTests(
  injected: CodexLoginManager | null
): void {
  loginManager = injected;
}

export function registerCodexProfileHandlers(params?: {
  settingsReader?: SettingsReader;
  loginManager?: CodexLoginManager;
}): void {
  const settingsReader = params?.settingsReader ?? defaultSettingsReader;
  if (params?.loginManager !== undefined) {
    loginManager = params.loginManager;
  }

  bus.register("codex:profiles:list", async (): Promise<
    Result<DesktopCodexAuthProfileList, PwrSnapError>
  > => {
    let settings: Settings;
    try {
      settings = await settingsReader();
    } catch (cause) {
      return err(
        toCodexError(
          "read_failed",
          cause instanceof Error ? cause.message : String(cause),
          cause
        )
      );
    }
    const command = await resolveCommandForSettings(settings);
    const snapshot = discoverCodexAuthProfiles({
      configuredProfile: settings.codex.profile
    });

    // Probe `codex login status` for each profile in parallel. The kit's
    // discovery already surfaces `hasAuthFile` + the JWT email from disk
    // cheaply; the status probe spawns `codex login status` per profile to
    // distinguish authenticated / expired / unauthenticated authoritatively.
    const profiles = await Promise.all(
      snapshot.profiles.map(async (candidate) => {
        try {
          const authStatus = await checkCodexAuthStatus({
            command,
            codexHome: candidate.codexHome,
            profile: candidate.name
          });
          return toDesktopProfile(candidate, toProfileStatus(authStatus.status), {
            ...(authStatus.email !== undefined ? { email: authStatus.email } : {}),
            ...(authStatus.planType !== undefined
              ? { planType: authStatus.planType }
              : {})
          });
        } catch (cause) {
          log.warn("codex:profiles:list: auth status probe failed", {
            profile: candidate.name,
            message: cause instanceof Error ? cause.message : String(cause)
          });
          // Fall back to the disk-only signal: a present auth.json with no
          // confirmable status reads as "failed" so the UI surfaces a probe
          // problem rather than silently claiming signed-in.
          return toDesktopProfile(
            candidate,
            candidate.hasAuthFile ? "failed" : "unauthenticated",
            {
              ...(candidate.accountEmail !== undefined
                ? { email: candidate.accountEmail }
                : {})
            }
          );
        }
      })
    );

    return ok({
      profileRoot: snapshot.profileRoot,
      effectiveCodexHome: snapshot.effectiveCodexHome,
      profiles,
      ...(snapshot.error !== undefined ? { error: snapshot.error } : {})
    });
  });

  bus.register("codex:profiles:create", async (req): Promise<
    Result<DesktopCodexAuthProfile, PwrSnapError>
  > => {
    const validated = validateCodexProfileCreate(req);
    if (!validated.ok) return err(validated.error);
    const name = validated.value.name;

    let settings: Settings;
    try {
      settings = await settingsReader();
    } catch (cause) {
      return err(
        toCodexError(
          "read_failed",
          cause instanceof Error ? cause.message : String(cause),
          cause
        )
      );
    }

    let created: { profile: string; codexHome: string; created: boolean };
    try {
      created = createCodexAuthProfile(name);
    } catch (cause) {
      return err(
        toCodexError(
          "profile_create_failed",
          cause instanceof Error ? cause.message : String(cause),
          cause
        )
      );
    }

    // A freshly-created profile has no auth.json yet; report its status so
    // the renderer can prompt a login. Best-effort — never fail the create
    // on a status probe error.
    const command = await resolveCommandForSettings(settings);
    let status: DesktopCodexAuthProfileStatus = "unauthenticated";
    let identity: { email?: string; planType?: string } = {};
    try {
      const authStatus = await checkCodexAuthStatus({
        command,
        codexHome: created.codexHome,
        profile: created.profile
      });
      status = toProfileStatus(authStatus.status);
      identity = {
        ...(authStatus.email !== undefined ? { email: authStatus.email } : {}),
        ...(authStatus.planType !== undefined
          ? { planType: authStatus.planType }
          : {})
      };
    } catch (cause) {
      log.warn("codex:profiles:create: post-create status probe failed", {
        profile: created.profile,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }

    return ok({
      name: created.profile,
      displayName: created.profile,
      codexHome: created.codexHome,
      // The new profile is not auto-selected; the renderer follows up with a
      // settings patch if the user wants it active.
      selected: settings.codex.profile === created.profile,
      hasAuthFile: status === "authenticated",
      status,
      ...(identity.email !== undefined ? { email: identity.email } : {}),
      ...(identity.planType !== undefined ? { planType: identity.planType } : {})
    });
  });

  bus.register("codex:profiles:login", async (req): Promise<
    Result<DesktopCodexProfileLoginResult, PwrSnapError>
  > => {
    const validated = validateCodexProfileLogin(req);
    if (!validated.ok) return err(validated.error);
    const name = validated.value.name;

    let settings: Settings;
    try {
      settings = await settingsReader();
    } catch (cause) {
      return err(
        toCodexError(
          "read_failed",
          cause instanceof Error ? cause.message : String(cause),
          cause
        )
      );
    }

    const command = await resolveCommandForSettings(settings);
    const codexHome =
      name === ""
        ? resolveDefaultCodexHome()
        : resolveCodexHomeForProfile(name) ?? resolveDefaultCodexHome();

    const manager = ensureLoginManager();
    let result: DesktopCodexProfileLoginResult;
    try {
      const loginResult = await manager.startProfileLogin({
        command,
        codexHome,
        profile: name
      });
      result = {
        profile: loginResult.profile,
        codexHome: loginResult.codexHome,
        started: loginResult.started,
        ...(loginResult.authenticated !== undefined
          ? { authenticated: loginResult.authenticated }
          : {}),
        ...(loginResult.loginUrl !== undefined
          ? { loginUrl: loginResult.loginUrl }
          : {}),
        ...(loginResult.detail !== undefined ? { detail: loginResult.detail } : {})
      };
    } catch (cause) {
      return err(
        toCodexError(
          "profile_login_failed",
          cause instanceof Error ? cause.message : String(cause),
          cause
        )
      );
    }

    return ok(result);
  });
}
