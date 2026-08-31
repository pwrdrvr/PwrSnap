/**
 * Main-process native ownership lease for Settings' DOM hotkey recorder.
 *
 * The first accepted lease releases every shortcut actually owned by the
 * registration manager plus registered transient participants. Lease end,
 * abnormal window cleanup, or timeout rebuilds exact desired native
 * ownership. Every transition runs under DesktopSettingsService's write
 * baton, so prepare/write/retry cannot interleave with suspension.
 */

import type { Settings } from "@pwrsnap/shared";
import type { HotkeyRegistrationCoordinator } from "./hotkey-registration-manager";

export const HOTKEY_RECORDER_LEASE_TIMEOUT_MS = 120_000;

export type HotkeyRecorderLease = {
  sessionId: string;
  generation: number;
  ownerWindowId: number;
  expiresAt: number;
};

export type HotkeyRecorderLeaseAttempt = HotkeyRecorderLease & {
  accepted: boolean;
};

export type HotkeyRecorderSuspensionParticipant = {
  /** Stable diagnostic identity; duplicate participant ids are rejected. */
  id: string;
  /** Set local suspended state first, then release owned native shortcuts. */
  suspend(): void;
  /** Clear local suspended state and restore ownership still logically desired. */
  restore(): void;
};

export type HotkeyRecorderInputScope = {
  /** Bypass application-menu accelerators for the recorder owner only. */
  suspend(ownerWindowId: number, ownerDocumentId: string): void | Promise<void>;
  /** Restore normal application-menu accelerator handling for that window. */
  restore(ownerWindowId: number, ownerDocumentId: string): void | Promise<void>;
};

export type HotkeyRecorderOwnershipCoordinator = {
  withSerializedSettings<T>(
    operation: (current: Settings) => T | Promise<T>
  ): Promise<T>;
  /** Null only when global shortcuts are intentionally disabled (E2E/profile). */
  registrationManager: HotkeyRegistrationCoordinator | null;
};

type HotkeyRecorderLogger = {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
};

type LeaseIntent = {
  sessionId: string;
  generation: number;
  ownerWindowId: number;
  ownerDocumentId: string;
  requestToken: number;
};

type ActiveLease = HotkeyRecorderLease & {
  ownerDocumentId: string;
  token: number;
  requestToken: number;
};

export class HotkeyRecorderSuspension {
  private readonly logger: HotkeyRecorderLogger;
  private readonly timeoutMs: number;
  private coordinator: HotkeyRecorderOwnershipCoordinator | null;
  private inputScope: HotkeyRecorderInputScope | null;
  private inputSuspendedOwner: {
    ownerWindowId: number;
    ownerDocumentId: string;
  } | null = null;
  private active: ActiveLease | null = null;
  private latestIntent: LeaseIntent | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private token = 0;
  private requestToken = 0;
  private nativeSuspended = false;
  private readonly latestGenerationByDocument = new Map<string, number>();
  private readonly closedDocuments = new Set<string>();
  private readonly participants = new Map<string, HotkeyRecorderSuspensionParticipant>();

  constructor(options: {
    logger: HotkeyRecorderLogger;
    timeoutMs?: number;
    coordinator?: HotkeyRecorderOwnershipCoordinator;
    inputScope?: HotkeyRecorderInputScope;
  }) {
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? HOTKEY_RECORDER_LEASE_TIMEOUT_MS;
    this.coordinator = options.coordinator ?? null;
    this.inputScope = options.inputScope ?? null;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("hotkey recorder lease timeout must be positive and finite");
    }
  }

  configureOwnership(coordinator: HotkeyRecorderOwnershipCoordinator): void {
    if (this.active !== null || this.nativeSuspended) {
      throw new Error("cannot replace hotkey recorder ownership while a lease is active");
    }
    this.coordinator = coordinator;
  }

  configureInputScope(inputScope: HotkeyRecorderInputScope): void {
    if (this.active !== null || this.nativeSuspended) {
      throw new Error("cannot replace hotkey recorder input scope while a lease is active");
    }
    this.inputScope = inputScope;
  }

  /** Transient native shortcut owners (for example Float-Over copy chords)
   * participate without coupling their logical state to Settings. Registering
   * during an active lease immediately suspends the participant. */
  registerParticipant(participant: HotkeyRecorderSuspensionParticipant): () => void {
    if (this.participants.has(participant.id)) {
      throw new Error(`duplicate hotkey recorder participant: ${participant.id}`);
    }
    this.participants.set(participant.id, participant);
    if (this.nativeSuspended) {
      try {
        participant.suspend();
      } catch (cause) {
        this.participants.delete(participant.id);
        throw cause;
      }
    }
    return () => {
      if (this.participants.get(participant.id) === participant) {
        this.participants.delete(participant.id);
      }
    };
  }

  /** New sessions supersede old ones. Re-beginning the exact current session
   * refreshes its timeout. A request superseded while waiting for the settings
   * lock resolves rejected and can never arm the renderer early. */
  async begin(
    sessionId: string,
    generation: number,
    ownerWindowId: number,
    ownerDocumentId: string
  ): Promise<HotkeyRecorderLeaseAttempt> {
    const ownerDocumentKey = this.ownerDocumentKey(
      ownerWindowId,
      ownerDocumentId
    );
    if (this.closedDocuments.has(ownerDocumentKey)) {
      return this.rejectedAttempt(sessionId, generation, ownerWindowId);
    }
    const latestGeneration =
      this.latestGenerationByDocument.get(ownerDocumentKey);
    const matchesCurrent =
      (this.active?.ownerWindowId === ownerWindowId &&
        this.active.ownerDocumentId === ownerDocumentId &&
        this.active.sessionId === sessionId &&
        this.active.generation === generation) ||
      (this.latestIntent?.ownerWindowId === ownerWindowId &&
        this.latestIntent.ownerDocumentId === ownerDocumentId &&
        this.latestIntent.sessionId === sessionId &&
        this.latestIntent.generation === generation);
    if (
      latestGeneration !== undefined &&
      (generation < latestGeneration ||
        (generation === latestGeneration && !matchesCurrent))
    ) {
      return this.rejectedAttempt(sessionId, generation, ownerWindowId);
    }

    this.latestGenerationByDocument.set(ownerDocumentKey, generation);
    const intent: LeaseIntent = {
      sessionId,
      generation,
      ownerWindowId,
      ownerDocumentId,
      requestToken: ++this.requestToken
    };
    this.latestIntent = intent;
    const coordinator = this.requireCoordinator();

    return coordinator.withSerializedSettings(async (settings) => {
      if (
        this.closedDocuments.has(ownerDocumentKey) ||
        !this.isCurrentIntent(intent)
      ) {
        return this.rejectedAttempt(sessionId, generation, ownerWindowId);
      }
      coordinator.registrationManager?.initialize(settings.hotkeys);
      if (!this.nativeSuspended) {
        await this.acquireNativeSuspension(
          coordinator,
          ownerWindowId,
          ownerDocumentId
        );
      } else {
        await this.transferInputSuspension(ownerWindowId, ownerDocumentId);
      }
      if (!this.isCurrentIntent(intent)) {
        return this.rejectedAttempt(sessionId, generation, ownerWindowId);
      }

      const superseded = this.active !== null;
      this.clearTimeout();
      const token = ++this.token;
      const lease: ActiveLease = {
        sessionId,
        generation,
        ownerWindowId,
        ownerDocumentId,
        expiresAt: Date.now() + this.timeoutMs,
        token,
        requestToken: intent.requestToken
      };
      this.active = lease;
      this.scheduleTimeout(lease);
      this.logger.info("hotkey recorder native suspension lease began", {
        ownerWindowId,
        superseded
      });
      return { ...this.snapshot()!, accepted: true };
    });
  }

  /** End only the exact session owned by the calling Settings window. */
  async end(
    sessionId: string,
    generation: number,
    ownerWindowId: number,
    ownerDocumentId: string
  ): Promise<boolean> {
    this.cancelMatchingIntent(
      sessionId,
      generation,
      ownerWindowId,
      ownerDocumentId
    );
    const coordinator = this.requireCoordinator();
    return coordinator.withSerializedSettings(async () => {
      const current = this.active;
      if (
        current === null ||
        current.sessionId !== sessionId ||
        current.generation !== generation ||
        current.ownerWindowId !== ownerWindowId ||
        current.ownerDocumentId !== ownerDocumentId
      ) {
        return false;
      }
      await this.releaseLocked("renderer-end", coordinator);
      return true;
    });
  }

  /** Main-owned abnormal-lifecycle cleanup. Stale window ids cannot clear a
   * newer lease owned by another Settings window. */
  async releaseOwner(
    ownerWindowId: number,
    ownerDocumentId: string,
    reason: string
  ): Promise<boolean> {
    const ownerDocumentKey = this.ownerDocumentKey(
      ownerWindowId,
      ownerDocumentId
    );
    // Fence synchronously, before waiting for the settings baton. A begin or
    // heartbeat from the destroyed document may already be queued behind a
    // write; its in-lock recheck must observe this tombstone.
    this.closedDocuments.add(ownerDocumentKey);
    this.latestGenerationByDocument.delete(ownerDocumentKey);
    if (
      this.latestIntent?.ownerWindowId === ownerWindowId &&
      this.latestIntent.ownerDocumentId === ownerDocumentId
    ) {
      this.latestIntent = null;
    }
    const coordinator = this.requireCoordinator();
    return coordinator.withSerializedSettings(async () => {
      if (
        this.active?.ownerWindowId !== ownerWindowId ||
        this.active.ownerDocumentId !== ownerDocumentId
      ) {
        return false;
      }
      await this.releaseLocked(reason, coordinator);
      return true;
    });
  }

  /** Re-admit a still-live Settings document after Electron reports that its
   * renderer recovered from an `unresponsive` interval. The lifecycle release
   * intentionally ended the old lease; recovery only permits a fresh begin. */
  resumeOwner(ownerWindowId: number, ownerDocumentId: string): boolean {
    return this.closedDocuments.delete(
      this.ownerDocumentKey(ownerWindowId, ownerDocumentId)
    );
  }

  isSuspended(): boolean {
    return this.nativeSuspended;
  }

  snapshot(): HotkeyRecorderLease | null {
    if (this.active === null) return null;
    const { sessionId, generation, ownerWindowId, expiresAt } = this.active;
    return { sessionId, generation, ownerWindowId, expiresAt };
  }

  async dispose(): Promise<void> {
    this.latestIntent = null;
    this.clearTimeout();
    const coordinator = this.coordinator;
    if (coordinator !== null && this.nativeSuspended) {
      await coordinator.withSerializedSettings(async () => {
        if (this.nativeSuspended) await this.restoreNativeOwnership(coordinator);
      });
    }
    this.active = null;
    this.nativeSuspended = false;
    this.inputSuspendedOwner = null;
    this.latestGenerationByDocument.clear();
    this.closedDocuments.clear();
  }

  private async acquireNativeSuspension(
    coordinator: HotkeyRecorderOwnershipCoordinator,
    ownerWindowId: number,
    ownerDocumentId: string
  ): Promise<void> {
    const manager = coordinator.registrationManager;
    const suspendedParticipants: HotkeyRecorderSuspensionParticipant[] = [];
    try {
      manager?.suspendNative();
      for (const participant of this.participants.values()) {
        participant.suspend();
        suspendedParticipants.push(participant);
      }
      await this.inputScope?.suspend(ownerWindowId, ownerDocumentId);
      this.inputSuspendedOwner =
        this.inputScope === null ? null : { ownerWindowId, ownerDocumentId };
      this.nativeSuspended = true;
    } catch (cause) {
      if (this.inputScope !== null) {
        try {
          await this.inputScope.restore(ownerWindowId, ownerDocumentId);
        } catch (restoreCause) {
          this.logInputScopeFailure("restore after failed suspension", restoreCause);
        }
      }
      this.inputSuspendedOwner = null;
      for (const participant of suspendedParticipants.reverse()) {
        try {
          participant.restore();
        } catch (restoreCause) {
          this.logParticipantFailure("restore after failed suspension", participant, restoreCause);
        }
      }
      if (manager?.isNativeSuspended()) manager.restoreNative();
      throw cause;
    }
  }

  private async restoreNativeOwnership(
    coordinator: HotkeyRecorderOwnershipCoordinator
  ): Promise<void> {
    const inputOwner = this.inputSuspendedOwner;
    this.inputSuspendedOwner = null;
    if (inputOwner !== null && this.inputScope !== null) {
      try {
        await this.inputScope.restore(
          inputOwner.ownerWindowId,
          inputOwner.ownerDocumentId
        );
      } catch (cause) {
        this.logInputScopeFailure("restore", cause);
      }
    }
    this.nativeSuspended = false;
    coordinator.registrationManager?.restoreNative();
    for (const participant of this.participants.values()) {
      try {
        participant.restore();
      } catch (cause) {
        this.logParticipantFailure("restore", participant, cause);
      }
    }
  }

  private async transferInputSuspension(
    ownerWindowId: number,
    ownerDocumentId: string
  ): Promise<void> {
    const inputScope = this.inputScope;
    if (
      inputScope === null ||
      (this.inputSuspendedOwner?.ownerWindowId === ownerWindowId &&
        this.inputSuspendedOwner.ownerDocumentId === ownerDocumentId)
    ) {
      return;
    }
    const previousOwner = this.inputSuspendedOwner;
    // Arm the newer owner before releasing the old one. If arming throws, the
    // prior accepted recorder remains protected and its lease can still end.
    await inputScope.suspend(ownerWindowId, ownerDocumentId);
    this.inputSuspendedOwner = { ownerWindowId, ownerDocumentId };
    if (previousOwner === null) return;
    // Menu-shortcut bypass is BrowserWindow-wide. A new document in the same
    // Settings window is already covered by the `true` call above; restoring
    // the prior document would immediately disable the new owner's scope.
    if (previousOwner.ownerWindowId === ownerWindowId) return;
    try {
      await inputScope.restore(
        previousOwner.ownerWindowId,
        previousOwner.ownerDocumentId
      );
    } catch (cause) {
      this.logInputScopeFailure("restore superseded owner", cause);
    }
  }

  private async releaseLocked(
    reason: string,
    coordinator: HotkeyRecorderOwnershipCoordinator
  ): Promise<void> {
    const ownerWindowId = this.active?.ownerWindowId;
    this.clearTimeout();
    this.active = null;
    this.latestIntent = null;
    if (this.nativeSuspended) await this.restoreNativeOwnership(coordinator);
    this.logger.info("hotkey recorder native suspension lease ended", {
      ownerWindowId,
      reason
    });
  }

  private scheduleTimeout(lease: ActiveLease): void {
    this.timeout = setTimeout(() => {
      void this.expire(lease).catch((cause) => {
        this.logger.warn("hotkey recorder suspension timeout restore failed", {
          ownerWindowId: lease.ownerWindowId,
          message: cause instanceof Error ? cause.message : String(cause)
        });
      });
    }, this.timeoutMs);
    const timeoutWithUnref = this.timeout as ReturnType<typeof setTimeout> & {
      unref?: () => void;
    };
    timeoutWithUnref.unref?.();
  }

  private async expire(expected: ActiveLease): Promise<void> {
    const coordinator = this.requireCoordinator();
    await coordinator.withSerializedSettings(async () => {
      const current = this.active;
      if (
        current === null ||
        current.token !== expected.token ||
        current.sessionId !== expected.sessionId ||
        current.ownerWindowId !== expected.ownerWindowId
      ) {
        return;
      }
      if (
        this.latestIntent !== null &&
        this.latestIntent.requestToken !== expected.requestToken
      ) {
        return;
      }
      await this.releaseLocked("timeout", coordinator);
      this.logger.warn("hotkey recorder suspension lease expired", {
        ownerWindowId: expected.ownerWindowId,
        timeoutMs: this.timeoutMs
      });
    });
  }

  private rejectedAttempt(
    sessionId: string,
    generation: number,
    ownerWindowId: number
  ): HotkeyRecorderLeaseAttempt {
    return {
      sessionId,
      generation,
      ownerWindowId,
      expiresAt: this.active?.expiresAt ?? Date.now(),
      accepted: false
    };
  }

  private isCurrentIntent(intent: LeaseIntent): boolean {
    return this.latestIntent?.requestToken === intent.requestToken;
  }

  private cancelMatchingIntent(
    sessionId: string,
    generation: number,
    ownerWindowId: number,
    ownerDocumentId: string
  ): void {
    const intent = this.latestIntent;
    if (
      intent?.sessionId === sessionId &&
      intent.generation === generation &&
      intent.ownerWindowId === ownerWindowId &&
      intent.ownerDocumentId === ownerDocumentId
    ) {
      this.latestIntent = null;
    }
  }

  private requireCoordinator(): HotkeyRecorderOwnershipCoordinator {
    if (this.coordinator === null) {
      throw new Error("hotkey recorder native ownership is not configured");
    }
    return this.coordinator;
  }

  private ownerDocumentKey(
    ownerWindowId: number,
    ownerDocumentId: string
  ): string {
    return `${ownerWindowId}@${ownerDocumentId}`;
  }

  private clearTimeout(): void {
    if (this.timeout !== null) clearTimeout(this.timeout);
    this.timeout = null;
  }

  private logParticipantFailure(
    operation: string,
    participant: HotkeyRecorderSuspensionParticipant,
    cause: unknown
  ): void {
    this.logger.warn(`hotkey recorder participant ${operation} failed`, {
      participant: participant.id,
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }

  private logInputScopeFailure(operation: string, cause: unknown): void {
    this.logger.warn(`hotkey recorder input scope ${operation} failed`, {
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }
}
