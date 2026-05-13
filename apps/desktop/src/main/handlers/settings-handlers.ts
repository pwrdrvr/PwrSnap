// Command-bus handlers for the `settings:*` namespace.
//
// Slice B landed `settings:open` only. Slice C extends this module
// with the full read/write/discovery/secret surface, all routed
// through the same handler-registration shape.
//
// The service + secret store are lazy module-level singletons keyed
// off `app.getPath("userData")`. They're constructed on first
// `registerSettingsHandlers()` rather than at module load so unit
// tests that mock `electron` (no app instance) don't crash, and so
// the production build doesn't touch the file system before
// `app.whenReady()`. The lazy-singleton pattern mirrors the rest of
// the handlers/* dir.
//
// Every write — `settings:write`, `settings:replaceSecret`,
// `settings:clearSecret` — broadcasts `events:settings:changed` to
// every BrowserWindow. The renderer's `useSettings` hook subscribes
// to that channel and replaces its local snapshot on receipt.

import { BrowserWindow, app } from "electron";
import { join } from "node:path";
import { ok, err, EVENT_CHANNELS } from "@pwrsnap/shared";
import type {
  DesktopSettingsSecretName,
  PwrSnapError,
  Result,
  SecretStatus,
  Settings,
  SettingsChangedEvent
} from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { createSettingsWindow, findSettingsWindow } from "../window";
import { getMainLogger } from "../log";
import { DesktopSettingsService } from "../settings/desktop-settings-service";
import {
  DesktopSecretStore,
  SecretUnavailableError
} from "../settings/desktop-secret-store";

const log = getMainLogger("pwrsnap:settings-handlers");

// Lazy module-level singletons. Constructed on first call to
// `registerSettingsHandlers()` (or via test injection — see
// `__setSettingsServiceForTests`). `app` isn't ready at module load,
// so we can't compute these statically.
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

/**
 * Test-only injection seam. Lets the integration test point the
 * handlers at a tmpdir-backed service without subprocessing Electron.
 * Production code MUST NOT call this; the lazy-init path is correct
 * for the real app.
 */
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
    const existing = findSettingsWindow();
    if (existing !== null) {
      if (existing.isMinimized()) existing.restore();
      if (!existing.isVisible()) existing.show();
      existing.focus();
      if (req.page !== undefined) {
        existing.webContents
          .executeJavaScript(
            `window.location.hash = "stage=settings&page=${req.page}";`,
            true
          )
          .catch((cause: unknown) => {
            log.warn("settings:open: failed to set hash on existing window", {
              page: req.page,
              message: cause instanceof Error ? cause.message : String(cause)
            });
          });
      }
      return ok(undefined);
    }
    const extraHash = req.page !== undefined ? `page=${req.page}` : undefined;
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
    const { service, secrets } = ensureServices();
    let merged: Settings;
    try {
      merged = await service.write(patch);
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
    const { service } = ensureServices();
    try {
      const force = req.force === true;
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
    const { service, secrets } = ensureServices();
    let status: SecretStatus;
    try {
      status = await secrets.replace(req.name, req.value);
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
    const { service, secrets } = ensureServices();
    let status: SecretStatus;
    try {
      status = await secrets.clear(req.name);
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

  // Bind the lookup so test resets that null out the singleton don't
  // affect any code that's already captured a service reference. (No-op
  // today — kept as a marker for the lazy-init pattern.)
  void ((): void => {
    // intentionally empty
  })();
}

/**
 * Used by tests to wipe the lazy singletons + the bus registration so
 * a re-import inside `vi.resetModules()` is clean.
 */
export function __resetSettingsHandlersForTests(): void {
  settingsService = null;
  secretStore = null;
}
