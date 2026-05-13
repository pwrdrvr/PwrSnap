// Lazy module-level singletons because `app.getPath("userData")` is
// unavailable at module load (tests mock `electron` without an app
// instance, production hasn't fired `app.whenReady()` yet). Every
// write broadcasts `events:settings:changed` to every BrowserWindow.

import { BrowserWindow, app } from "electron";
import { join } from "node:path";
import { ok, err, EVENT_CHANNELS } from "@pwrsnap/shared";
import type {
  PwrSnapError,
  Result,
  SecretStatus,
  Settings,
  SettingsChangedEvent,
  SettingsNavigateEvent
} from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { createSettingsWindow, findSettingsWindow } from "../window";
import { getMainLogger } from "../log";
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

function ensureServices(): {
  service: DesktopSettingsService;
  secrets: DesktopSecretStore;
} {
  if (settingsService === null) {
    const userData = app.getPath("userData");
    settingsService = new DesktopSettingsService({
      filePath: join(userData, "pwrsnap-settings.json")
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

export function __setSettingsServicesForTests(injected: {
  service?: DesktopSettingsService | null;
  secrets?: DesktopSecretStore | null;
}): void {
  if (injected.service !== undefined) settingsService = injected.service;
  if (injected.secrets !== undefined) secretStore = injected.secrets;
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
}

function toSettingsError(
  code: string,
  message: string,
  cause?: unknown
): PwrSnapError {
  return { kind: "settings", code, message, cause };
}

export function registerSettingsHandlers(): void {
  bus.register("settings:open", async (req) => {
    const validated = validateSettingsOpen(req);
    if (!validated.ok) return err(validated.error);
    const { page } = validated.value;
    const existing = findSettingsWindow();
    if (existing !== null) {
      if (existing.isMinimized()) existing.restore();
      if (!existing.isVisible()) existing.show();
      existing.focus();
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
    createSettingsWindow(extraHash);
    return ok(undefined);
  });

  bus.register("settings:read", async () => {
    const { service } = ensureServices();
    try {
      const settings = await service.read();
      return ok(settings);
    } catch (cause) {
      return err(toSettingsError("read_failed", "failed to read settings", cause));
    }
  });

  bus.register("settings:write", async (
    patch
  ): Promise<Result<Settings, PwrSnapError>> => {
    const validated = validateSettingsWrite(patch);
    if (!validated.ok) return err(validated.error);
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
    const { service } = ensureServices();
    try {
      const force = validated.value.force === true;
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

}

export function __resetSettingsHandlersForTests(): void {
  settingsService = null;
  secretStore = null;
}
