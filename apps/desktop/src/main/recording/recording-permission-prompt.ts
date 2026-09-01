import { randomUUID } from "node:crypto";
import { app } from "electron";
import type {
  RecordingCapabilities,
  RecordingPermission,
  RecordingPermissionAction,
  RecordingPermissionGap,
  RecordingPermissionPrompt,
  RecordingReadiness,
  RecordingState
} from "@pwrsnap/shared";
import { markScreenCapturePrompted } from "../capture/screen-permission-gate";
import {
  lowerRecordingPermissionController,
  subscribeToRecordingPermissionControllerUnavailable
} from "./recording-controller";
import {
  openSystemSettingsFor,
  readRecordingReadiness,
  requestPermission,
  triggerScreenCapturePrompt
} from "./recording-permissions";
import { setRecordingState } from "./recording-state";

export type RecordingPermissionOutcome =
  | { status: "ready"; capabilities: RecordingCapabilities }
  | { status: "cancelled" }
  | { status: "busy" };

export class RecordingPermissionPromptError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "RecordingPermissionPromptError";
  }
}

type PendingPrompt = {
  prompt: RecordingPermissionPrompt;
  resolve: (outcome: RecordingPermissionOutcome) => void;
  stopWaitingForReturn: (() => void) | null;
};

export type RecordingPermissionPromptDependencies = {
  platform: NodeJS.Platform;
  makeRequestId: () => string;
  readReadiness: () => RecordingReadiness;
  requestScreenAccess: () => Promise<void>;
  requestMicrophoneAccess: () => Promise<void>;
  openSettings: (permission: RecordingPermission) => Promise<void>;
  setState: (state: RecordingState) => void;
  lowerController: () => void;
  onReturnToApp: (handler: () => void) => () => void;
};

/** Owns at most one user decision. It never writes recording preferences;
 * Continue changes only the capability copy held by the pending prompt. */
export class RecordingPermissionPrompter {
  private pending: PendingPrompt | null = null;

  constructor(private readonly deps: RecordingPermissionPromptDependencies) {}

  begin(
    capabilities: RecordingCapabilities,
    displayId: number
  ): Promise<RecordingPermissionOutcome> {
    if (this.pending !== null) {
      return Promise.resolve({ status: "busy" });
    }

    const copiedCapabilities = { ...capabilities };
    const missing = missingPermissions(this.deps.readReadiness(), copiedCapabilities);
    if (missing.length === 0) {
      return Promise.resolve({ status: "ready", capabilities: copiedCapabilities });
    }

    return new Promise((resolve) => {
      const pending: PendingPrompt = {
        prompt: {
          requestId: this.deps.makeRequestId(),
          displayId,
          platform: promptPlatform(this.deps.platform),
          capabilities: copiedCapabilities,
          missing
        },
        resolve,
        stopWaitingForReturn: null
      };
      this.pending = pending;
      this.publish(pending);
    });
  }

  async act(action: RecordingPermissionAction): Promise<void> {
    const pending = this.pending;
    if (pending === null || pending.prompt.requestId !== action.requestId) {
      throw new RecordingPermissionPromptError(
        "stale_permission_prompt",
        "That recording permission prompt is no longer active."
      );
    }

    switch (action.action) {
      case "cancel":
        this.finish(pending, { status: "cancelled" });
        return;
      case "recheck":
        this.refresh(pending);
        return;
      case "continueWithout":
        if (action.permission === "screen") {
          throw new RecordingPermissionPromptError(
            "screen_required",
            "Screen Recording is required and cannot be skipped."
          );
        }
        if (!this.hasGap(pending, action.permission)) {
          throw new RecordingPermissionPromptError(
            "permission_not_missing",
            "That capability is no longer missing."
          );
        }
        pending.prompt.capabilities = {
          ...pending.prompt.capabilities,
          [action.permission]: false
        };
        this.refresh(pending);
        return;
      case "openSettings": {
        const gap = pending.prompt.missing.find(
          (candidate) => candidate.permission === action.permission
        );
        if (gap === undefined) {
          throw new RecordingPermissionPromptError(
            "permission_not_missing",
            "That capability is no longer missing."
          );
        }
        if (gap.status === "restricted" || gap.status === "unavailable") {
          throw new RecordingPermissionPromptError(
            "permission_settings_unsupported",
            "This capability cannot be changed from System Settings."
          );
        }

        // A real screen-capture attempt is what registers PwrSnap in the
        // macOS privacy pane. Probe before opening Settings so the user never
        // lands on a page where PwrSnap is absent.
        if (action.permission === "screen") {
          await this.deps.requestScreenAccess();
          if (this.deps.readReadiness().screenRecording === "granted") {
            this.refresh(pending);
            return;
          }
        }
        // Unlike screen capture, macOS exposes a real first-use microphone
        // request. Fire it before opening Privacy settings so PwrSnap is
        // registered there; proceed immediately when the user grants it.
        if (
          action.permission === "microphone" &&
          pending.prompt.platform === "darwin" &&
          gap.status === "not-determined"
        ) {
          await this.deps.requestMicrophoneAccess();
          if (this.deps.readReadiness().microphone === "granted") {
            this.refresh(pending);
            return;
          }
        }

        this.deps.lowerController();
        pending.stopWaitingForReturn?.();
        pending.stopWaitingForReturn = this.deps.onReturnToApp(() => {
          pending.stopWaitingForReturn = null;
          this.refresh(pending);
        });
        try {
          await this.deps.openSettings(action.permission);
        } catch (cause) {
          pending.stopWaitingForReturn?.();
          pending.stopWaitingForReturn = null;
          this.publish(pending);
          throw cause;
        }
        return;
      }
    }
  }

  cancel(): boolean {
    if (this.pending === null) return false;
    this.finish(this.pending, { status: "cancelled" });
    return true;
  }

  private hasGap(pending: PendingPrompt, permission: RecordingPermission): boolean {
    return pending.prompt.missing.some((gap) => gap.permission === permission);
  }

  private refresh(pending: PendingPrompt): void {
    if (this.pending !== pending) return;
    const missing = missingPermissions(
      this.deps.readReadiness(),
      pending.prompt.capabilities
    );
    if (missing.length === 0) {
      this.finish(pending, {
        status: "ready",
        capabilities: { ...pending.prompt.capabilities }
      });
      return;
    }
    pending.prompt.missing = missing;
    this.publish(pending);
  }

  private publish(pending: PendingPrompt): void {
    if (this.pending !== pending) return;
    this.deps.setState({
      phase: "permission",
      prompt: {
        ...pending.prompt,
        capabilities: { ...pending.prompt.capabilities },
        missing: pending.prompt.missing.map((gap) => ({ ...gap }))
      }
    });
  }

  private finish(pending: PendingPrompt, outcome: RecordingPermissionOutcome): void {
    if (this.pending !== pending) return;
    pending.stopWaitingForReturn?.();
    this.pending = null;
    this.deps.setState({ phase: "idle" });
    pending.resolve(outcome);
  }
}

function missingPermissions(
  readiness: RecordingReadiness,
  capabilities: RecordingCapabilities
): RecordingPermissionGap[] {
  const missing: RecordingPermissionGap[] = [];
  if (readiness.screenRecording !== "granted") {
    missing.push({ permission: "screen", status: readiness.screenRecording });
  }
  if (capabilities.microphone && readiness.microphone !== "granted") {
    missing.push({ permission: "microphone", status: readiness.microphone });
  }
  if (capabilities.systemAudio && readiness.systemAudio !== "granted") {
    missing.push({ permission: "systemAudio", status: readiness.systemAudio });
  }
  return missing;
}

function promptPlatform(platform: NodeJS.Platform): RecordingPermissionPrompt["platform"] {
  if (platform === "darwin" || platform === "win32") return platform;
  return "other";
}

const recordingPermissionPrompter = new RecordingPermissionPrompter({
  platform: process.platform,
  makeRequestId: randomUUID,
  readReadiness: readRecordingReadiness,
  requestScreenAccess: async () => {
    await triggerScreenCapturePrompt();
    await markScreenCapturePrompted();
  },
  requestMicrophoneAccess: async () => {
    await requestPermission("microphone");
  },
  openSettings: openSystemSettingsFor,
  setState: setRecordingState,
  lowerController: lowerRecordingPermissionController,
  onReturnToApp: (handler) => {
    const listener = (): void => {
      app.removeListener("browser-window-focus", listener);
      handler();
    };
    app.on("browser-window-focus", listener);
    return () => app.removeListener("browser-window-focus", listener);
  }
});

subscribeToRecordingPermissionControllerUnavailable(() => {
  recordingPermissionPrompter.cancel();
});

export function requestRecordingPermissions(
  capabilities: RecordingCapabilities,
  displayId: number
): Promise<RecordingPermissionOutcome> {
  return recordingPermissionPrompter.begin(capabilities, displayId);
}

export function actOnRecordingPermissionPrompt(
  action: RecordingPermissionAction
): Promise<void> {
  return recordingPermissionPrompter.act(action);
}

export function cancelRecordingPermissionPrompt(): boolean {
  return recordingPermissionPrompter.cancel();
}
