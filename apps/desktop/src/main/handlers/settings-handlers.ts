// Lazy module-level singletons because `app.getPath("userData")` is
// unavailable at module load (tests mock `electron` without an app
// instance, production hasn't fired `app.whenReady()` yet). Every
// write broadcasts `events:settings:changed` to every BrowserWindow.

import { BrowserWindow, app } from "electron";
import { join } from "node:path";
import {
  ok,
  err,
  EVENT_CHANNELS,
  exportStrategyFromSettings,
  resolveLocalAgentPolicy
} from "@pwrsnap/shared";
import type {
  DesktopCodexDiscoverySnapshot,
  ExportStrategy,
  LocalAgentMcpListenerStatus,
  PwrSnapError,
  Result,
  SecretStatus,
  Settings,
  SettingsChangedEvent,
  SettingsNavigateEvent
} from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { activateForUserSurface } from "../process-split/activate-user-surface";
import { relayRendererEventToPeer } from "../process-split/event-relay";
import {
  createSettingsWindow,
  findSettingsWindow,
  positionSettingsWindowForSource
} from "../window";
import { getMainLogger } from "../log";
import {
  LocalAgentGrantError,
  LocalAgentGrantService
} from "../local-agents/local-agent-grants";
import { LocalAgentAuditService } from "../local-agents/local-agent-audit";
import { LocalAgentUsageService } from "../local-agents/local-agent-usage";
import { DesktopSettingsService } from "../settings/desktop-settings-service";
import {
  DesktopSecretStore,
  SecretUnavailableError
} from "../settings/desktop-secret-store";
import {
  validateClearSecret,
  validateRefreshCodexDiscovery,
  validateReplaceSecret,
  validateSettingsOpen,
  validateSettingsWrite
} from "./settings-validators";

const log = getMainLogger("pwrsnap:settings-handlers");

let settingsService: DesktopSettingsService | null = null;
let secretStore: DesktopSecretStore | null = null;
let localAgentGrantService: LocalAgentGrantService | null = null;
let localAgentAuditService: LocalAgentAuditService | null = null;
let localAgentUsageService: LocalAgentUsageService | null = null;

function ensureServices(): {
  service: DesktopSettingsService;
  secrets: DesktopSecretStore;
} {
  if (settingsService === null) {
    const userData = app.getPath("userData");
    settingsService = new DesktopSettingsService({
      filePath: join(userData, "pwrsnap-settings.json"),
      resolveAppVersion: () => {
        try {
          return typeof app.getVersion === "function" ? app.getVersion() : "";
        } catch {
          return "";
        }
      }
    });
  }
  if (secretStore === null) {
    const userData = app.getPath("userData");
    secretStore = new DesktopSecretStore({
      filePath: join(userData, "pwrsnap-secrets.bin")
    });
  }
  return { service: settingsService, secrets: secretStore };
}

export function getDesktopSettingsServices(): {
  service: DesktopSettingsService;
  secrets: DesktopSecretStore;
} {
  return ensureServices();
}

export function __setSettingsServicesForTests(injected: {
  service?: DesktopSettingsService | null;
  secrets?: DesktopSecretStore | null;
  usage?: LocalAgentUsageService | null;
}): void {
  if (injected.service !== undefined) settingsService = injected.service;
  if (injected.secrets !== undefined) secretStore = injected.secrets;
  if (injected.usage !== undefined) localAgentUsageService = injected.usage;
  localAgentGrantService = null;
  localAgentAuditService = null;
}

function getLocalAgentUsageService(): LocalAgentUsageService {
  localAgentUsageService ??= new LocalAgentUsageService();
  return localAgentUsageService;
}

/** Read the live settings snapshot for non-`settings:*` main handlers
 *  (e.g. the export path resolving the active preset ladder). Shares the
 *  same lazily-constructed `DesktopSettingsService` as the bus verbs, so
 *  a write made through `settings:write` is visible here on the next read
 *  (the service has no in-memory cache — `read()` re-parses the file). */
export async function readDesktopSettings(): Promise<Settings> {
  return ensureServices().service.read();
}

/** Resolve the export-preset strategy currently selected in Settings.
 *  Wrapped in try/catch so a settings read hiccup (corrupt file mid-write,
 *  no app instance in a unit test) degrades to the legacy fixed-width
 *  ladder — the export path must never throw on a settings problem. */
export async function getActiveExportStrategy(): Promise<ExportStrategy> {
  try {
    return exportStrategyFromSettings(await readDesktopSettings());
  } catch {
    return "legacy";
  }
}

/** Main-side listeners that want to react to settings changes (e.g.
 *  the dynamic global-shortcut registrar in `index.ts`) subscribe via
 *  `onSettingsChanged`. Renderer windows still get the
 *  `events:settings:changed` IPC broadcast; this is an *additional*
 *  main-only fan-out so we don't need to register a fake BrowserWindow
 *  shim to receive our own broadcasts. */
type MainSettingsListener = (settings: Settings) => void | Promise<void>;
const mainSettingsListeners = new Set<MainSettingsListener>();

export function onSettingsChanged(listener: MainSettingsListener): () => void {
  mainSettingsListeners.add(listener);
  return () => {
    mainSettingsListeners.delete(listener);
  };
}

async function broadcastSettingsChanged(
  service: DesktopSettingsService,
  secrets: DesktopSecretStore,
  overrides?: { settings?: Settings }
): Promise<void> {
  let payload: SettingsChangedEvent;
  try {
    const settings = overrides?.settings ?? (await service.read());
    const secretMap = await secrets.getAllStatus();
    payload = { settings, secrets: secretMap };
  } catch (cause) {
    log.warn("settings-handlers: failed to assemble broadcast payload", {
      message: cause instanceof Error ? cause.message : String(cause)
    });
    return;
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(EVENT_CHANNELS.settingsChanged, payload);
  }
  // Split mode: the library process's windows (Settings UI included)
  // subscribe to the same broadcast — relay once across the bridge.
  relayRendererEventToPeer(EVENT_CHANNELS.settingsChanged, payload);
  for (const listener of mainSettingsListeners) {
    try {
      await listener(payload.settings);
    } catch (cause) {
      log.warn("settings-handlers: main-side listener threw", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }
}

/** Test seam: reset main-side listeners between specs that exercise
 *  settings handlers + register listeners (the global shortcut
 *  registrar). Production code never touches this. */
export function __resetMainSettingsListenersForTests(): void {
  mainSettingsListeners.clear();
}

function toSettingsError(
  code: string,
  message: string,
  cause?: unknown
): PwrSnapError {
  return { kind: "settings", code, message, cause };
}

export function getLocalAgentGrantService(): LocalAgentGrantService {
  if (localAgentGrantService !== null) return localAgentGrantService;
  const { service, secrets } = ensureServices();
  localAgentGrantService = new LocalAgentGrantService({
    settings: service,
    secrets,
    onSettingsChanged: async (settings) => {
      await broadcastSettingsChanged(service, secrets, { settings });
    }
  });
  return localAgentGrantService;
}

export function getLocalAgentAuditService(): LocalAgentAuditService {
  if (localAgentAuditService !== null) return localAgentAuditService;
  const { service, secrets } = ensureServices();
  localAgentAuditService = new LocalAgentAuditService(
    service,
    async (settings) => {
      await broadcastSettingsChanged(service, secrets, { settings });
    }
  );
  return localAgentAuditService;
}

function toLocalAgentError(cause: unknown): PwrSnapError {
  if (cause instanceof LocalAgentGrantError) {
    return toSettingsError(cause.code, cause.message, cause);
  }
  return toSettingsError(
    "local_agent_failed",
    cause instanceof Error ? cause.message : String(cause),
    cause
  );
}

/** Combined-mode registration: both halves on one bus, exactly the
 *  pre-split behavior. Split mode registers the halves separately —
 *  the window verb with the library process, the data/secrets verbs
 *  with the agent (plan 2026-06-12-001 §D4/§D8). */
export function registerSettingsHandlers(): void {
  registerSettingsWindowHandlers();
  registerSettingsDataHandlers();
}

/** `settings:open` — opens/raises the Settings window, so it lives
 *  with the process that owns that window. */
export function registerSettingsWindowHandlers(): void {
  bus.register("settings:open", async (req, ctx) => {
    const validated = validateSettingsOpen(req);
    if (!validated.ok) return err(validated.error);
    const { page } = validated.value;
    const existing = findSettingsWindow();
    const placementSource: NonNullable<Parameters<typeof createSettingsWindow>[1]> = {};
    if (ctx.sourceWindowId !== undefined) {
      placementSource.sourceWindowId = ctx.sourceWindowId;
    }
    if (ctx.sourceBounds !== undefined) {
      placementSource.sourceBounds = ctx.sourceBounds;
    }
    if (existing !== null) {
      if (existing.isMinimized()) existing.restore();
      positionSettingsWindowForSource(existing, placementSource);
      if (!existing.isVisible()) existing.show();
      existing.focus();
      activateForUserSurface();
      if (page !== undefined) {
        // Typed event broadcast — replaces the prior `executeJavaScript`
        // template-injection footgun. The renderer's `useActivePage`
        // hook receives `{ page }` and flips its hash through the
        // existing `setActivePage`, which re-validates against the
        // same `SETTINGS_PAGES` allowlist used here.
        const payload: SettingsNavigateEvent = { page };
        existing.webContents.send(EVENT_CHANNELS.settingsNavigate, payload);
      }
      return ok(undefined);
    }
    const extraHash = page !== undefined ? `page=${page}` : undefined;
    createSettingsWindow(extraHash, placementSource);
    // Split mode: the spawned library process is never LS-activated;
    // without this the new Settings window opens behind the user's
    // frontmost app. No-op in combined/agent roles and off-darwin.
    activateForUserSurface();
    return ok(undefined);
  });
}

/** The settings + secrets substrate verbs — agent-owned in split mode
 *  (single writer, always-resident process). */
export function registerSettingsDataHandlers(options: {
  readLocalAgentMcpListenerStatus?: () => LocalAgentMcpListenerStatus;
} = {}): void {
  bus.register("settings:read", async () => {
    // E2E-only fault injection: hold EVERY settings:read dispatched
    // while the env var is set (there is deliberately no first-read
    // latch — keep the knob stateless) so specs can deterministically
    // replay the "renderer mounted, settings not yet resolved" window.
    // A busy machine produces the same window organically (the editor
    // toolbar is interactive before `settings:read` resolves), which
    // is the race behind the editor-border-outline flake — see
    // editor-border-outline.spec.ts "a draw racing settings load
    // still gets the sampled border".
    if (process.env.PWRSNAP_E2E === "1") {
      const delayMs = Number(process.env.PWRSNAP_E2E_SETTINGS_READ_DELAY_MS ?? "0");
      if (Number.isFinite(delayMs) && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    const { service } = ensureServices();
    try {
      const settings = await service.read();
      return ok(settings);
    } catch (cause) {
      return err(toSettingsError("read_failed", "failed to read settings", cause));
    }
  });

  bus.register("settings:write", async (
    patch,
    ctx
  ): Promise<Result<Settings, PwrSnapError>> => {
    const validated = validateSettingsWrite(patch);
    if (!validated.ok) return err(validated.error);
    // This field is persisted through the settings substrate, but it is not a
    // free-form renderer preference. Only the capture fallback and the
    // guarded storage:moveCapturesToDocuments handler may change it. IPC,
    // RPC, and MCP callers must not bypass the home-empty/DB-reference check.
    if (
      validated.value.storage?.capturesLocation !== undefined &&
      ctx.principal !== "bridge"
    ) {
      return err({
        kind: "permission",
        code: "captures_location_main_owned",
        message:
          "Captures location can only be changed by PwrSnap's permission fallback or guarded storage command."
      });
    }
    const { service, secrets } = ensureServices();
    let merged: Settings;
    try {
      merged = await service.write(validated.value);
    } catch (cause) {
      return err(
        toSettingsError(
          "write_failed",
          cause instanceof Error ? cause.message : String(cause),
          cause
        )
      );
    }
    await broadcastSettingsChanged(service, secrets, { settings: merged });
    return ok(merged);
  });

  bus.register("settings:refreshCodexDiscovery", async (req) => {
    const validated = validateRefreshCodexDiscovery(req);
    if (!validated.ok) return err(validated.error);
    const force = validated.value.force === true;
    // Renderer surfaces refresh availability on mount with `force: false`.
    // Every E2E spec launches a fresh app, so allowing those automatic reads
    // to miss an empty cache would spawn the host's real Codex `--version` and
    // auth probes once per app — exactly the child-process churn E2E startup
    // must avoid. Keep `force: true` live so the dedicated discovery spec (and
    // any intentional E2E probe) still exercises the complete host path.
    if (process.env.PWRSNAP_E2E === "1" && !force) {
      const skipped: DesktopCodexDiscoverySnapshot = {
        candidates: [],
        resolvedPath: null,
        auth: null,
        refreshedAt: new Date().toISOString()
      };
      return ok(skipped);
    }
    const { service } = ensureServices();
    try {
      const snapshot = await service.getCodexDiscoverySnapshot({ force });
      return ok(snapshot);
    } catch (cause) {
      return err(
        toSettingsError(
          "discovery_failed",
          cause instanceof Error ? cause.message : String(cause),
          cause
        )
      );
    }
  });

  bus.register("settings:testCodex", async () => {
    const { service } = ensureServices();
    try {
      const result = await service.testCodex();
      return ok(result);
    } catch (cause) {
      return err(
        toSettingsError(
          "test_failed",
          cause instanceof Error ? cause.message : String(cause),
          cause
        )
      );
    }
  });

  bus.register("settings:secretStatus", async () => {
    const { secrets } = ensureServices();
    try {
      const map = await secrets.getAllStatus();
      return ok(map);
    } catch (cause) {
      return err(
        toSettingsError(
          "secret_status_failed",
          cause instanceof Error ? cause.message : String(cause),
          cause
        )
      );
    }
  });

  bus.register("settings:replaceSecret", async (
    req
  ): Promise<Result<SecretStatus, PwrSnapError>> => {
    const validated = validateReplaceSecret(req);
    if (!validated.ok) return err(validated.error);
    const { service, secrets } = ensureServices();
    let status: SecretStatus;
    try {
      status = await secrets.replace(validated.value.name, validated.value.value);
    } catch (cause) {
      if (cause instanceof SecretUnavailableError) {
        return err(toSettingsError("secret_unavailable", cause.message, cause));
      }
      return err(
        toSettingsError(
          "secret_write_failed",
          cause instanceof Error ? cause.message : String(cause),
          cause
        )
      );
    }
    await broadcastSettingsChanged(service, secrets);
    return ok(status);
  });

  bus.register("settings:clearSecret", async (
    req
  ): Promise<Result<SecretStatus, PwrSnapError>> => {
    const validated = validateClearSecret(req);
    if (!validated.ok) return err(validated.error);
    const { service, secrets } = ensureServices();
    let status: SecretStatus;
    try {
      status = await secrets.clear(validated.value.name);
    } catch (cause) {
      return err(
        toSettingsError(
          "secret_clear_failed",
          cause instanceof Error ? cause.message : String(cause),
          cause
        )
      );
    }
    await broadcastSettingsChanged(service, secrets);
    return ok(status);
  });

  bus.register("localAgents:list", async () => {
    const service = getLocalAgentGrantService();
    try {
      const [grants, roles] = await Promise.all([
        service.list(),
        service.listRoles()
      ]);
      return ok({
        grants,
        roles,
        listenerStatus: options.readLocalAgentMcpListenerStatus?.() ?? { state: "off" }
      });
    } catch (cause) {
      return err(toLocalAgentError(cause));
    }
  });

  bus.register("localAgents:roleCreate", async (req) => {
    try {
      return ok(await getLocalAgentGrantService().createRole(req));
    } catch (cause) {
      return err(toLocalAgentError(cause));
    }
  });

  bus.register("localAgents:roleUpdate", async (req) => {
    if (typeof req.id !== "string" || req.id.trim().length === 0) {
      return err({
        kind: "validation",
        code: "invalid_local_agent_role_id",
        message: "localAgents:roleUpdate: id must be a non-empty string"
      });
    }
    try {
      return ok(await getLocalAgentGrantService().updateRole(req.id, req.patch));
    } catch (cause) {
      return err(toLocalAgentError(cause));
    }
  });

  bus.register("localAgents:roleDelete", async (req) => {
    if (typeof req.id !== "string" || req.id.trim().length === 0) {
      return err({
        kind: "validation",
        code: "invalid_local_agent_role_id",
        message: "localAgents:roleDelete: id must be a non-empty string"
      });
    }
    try {
      await getLocalAgentGrantService().deleteRole(req.id);
      return ok(undefined);
    } catch (cause) {
      return err(toLocalAgentError(cause));
    }
  });

  bus.register("localAgents:assignRole", async (req) => {
    if (
      typeof req.sessionId !== "string" ||
      req.sessionId.trim().length === 0 ||
      typeof req.roleId !== "string" ||
      req.roleId.trim().length === 0
    ) {
      return err({
        kind: "validation",
        code: "invalid_local_agent_role_assignment",
        message: "localAgents:assignRole requires Session and role ids"
      });
    }
    try {
      return ok(
        await getLocalAgentGrantService().assignRole(req.sessionId, req.roleId)
      );
    } catch (cause) {
      return err(toLocalAgentError(cause));
    }
  });

  bus.register("localAgents:revoke", async (req) => {
    if (typeof req.id !== "string" || req.id.trim().length === 0) {
      return err({
        kind: "validation",
        code: "invalid_local_agent_id",
        message: "localAgents:revoke: id must be a non-empty string"
      });
    }
    const grantService = getLocalAgentGrantService();
    try {
      const grant = await grantService.revokeGrant(req.id);
      return ok(grant);
    } catch (cause) {
      return err(toLocalAgentError(cause));
    }
  });

  bus.register("localAgents:update", async (req) => {
    if (typeof req.id !== "string" || req.id.trim().length === 0) {
      return err({
        kind: "validation",
        code: "invalid_local_agent_id",
        message: "localAgents:update: id must be a non-empty string"
      });
    }
    const grantService = getLocalAgentGrantService();
    try {
      const grant = await grantService.updateGrant(req.id, req.patch);
      return ok(grant);
    } catch (cause) {
      return err(toLocalAgentError(cause));
    }
  });

  bus.register("localAgents:audit", async (req) => {
    if (
      req.limit !== undefined &&
      (!Number.isInteger(req.limit) || req.limit < 1 || req.limit > 500)
    ) {
      return err({
        kind: "validation",
        code: "invalid_audit_limit",
        message: "localAgents:audit limit must be an integer from 1 to 500"
      });
    }
    try {
      return ok({
        entries: await getLocalAgentAuditService().list(req.limit ?? 100)
      });
    } catch (cause) {
      return err(toLocalAgentError(cause));
    }
  });

  bus.register("localAgents:usage", async (req) => {
    if (typeof req.sessionId !== "string" || req.sessionId.trim().length === 0) {
      return err({
        kind: "validation",
        code: "invalid_local_agent_id",
        message: "localAgents:usage requires a Session id"
      });
    }
    try {
      const settings = await ensureServices().service.read();
      const resolution = resolveLocalAgentPolicy(
        settings.localAgents,
        req.sessionId
      );
      if (!resolution.ok) {
        return err({
          kind: "permission",
          code: resolution.code,
          message: "the Session does not have a valid role"
        });
      }
      return ok({
        entries: getLocalAgentUsageService().snapshots(
          resolution.policy.sessionId,
          resolution.policy.budgets
        )
      });
    } catch (cause) {
      return err(toLocalAgentError(cause));
    }
  });

}

export function __resetSettingsHandlersForTests(): void {
  settingsService = null;
  secretStore = null;
  localAgentGrantService = null;
  localAgentAuditService = null;
  localAgentUsageService = null;
}
