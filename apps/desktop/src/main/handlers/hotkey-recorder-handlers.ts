/** Command-bus boundary for the Settings hotkey-recorder suspension lease. */

import { err, ok, type PwrSnapError, type Result } from "@pwrsnap/shared";
import { bus, type CommandContext } from "../command-bus";
import {
  HotkeyRecorderSuspension,
  type HotkeyRecorderOwnershipCoordinator
} from "../hotkeys/hotkey-recorder-suspension";
import { isHotkeyRecorderDocumentId } from "../hotkeys/hotkey-recorder-document";
import { createHotkeyRecorderInputScope } from "../hotkeys/hotkey-recorder-input-scope";
import {
  isLiveSettingsHotkeyRecorderOwner,
  type HotkeyRecorderSettingsWindow
} from "../hotkeys/hotkey-recorder-owner";

const SESSION_ID = /^[A-Za-z0-9_-]{8,128}$/;
const OWNER_RELEASE_REASONS = new Set([
  "window-closed",
  "renderer-gone",
  "navigation",
  "unresponsive"
]);

function failure(
  kind: PwrSnapError["kind"],
  code: string,
  message: string
): Result<never, PwrSnapError> {
  return err({ kind, code, message });
}

function rendererOwner(
  ctx: CommandContext,
  isLiveSettingsOwner: (windowId: number, documentId: string) => boolean
): Result<{ windowId: number; documentId: string }, PwrSnapError> {
  if (
    ctx.principal !== "ipc" ||
    ctx.sourceWindowId === undefined ||
    !isHotkeyRecorderDocumentId(ctx.sourceDocumentId)
  ) {
    return failure(
      "permission",
      "hotkey_recorder_renderer_only",
      "The hotkey recorder lease must come from a PwrSnap Settings window."
    );
  }
  if (
    ctx.sourceSettingsHotkeyRecorderOwner !== true &&
    !isLiveSettingsOwner(ctx.sourceWindowId, ctx.sourceDocumentId)
  ) {
    return failure(
      "permission",
      "hotkey_recorder_settings_window_only",
      "The hotkey recorder lease must come from the live PwrSnap Settings document."
    );
  }
  return ok({
    windowId: ctx.sourceWindowId,
    documentId: ctx.sourceDocumentId
  });
}

export function registerHotkeyRecorderSuspensionHandlers(
  suspension: HotkeyRecorderSuspension,
  ownership: HotkeyRecorderOwnershipCoordinator,
  isLiveSettingsOwner: (windowId: number, documentId: string) => boolean
): void {
  // This must be the same DesktopSettingsService instance used by
  // settings:write/status/retry. It makes native suspension one participant
  // in that service's non-reentrant mutation baton rather than a parallel
  // state machine that can race a prepared settings write.
  suspension.configureOwnership(ownership);
  bus.register("settings:beginHotkeyRecording", async (req, ctx) => {
    const sessionId = (req as { sessionId?: unknown }).sessionId;
    const generation = (req as { generation?: unknown }).generation;
    if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
      return failure(
        "validation",
        "invalid_hotkey_recorder_session",
        "Hotkey recorder sessionId must be 8–128 letters, numbers, underscores, or hyphens."
      );
    }
    if (
      typeof generation !== "number" ||
      !Number.isSafeInteger(generation) ||
      generation < 1
    ) {
      return failure(
        "validation",
        "invalid_hotkey_recorder_generation",
        "Hotkey recorder generation must be a positive safe integer."
      );
    }
    const owner = rendererOwner(ctx, isLiveSettingsOwner);
    if (!owner.ok) return owner;
    return ok(
      await suspension.begin(
        sessionId,
        generation,
        owner.value.windowId,
        owner.value.documentId
      )
    );
  });

  bus.register("settings:endHotkeyRecording", async (req, ctx) => {
    const value = req as Record<string, unknown>;
    if (typeof value.sessionId === "string") {
      if (!SESSION_ID.test(value.sessionId)) {
        return failure(
          "validation",
          "invalid_hotkey_recorder_session",
          "Hotkey recorder sessionId is invalid."
        );
      }
      if (
        typeof value.generation !== "number" ||
        !Number.isSafeInteger(value.generation) ||
        value.generation < 1
      ) {
        return failure(
          "validation",
          "invalid_hotkey_recorder_generation",
          "Hotkey recorder generation must be a positive safe integer."
        );
      }
      const owner = rendererOwner(ctx, isLiveSettingsOwner);
      if (!owner.ok) return owner;
      return ok({
        ended: await suspension.end(
          value.sessionId,
          value.generation,
          owner.value.windowId,
          owner.value.documentId
        )
      });
    }

    if (
      Number.isInteger(value.ownerWindowId) &&
      isHotkeyRecorderDocumentId(value.ownerDocumentId) &&
      typeof value.reason === "string" &&
      OWNER_RELEASE_REASONS.has(value.reason)
    ) {
      if (ctx.principal !== "bridge") {
        return failure(
          "permission",
          "hotkey_recorder_owner_cleanup_main_only",
          "Only the Settings window lifecycle may release a recorder owner."
        );
      }
      return ok({
        ended: await suspension.releaseOwner(
          value.ownerWindowId as number,
          value.ownerDocumentId,
          value.reason
        )
      });
    }

    return failure(
      "validation",
      "invalid_hotkey_recorder_end",
      "Hotkey recorder cleanup requires a sessionId or a main-owned window lifecycle reason."
    );
  });

  bus.register("settings:resumeHotkeyRecordingOwner", async (req, ctx) => {
    const value = req as Record<string, unknown>;
    if (
      ctx.principal !== "bridge" ||
      !Number.isSafeInteger(value.ownerWindowId) ||
      !isHotkeyRecorderDocumentId(value.ownerDocumentId)
    ) {
      return failure(
        "permission",
        "hotkey_recorder_owner_resume_main_only",
        "Only the live Settings window lifecycle may resume a recorder owner."
      );
    }
    return ok({
      resumed: suspension.resumeOwner(
        value.ownerWindowId as number,
        value.ownerDocumentId
      )
    });
  });
}

/** Library/combined-process handler for the BrowserWindow-owned half of the
 * recorder lease. Only authenticated main-process bridge traffic can call it;
 * enabling additionally proves the exact live Settings document epoch. */
export function registerHotkeyRecorderInputScopeHandler(
  findSettingsWindow: () =>
    | (HotkeyRecorderSettingsWindow & {
        webContents: {
          setIgnoreMenuShortcuts(ignore: boolean): void;
        };
      })
    | null
): void {
  const scope = createHotkeyRecorderInputScope((windowId) => {
    const window = findSettingsWindow();
    return window?.id === windowId ? window : null;
  });

  bus.register("settings:setHotkeyRecorderInputScope", async (req, ctx) => {
    const value = req as Record<string, unknown>;
    if (
      ctx.principal !== "bridge" ||
      !Number.isSafeInteger(value.ownerWindowId) ||
      !isHotkeyRecorderDocumentId(value.ownerDocumentId) ||
      typeof value.ignore !== "boolean"
    ) {
      return failure(
        "permission",
        "hotkey_recorder_input_scope_main_only",
        "Only the hotkey recorder ownership lease may change Settings menu input."
      );
    }
    const ownerWindowId = value.ownerWindowId as number;
    const ownerDocumentId = value.ownerDocumentId;
    const window = findSettingsWindow();
    if (value.ignore) {
      if (
        !isLiveSettingsHotkeyRecorderOwner(
          window,
          ownerWindowId,
          ownerDocumentId
        )
      ) {
        return ok({ applied: false });
      }
      await scope.suspend(ownerWindowId, ownerDocumentId);
      return ok({ applied: true });
    }

    if (window === null || window.id !== ownerWindowId || window.isDestroyed()) {
      return ok({ applied: false });
    }
    await scope.restore(ownerWindowId, ownerDocumentId);
    return ok({ applied: true });
  });
}
