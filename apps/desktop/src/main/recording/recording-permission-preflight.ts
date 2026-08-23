// Interactive permission broker for Fast Video Capture.
//
// Permission checks happen before RecordingService.start(), so rejecting or
// cancelling this broker cannot create a native helper, output file, or temp
// directory. The broker owns only a transient copy of the requested audio
// capabilities: "continue without" changes this take, never Settings.

import { randomUUID } from "node:crypto";
import {
  err,
  ok,
  type PwrSnapError,
  type RecordingCapabilities,
  type RecordingPermission,
  type RecordingPermissionAction,
  type RecordingPermissionGap,
  type RecordingPermissionPreflight,
  type RecordingPermissionPreflightOutcome,
  type RecordingReadiness,
  type RecordingState,
  type Result
} from "@pwrsnap/shared";
import {
  markScreenCapturePrompted
} from "../capture/screen-permission-gate";
import {
  openSystemSettingsFor,
  readRecordingReadiness,
  requestPermission
} from "./recording-permissions";
import { setRecordingState } from "./recording-state";

type PreflightDependencies = {
  platform: NodeJS.Platform;
  makeRequestId: () => string;
  defaultDisplayId: () => number;
  readReport: () => Promise<RecordingReadiness>;
  request: (
    permission: RecordingPermission
  ) => Promise<{ status: RecordingReadiness["screenRecording"] }>;
  openSettings: (permission: RecordingPermission) => Promise<void>;
  markScreenPrompted: () => Promise<void>;
  setState: (state: RecordingState) => void;
};

type PendingPreflight = {
  requestId: string;
  displayId: number;
  capabilities: RecordingCapabilities;
  report: RecordingReadiness;
  awaitingSettings: boolean;
  resolve: (outcome: RecordingPermissionPreflightOutcome) => void;
};

export class RecordingPermissionPreflightCoordinator {
  private readonly deps: PreflightDependencies;
  private inFlight = false;
  private cancelRequested = false;
  private pending: PendingPreflight | null = null;

  constructor(deps: Partial<PreflightDependencies> = {}) {
    this.deps = {
      platform: deps.platform ?? process.platform,
      makeRequestId: deps.makeRequestId ?? randomUUID,
      // An unknown id intentionally falls back to the primary display in
      // recording-controller.ts. Post-selector callers pass the exact id.
      defaultDisplayId: deps.defaultDisplayId ?? (() => -1),
      readReport:
        deps.readReport ??
        (async () => readRecordingReadiness()),
      request: deps.request ?? requestPermission,
      openSettings: deps.openSettings ?? openSystemSettingsFor,
      markScreenPrompted: deps.markScreenPrompted ?? markScreenCapturePrompted,
      setState: deps.setState ?? setRecordingState
    };
  }

  /** A reservation exists before the visible permission phase is published.
   * Callers must use this rather than inspecting RecordingState so an async
   * readiness read cannot race a native recording start. */
  get isInFlight(): boolean {
    return this.inFlight;
  }

  /** Begin one interactive gate. A second attempt is rejected while the
   * first dialog is waiting, matching RecordingService's one-session rule. */
  async begin(input: {
    capabilities: RecordingCapabilities;
    displayId?: number | undefined;
  }): Promise<RecordingPermissionPreflightOutcome> {
    if (this.inFlight) throw new Error("permission_preflight_in_progress");
    this.inFlight = true;
    this.cancelRequested = false;

    const capabilities = { ...input.capabilities };
    try {
      const report = await this.deps.readReport();

      if (this.cancelRequested) {
        this.inFlight = false;
        return { status: "cancelled" };
      }

      const gaps = missingPermissions(capabilities, report);
      if (gaps.length === 0) {
        this.inFlight = false;
        return { status: "ready", capabilities };
      }

      const requestId = this.deps.makeRequestId();
      const displayId = input.displayId ?? this.deps.defaultDisplayId();
      return await new Promise<RecordingPermissionPreflightOutcome>((resolve) => {
        const pending: PendingPreflight = {
          requestId,
          displayId,
          capabilities,
          report,
          awaitingSettings: false,
          resolve
        };
        this.pending = pending;
        this.publish(pending);
      });
    } catch (cause) {
      this.pending = null;
      this.inFlight = false;
      throw cause;
    }
  }

  /** Resolve an action from the exact sandboxed recording-controller
   * window. The command handler enforces the trusted-window boundary. */
  async act(action: RecordingPermissionAction): Promise<Result<void, PwrSnapError>> {
    const pending = this.pending;
    if (pending === null || pending.requestId !== action.requestId) {
      return preflightError(
        "stale_permission_preflight",
        "This recording permission request is no longer active."
      );
    }

    if (action.action === "cancel") {
      this.finish(pending, { status: "cancelled" });
      return ok(undefined);
    }

    if (action.action === "recheck") {
      pending.awaitingSettings = false;
      return this.refresh();
    }

    if (!("permission" in action)) {
      return preflightError(
        "invalid_permission_action",
        "This recording permission action is invalid."
      );
    }
    const permission = action.permission;

    const gap = missingPermissions(pending.capabilities, pending.report).find(
      (candidate) => candidate.permission === permission
    );
    if (gap === undefined) {
      return preflightError(
        "permission_not_missing",
        "That capability is no longer missing from this recording."
      );
    }

    if (action.action === "continueWithout") {
      if (permission === "screen") {
        return preflightError(
          "screen_capture_required",
          "Screen capture is required to record video."
        );
      }
      pending.capabilities = {
        ...pending.capabilities,
        [permission]: false
      };
      pending.awaitingSettings = false;
      return this.refresh(false);
    }

    if (
      this.deps.platform !== "darwin" ||
      gap.status === "unavailable" ||
      gap.status === "restricted"
    ) {
      return preflightError(
        "permission_settings_unavailable",
        "This capability does not have an OS Settings action on this platform."
      );
    }

    try {
      // Microphone has a direct TCC prompt. Screen and system audio share
      // the screen-capture grant and must always probe first so a reset or
      // new dev identity gets listed before Settings opens.
      const firstMicrophoneAsk =
        permission === "microphone" && gap.status === "not-determined";
      await this.deps.request(permission);
      if (this.pending !== pending) return ok(undefined);
      if (permission === "screen" || permission === "systemAudio") {
        await this.deps.markScreenPrompted();
        if (this.pending !== pending) return ok(undefined);
      }
      const refreshed = await this.deps.readReport();
      if (this.pending !== pending) return ok(undefined);
      pending.report = refreshed;
      const stillMissing = missingPermissions(
        pending.capabilities,
        refreshed
      ).some((candidate) => candidate.permission === permission);

      // On a first microphone ask, the native TCC dialog is already the
      // user's context; do not immediately stack System Settings over it.
      // A subsequent click sees `denied` and opens Settings.
      if (!stillMissing || firstMicrophoneAsk) {
        pending.awaitingSettings = false;
        return this.refresh(false);
      }

      // Lower and blur the controller BEFORE opening Settings. Do not
      // refresh/publish again just because openExternal resolved: on macOS
      // that promise completes while System Settings is still frontmost.
      // A genuine window-focus return or explicit Check again dispatches
      // `recheck`, clears this flag, and raises the panel then.
      pending.awaitingSettings = true;
      this.publish(pending);
      await this.deps.openSettings(permission);
      return ok(undefined);
    } catch (cause) {
      if (this.pending === pending) {
        pending.awaitingSettings = false;
        this.publish(pending);
      }
      return err({
        kind: "permission",
        code: "permission_action_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
    }
  }

  /** Cancel before RecordingService.start(). Returns true when this call
   * owned an initializing or visible preflight. */
  cancel(): boolean {
    if (!this.inFlight) return false;
    this.cancelRequested = true;
    if (this.pending !== null) {
      this.finish(this.pending, { status: "cancelled" });
    }
    return true;
  }

  private async refresh(readAgain = true): Promise<Result<void, PwrSnapError>> {
    const pending = this.pending;
    if (pending === null) {
      return preflightError(
        "stale_permission_preflight",
        "This recording permission request is no longer active."
      );
    }
    try {
      if (readAgain) {
        const report = await this.deps.readReport();
        // Cancel can resolve this request while the OS/readiness check is
        // pending, and a new begin() may already have installed another
        // request. Never let the old completion publish or finish that newer
        // request (ABA lifecycle race).
        if (this.pending !== pending) return ok(undefined);
        pending.report = report;
      }
      const gaps = missingPermissions(pending.capabilities, pending.report);
      if (gaps.length === 0) {
        this.finish(pending, {
          status: "ready",
          capabilities: { ...pending.capabilities }
        });
      } else {
        this.publish(pending);
      }
      return ok(undefined);
    } catch (cause) {
      return err({
        kind: "permission",
        code: "permission_recheck_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
    }
  }

  private publish(pending: PendingPreflight): void {
    if (this.pending !== pending) return;
    const preflight: RecordingPermissionPreflight = {
      requestId: pending.requestId,
      displayId: pending.displayId,
      capabilities: { ...pending.capabilities },
      missing: missingPermissions(pending.capabilities, pending.report),
      ...(pending.awaitingSettings ? { awaitingSettings: true } : {})
    };
    this.deps.setState({ phase: "permission", preflight });
  }

  private finish(
    pending: PendingPreflight,
    outcome: RecordingPermissionPreflightOutcome
  ): void {
    if (this.pending !== pending) return;
    this.pending = null;
    this.inFlight = false;
    this.cancelRequested = false;
    this.deps.setState({ phase: "idle" });
    pending.resolve(outcome);
  }
}

function missingPermissions(
  capabilities: RecordingCapabilities,
  report: RecordingReadiness
): RecordingPermissionGap[] {
  const requested: Array<{
    permission: RecordingPermission;
    status: RecordingReadiness["screenRecording"];
  }> = [
    { permission: "screen", status: report.screenRecording },
    ...(capabilities.microphone
      ? [{ permission: "microphone" as const, status: report.microphone }]
      : []),
    ...(capabilities.systemAudio
      ? [{ permission: "systemAudio" as const, status: report.systemAudio }]
      : [])
  ];
  return requested.filter(({ status }) => status !== "granted");
}

function preflightError(
  code: string,
  message: string
): Result<never, PwrSnapError> {
  return err({ kind: "validation", code, message });
}

let coordinatorOverrideForTests: RecordingPermissionPreflightCoordinator | null = null;
let productionCoordinator: RecordingPermissionPreflightCoordinator | null = null;
let permissionControllerWindowId: number | null = null;

export function getRecordingPermissionPreflightCoordinator(): RecordingPermissionPreflightCoordinator {
  if (coordinatorOverrideForTests !== null) return coordinatorOverrideForTests;
  productionCoordinator ??= new RecordingPermissionPreflightCoordinator();
  return productionCoordinator;
}

export function cancelRecordingPermissionPreflight(): boolean {
  return (
    coordinatorOverrideForTests?.cancel() ??
    productionCoordinator?.cancel() ??
    false
  );
}

export function __setRecordingPermissionPreflightCoordinatorForTests(
  coordinator: RecordingPermissionPreflightCoordinator | null
): void {
  coordinatorOverrideForTests = coordinator;
}

export function setRecordingPermissionControllerWindowId(
  windowId: number | null
): void {
  permissionControllerWindowId = windowId;
}

export function getRecordingPermissionControllerWindowId(): number | null {
  return permissionControllerWindowId;
}
