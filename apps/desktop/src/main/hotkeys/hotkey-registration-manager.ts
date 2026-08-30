import {
  DEFAULT_HOTKEYS,
  acceleratorToDisplayText,
  acceleratorsAreEquivalent,
  canonicalAcceleratorForPlatform,
  type HotkeyRegistrationFailure,
  type HotkeyRegistrationStatusSnapshot,
  type Settings,
  type ShortcutPlatform
} from "@pwrsnap/shared";

export type HotkeyKind = keyof Settings["hotkeys"];

/** Runtime enumeration follows the settings schema's source of truth. A new
 * persisted hotkey therefore cannot be omitted from boot registration or
 * status merely because a second hand-maintained list was not updated. */
export const HOTKEY_KINDS = Object.keys(DEFAULT_HOTKEYS) as HotkeyKind[];

const HOTKEY_KIND_SET = new Set<string>(HOTKEY_KINDS);

export function isHotkeyKind(value: unknown): value is HotkeyKind {
  return typeof value === "string" && HOTKEY_KIND_SET.has(value);
}

export type GlobalShortcutRegistrar = {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
};

type HotkeyLogger = {
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
};

export type HotkeyRegistrationTransaction = {
  /** Finalize the already-staged bindings after settings hit disk. */
  commit(): void;
  /** Release staged bindings when persistence fails. */
  rollback(): void;
};

export type HotkeyRegistrationCoordinator = {
  initialize(hotkeys: Settings["hotkeys"]): ReadonlyMap<HotkeyKind, string>;
  prepare(
    currentHotkeys: Settings["hotkeys"],
    nextHotkeys: Settings["hotkeys"]
  ): HotkeyRegistrationTransaction;
  statusSnapshot(): HotkeyRegistrationStatusSnapshot;
  retry(kind: HotkeyKind): HotkeyRegistrationStatusSnapshot;
  suspendNative(): HotkeyRegistrationStatusSnapshot;
  restoreNative(): HotkeyRegistrationStatusSnapshot;
  isNativeSuspended(): boolean;
};

export type HotkeyRegistrationErrorCode =
  | "hotkey_duplicate"
  | "hotkey_unsupported"
  | "hotkey_unavailable";

/** A main-process registration failure that is safe to return through Result. */
export class HotkeyRegistrationError extends Error {
  readonly code: HotkeyRegistrationErrorCode;
  readonly hotkeyKind: HotkeyKind;
  readonly accelerator: string;

  constructor(options: {
    code: HotkeyRegistrationErrorCode;
    hotkeyKind: HotkeyKind;
    accelerator: string;
    message: string;
    cause?: unknown;
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HotkeyRegistrationError";
    this.code = options.code;
    this.hotkeyKind = options.hotkeyKind;
    this.accelerator = options.accelerator;
  }
}

export type HotkeyRegistrationManagerOptions = {
  platform: ShortcutPlatform;
  registrar: GlobalShortcutRegistrar;
  callbackFor(kind: HotkeyKind): () => void;
  logger: HotkeyLogger;
};

export function shortcutPlatformLabel(platform: ShortcutPlatform): string {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
  }
}

const HOTKEY_LABELS = {
  quickCapture: "Quick Capture",
  region: "Region Capture",
  window: "Window Capture",
  fullScreen: "Full Screen Capture",
  allScreens: "All Screens Capture",
  timed: "Timed Capture",
  videoCapture: "Video Capture",
  reshowFloatOver: "Show Last Capture"
} satisfies Record<keyof Settings["hotkeys"], string>;

/**
 * Owns only the global shortcuts that PwrSnap successfully registered.
 *
 * A settings edit is a two-phase operation: `prepare` registers every new
 * accelerator while the prior binding is still live, persistence happens in
 * DesktopSettingsService's serialized write queue, then `commit` releases the
 * replaced bindings. A failed register or disk write rolls back only the
 * staged registrations, so a working shortcut is never silently discarded.
 */
export class HotkeyRegistrationManager implements HotkeyRegistrationCoordinator {
  private readonly platform: ShortcutPlatform;
  private readonly registrar: GlobalShortcutRegistrar;
  private readonly logger: HotkeyLogger;
  private readonly callbacks = new Map<HotkeyKind, () => void>();
  private active = new Map<HotkeyKind, string>();
  private configured = new Map<HotkeyKind, string>();
  private failures = new Map<HotkeyKind, HotkeyRegistrationFailure>();
  private initialized = false;
  private suspended = false;
  private restoreAfterSuspension = new Set<HotkeyKind>();

  constructor(options: HotkeyRegistrationManagerOptions) {
    this.platform = options.platform;
    this.registrar = options.registrar;
    this.logger = options.logger;
    for (const kind of HOTKEY_KINDS) {
      this.callbacks.set(kind, options.callbackFor(kind));
    }
  }

  /**
   * Best-effort boot registration. There is no prior live state to preserve,
   * so one OS-reserved persisted chord must not prevent unrelated chords from
   * coming online. Settings writes use the all-or-nothing `prepare` path.
   */
  initialize(hotkeys: Settings["hotkeys"]): ReadonlyMap<HotkeyKind, string> {
    if (this.initialized) return this.snapshot();
    this.initialized = true;
    const claimed = new Map<string, HotkeyKind>();

    for (const kind of HOTKEY_KINDS) {
      const persisted = hotkeys[kind] ?? "";
      this.configured.set(kind, persisted);
      let accelerator: string;
      try {
        accelerator = this.normalize(kind, persisted);
      } catch (cause) {
        this.failures.set(kind, this.unsupportedStatus(kind, persisted));
        this.logBootFailure(kind, persisted, cause);
        continue;
      }
      if (accelerator === "") continue;

      const existing = claimed.get(accelerator);
      if (existing !== undefined) {
        this.logger.warn("hotkey registration skipped duplicate persisted binding", {
          kind,
          accelerator,
          conflictsWith: existing
        });
        this.failures.set(kind, this.duplicateStatus(kind, existing));
        continue;
      }
      claimed.set(accelerator, kind);

      try {
        if (!this.registrar.register(accelerator, this.callback(kind))) {
          this.logger.warn("failed to register persisted hotkey (likely reserved or in use)", {
            kind,
            accelerator,
            platform: this.platform
          });
          this.failures.set(kind, this.unavailableStatus(kind, accelerator));
          continue;
        }
        this.active.set(kind, accelerator);
      } catch (cause) {
        this.failures.set(kind, this.registrationErrorStatus(kind, accelerator));
        this.logBootFailure(kind, accelerator, cause);
      }
    }
    return this.snapshot();
  }

  prepare(
    currentHotkeys: Settings["hotkeys"],
    nextHotkeys: Settings["hotkeys"]
  ): HotkeyRegistrationTransaction {
    // Persisted configuration and successful OS ownership are deliberately
    // separate. A syntactically valid chord may have failed during the
    // best-effort boot pass because another app owned it. An unrelated edit
    // must neither retry that unchanged chord nor mark it active on commit.
    // Handler registration precedes the asynchronous boot settings read. If
    // an unusually fast settings edit wins that race, establish the same
    // best-effort baseline here before staging only the actual edit.
    if (!this.initialized) this.initialize(currentHotkeys);

    const changed = new Set<HotkeyKind>();
    for (const kind of HOTKEY_KINDS) {
      const current = currentHotkeys[kind];
      const next = nextHotkeys[kind];
      if (
        current !== next &&
        !acceleratorsAreEquivalent(current, next, this.platform)
      ) {
        changed.add(kind);
      }
    }
    const desired = this.normalizeChangedConfiguration(nextHotkeys, changed);
    if (this.suspended) {
      return this.prepareWhileSuspended(nextHotkeys, changed, desired);
    }
    const before = new Map(this.active);
    const failuresBefore = new Map(this.failures);
    const currentOwner = new Map<string, HotkeyKind>();
    for (const [kind, accelerator] of before) currentOwner.set(accelerator, kind);

    // New accelerators that PwrSnap does not already own can be staged while
    // every prior binding stays live. This is the common one-row edit path.
    const staged = new Set<string>();
    // A swap/transfer needs a brief unregister/register handoff because
    // Electron cannot replace a callback for an owned accelerator in place.
    const releasedForTransfer = new Set<string>();

    const undoPreparedState = (): Map<HotkeyKind, string> => {
      const restoredActive = new Map(before);
      const restoredFailures = new Map(failuresBefore);
      for (const accelerator of [...staged].reverse()) {
        this.safeUnregister(accelerator, "rollback staged hotkey");
      }
      for (const accelerator of releasedForTransfer) {
        const owner = currentOwner.get(accelerator);
        if (owner === undefined) continue;
        try {
          const restored = this.registrar.register(accelerator, this.callback(owner));
          if (!restored) {
            restoredActive.delete(owner);
            restoredFailures.set(owner, this.unavailableStatus(owner, accelerator));
            this.logger.error("failed to restore prior hotkey during rollback", {
              kind: owner,
              accelerator,
              platform: this.platform
            });
          }
        } catch (cause) {
          restoredActive.delete(owner);
          restoredFailures.set(
            owner,
            this.registrationErrorStatus(owner, accelerator)
          );
          this.logger.error("prior hotkey restore threw during rollback", {
            kind: owner,
            accelerator,
            platform: this.platform,
            message: cause instanceof Error ? cause.message : String(cause)
          });
        }
      }
      this.failures = restoredFailures;
      return restoredActive;
    };

    try {
      for (const kind of changed) {
        const next = desired.get(kind) ?? "";
        const previous = before.get(kind) ?? "";
        if (next === "" || next === previous || currentOwner.has(next)) continue;
        this.registerOrThrow(kind, next);
        staged.add(next);
      }

      // Support atomic multi-row swaps (A=X,B=Y -> A=Y,B=X). Candidate
      // duplicates were rejected above, so every transferred accelerator has
      // exactly one destination callback.
      for (const kind of changed) {
        const next = desired.get(kind) ?? "";
        const owner = currentOwner.get(next);
        if (next === "" || owner === undefined || owner === kind) continue;
        if (!releasedForTransfer.has(next)) {
          this.registrar.unregister(next);
          releasedForTransfer.add(next);
        }
      }
      for (const kind of changed) {
        const next = desired.get(kind) ?? "";
        if (!releasedForTransfer.has(next)) continue;
        this.registerOrThrow(kind, next);
        staged.add(next);
      }
    } catch (cause) {
      this.active = undoPreparedState();
      throw cause;
    }

    let finished = false;
    return {
      commit: (): void => {
        if (finished) return;
        for (const kind of changed) {
          const accelerator = before.get(kind);
          if (accelerator === undefined) continue;
          if ((desired.get(kind) ?? "") === accelerator) continue;
          if (releasedForTransfer.has(accelerator)) continue;
          this.safeUnregister(accelerator, "commit replaced hotkey");
        }
        const committed = new Map(before);
        for (const kind of changed) {
          const accelerator = desired.get(kind) ?? "";
          if (accelerator === "") committed.delete(kind);
          else committed.set(kind, accelerator);
          this.configured.set(kind, nextHotkeys[kind] ?? "");
          this.failures.delete(kind);
        }
        this.active = committed;
        this.initialized = true;
        finished = true;
      },
      rollback: (): void => {
        if (finished) return;
        this.active = undoPreparedState();
        finished = true;
      }
    };
  }

  snapshot(): ReadonlyMap<HotkeyKind, string> {
    return new Map(this.active);
  }

  /** Release every native shortcut PwrSnap actually owns before the DOM
   * recorder starts. Logical configured values and boot failures remain
   * intact; settings writes use the suspended transaction path below. */
  suspendNative(): HotkeyRegistrationStatusSnapshot {
    if (!this.initialized) {
      throw new Error("hotkey registration manager has not been initialized");
    }
    if (this.suspended) return this.statusSnapshot();

    const before = new Map(this.active);
    // Restore only shortcuts that had real native ownership when the lease
    // began. Opening the recorder must not retry an untouched boot failure.
    this.restoreAfterSuspension = new Set(before.keys());
    const released: Array<[HotkeyKind, string]> = [];
    try {
      for (const entry of before) {
        this.registrar.unregister(entry[1]);
        released.push(entry);
      }
    } catch (cause) {
      // Recording must not arm while any known manager shortcut remains in a
      // half-released state. Restore everything already released; retain
      // actionable status if the rollback itself loses native ownership.
      const restored = new Map(before);
      for (const [kind, accelerator] of released) {
        try {
          if (!this.registrar.register(accelerator, this.callback(kind))) {
            restored.delete(kind);
            this.failures.set(kind, this.unavailableStatus(kind, accelerator));
          }
        } catch (restoreCause) {
          restored.delete(kind);
          this.failures.set(kind, this.registrationErrorStatus(kind, accelerator));
          this.logBootFailure(kind, accelerator, restoreCause);
        }
      }
      this.active = restored;
      this.restoreAfterSuspension.clear();
      throw new Error("PwrSnap could not release its global shortcuts for recording", {
        cause
      });
    }

    this.active.clear();
    this.suspended = true;
    return this.statusSnapshot();
  }

  /** Rebuild native ownership from the latest committed logical settings.
   * Restore is best-effort per row so one newly-reserved chord cannot strand
   * unrelated shortcuts. False/throw outcomes become typed runtime status. */
  restoreNative(): HotkeyRegistrationStatusSnapshot {
    if (!this.suspended) return this.statusSnapshot();
    this.suspended = false;
    this.active.clear();
    const claimed = new Map<string, HotkeyKind>();

    for (const kind of HOTKEY_KINDS) {
      if (!this.restoreAfterSuspension.has(kind)) continue;
      const persisted = this.configured.get(kind) ?? "";
      let accelerator: string;
      try {
        accelerator = this.normalize(kind, persisted);
      } catch (cause) {
        this.failures.set(kind, this.unsupportedStatus(kind, persisted));
        this.logBootFailure(kind, persisted, cause);
        continue;
      }
      if (accelerator === "") {
        this.failures.delete(kind);
        continue;
      }
      const existing = claimed.get(accelerator);
      if (existing !== undefined) {
        this.failures.set(kind, this.duplicateStatus(kind, existing));
        continue;
      }
      claimed.set(accelerator, kind);
      try {
        if (!this.registrar.register(accelerator, this.callback(kind))) {
          this.failures.set(kind, this.unavailableStatus(kind, accelerator));
          continue;
        }
        this.active.set(kind, accelerator);
        this.failures.delete(kind);
      } catch (cause) {
        this.failures.set(kind, this.registrationErrorStatus(kind, accelerator));
        this.logBootFailure(kind, accelerator, cause);
      }
    }
    this.restoreAfterSuspension.clear();
    return this.statusSnapshot();
  }

  isNativeSuspended(): boolean {
    return this.suspended;
  }

  /** Renderer-safe view of persisted configuration versus native ownership. */
  statusSnapshot(): HotkeyRegistrationStatusSnapshot {
    const status = {} as HotkeyRegistrationStatusSnapshot;
    for (const kind of HOTKEY_KINDS) {
      const accelerator = this.configured.get(kind) ?? "";
      const failure = this.failures.get(kind) ?? null;
      status[kind] = {
        key: kind,
        accelerator,
        state:
          accelerator === ""
            ? "unbound"
            : this.active.has(kind)
              ? "active"
              : this.suspended && failure === null
                ? "suspended"
              : this.initialized
                ? "inactive"
                : "pending",
        failure
      };
    }
    return status;
  }

  /** Retry exactly one persisted binding. No settings write occurs and no
   * unrelated native registration is released or retried. */
  retry(kind: HotkeyKind): HotkeyRegistrationStatusSnapshot {
    if (!this.initialized) {
      throw new Error("hotkey registration manager has not been initialized");
    }
    const persisted = this.configured.get(kind) ?? "";
    if (persisted === "" || this.active.has(kind)) return this.statusSnapshot();
    // A Retry cannot acquire a native accelerator while the DOM recorder
    // owns keyboard input. Lease end will retry every desired binding.
    if (this.suspended) return this.statusSnapshot();

    let accelerator: string;
    try {
      accelerator = this.normalize(kind, persisted);
    } catch (cause) {
      this.failures.set(kind, this.unsupportedStatus(kind, persisted));
      this.logBootFailure(kind, persisted, cause);
      return this.statusSnapshot();
    }

    const firstConfiguredOwner = this.firstConfiguredOwner(accelerator);
    if (firstConfiguredOwner !== undefined && firstConfiguredOwner !== kind) {
      this.failures.set(kind, this.duplicateStatus(kind, firstConfiguredOwner));
      return this.statusSnapshot();
    }

    try {
      if (!this.registrar.register(accelerator, this.callback(kind))) {
        this.failures.set(kind, this.unavailableStatus(kind, accelerator));
        return this.statusSnapshot();
      }
    } catch (cause) {
      this.failures.set(kind, this.registrationErrorStatus(kind, accelerator));
      this.logBootFailure(kind, accelerator, cause);
      return this.statusSnapshot();
    }

    this.active.set(kind, accelerator);
    this.failures.delete(kind);
    return this.statusSnapshot();
  }

  private prepareWhileSuspended(
    nextHotkeys: Settings["hotkeys"],
    changed: ReadonlySet<HotkeyKind>,
    desired: ReadonlyMap<HotkeyKind, string>
  ): HotkeyRegistrationTransaction {
    // Probe only changed candidates. The recorder already captured and
    // released the candidate key before settings:write starts, so a temporary
    // no-op native registration can prove availability without dispatching a
    // capture callback. Commit and rollback both release every probe; lease
    // end alone rebuilds durable native ownership from committed settings.
    const staged: string[] = [];
    try {
      for (const kind of changed) {
        const accelerator = desired.get(kind) ?? "";
        if (accelerator === "") continue;
        this.probeOrThrow(kind, accelerator);
        staged.push(accelerator);
      }
    } catch (cause) {
      for (const accelerator of [...staged].reverse()) {
        this.safeUnregister(accelerator, "rollback suspended hotkey probe");
      }
      throw cause;
    }

    let finished = false;
    const releaseProbes = (): void => {
      for (const accelerator of [...staged].reverse()) {
        this.safeUnregister(accelerator, "release suspended hotkey probe");
      }
    };
    return {
      commit: (): void => {
        if (finished) return;
        releaseProbes();
        for (const kind of changed) {
          const persisted = nextHotkeys[kind] ?? "";
          this.configured.set(kind, persisted);
          this.failures.delete(kind);
          if ((desired.get(kind) ?? "") === "") {
            this.restoreAfterSuspension.delete(kind);
          } else {
            this.restoreAfterSuspension.add(kind);
          }
        }
        finished = true;
      },
      rollback: (): void => {
        if (finished) return;
        releaseProbes();
        finished = true;
      }
    };
  }

  private normalizeChangedConfiguration(
    hotkeys: Settings["hotkeys"],
    changed: ReadonlySet<HotkeyKind>
  ): Map<HotkeyKind, string> {
    const normalized = new Map<HotkeyKind, string>();
    const ownersByAccelerator = new Map<string, HotkeyKind[]>();
    for (const kind of HOTKEY_KINDS) {
      let accelerator: string;
      try {
        accelerator = this.normalize(kind, hotkeys[kind] ?? "");
      } catch (cause) {
        // Do not make an unrelated edit impossible because an older settings
        // file contains a now-unsupported untouched value. The boot pass
        // already left that value inactive and logged it. A caller changing
        // the value still receives the actionable validation error.
        if (changed.has(kind)) throw cause;
        continue;
      }
      if (accelerator !== "") {
        const owners = ownersByAccelerator.get(accelerator) ?? [];
        owners.push(kind);
        ownersByAccelerator.set(accelerator, owners);
      }
      normalized.set(kind, accelerator);
    }
    for (const [accelerator, owners] of ownersByAccelerator) {
      if (owners.length < 2 || !owners.some((kind) => changed.has(kind))) continue;
      const kind = owners.find((owner) => changed.has(owner)) ?? owners.at(-1)!;
      const existing = owners.find((owner) => owner !== kind)!;
      throw new HotkeyRegistrationError({
        code: "hotkey_duplicate",
        hotkeyKind: kind,
        accelerator,
        message:
          `${HOTKEY_LABELS[kind]} and ${HOTKEY_LABELS[existing]} both use ` +
          `${this.display(accelerator)}. Choose a different combination or explicitly clear one first.`
      });
    }
    return normalized;
  }

  private normalize(kind: HotkeyKind, accelerator: string): string {
    const result = canonicalAcceleratorForPlatform(accelerator, this.platform);
    if (!result.ok) {
      throw new HotkeyRegistrationError({
        code: "hotkey_unsupported",
        hotkeyKind: kind,
        accelerator,
        message:
          `${HOTKEY_LABELS[kind]} cannot use ${this.display(accelerator)} on ` +
          `${shortcutPlatformLabel(this.platform)}. ` +
          "Choose another combination. The saved shortcut was not changed."
      });
    }
    if (result.unbound) return "";
    return result.normalized;
  }

  private registerOrThrow(kind: HotkeyKind, accelerator: string): void {
    try {
      if (this.registrar.register(accelerator, this.callback(kind))) return;
    } catch (cause) {
      throw this.unavailable(kind, accelerator, cause);
    }
    throw this.unavailable(kind, accelerator);
  }

  private probeOrThrow(kind: HotkeyKind, accelerator: string): void {
    try {
      if (this.registrar.register(accelerator, () => undefined)) return;
    } catch (cause) {
      throw this.unavailable(kind, accelerator, cause);
    }
    throw this.unavailable(kind, accelerator);
  }

  private firstConfiguredOwner(accelerator: string): HotkeyKind | undefined {
    for (const candidate of HOTKEY_KINDS) {
      const persisted = this.configured.get(candidate) ?? "";
      if (persisted === "") continue;
      try {
        if (this.normalize(candidate, persisted) === accelerator) return candidate;
      } catch {
        // Unsupported persisted values cannot own a native accelerator.
      }
    }
    return undefined;
  }

  private unavailableStatus(
    kind: HotkeyKind,
    accelerator: string
  ): HotkeyRegistrationFailure {
    return {
      code: "unavailable",
      message:
        `${HOTKEY_LABELS[kind]} is not active — ${shortcutPlatformLabel(this.platform)} ` +
        `or another app has reserved or is using ${this.display(accelerator)}. ` +
        "Choose another combination, or Retry after it is freed."
    };
  }

  private registrationErrorStatus(
    kind: HotkeyKind,
    accelerator: string
  ): HotkeyRegistrationFailure {
    return {
      code: "registration_error",
      message:
        `${HOTKEY_LABELS[kind]} is not active because ${shortcutPlatformLabel(this.platform)} ` +
        `could not register ${this.display(accelerator)}. Choose another combination, or Retry.`
    };
  }

  private unsupportedStatus(
    kind: HotkeyKind,
    accelerator: string
  ): HotkeyRegistrationFailure {
    return {
      code: "unsupported",
      message:
        `${HOTKEY_LABELS[kind]} is not active because ${this.display(accelerator)} ` +
        `is not supported on ${shortcutPlatformLabel(this.platform)}. ` +
        "Choose another combination."
    };
  }

  private duplicateStatus(
    kind: HotkeyKind,
    existing: HotkeyKind
  ): HotkeyRegistrationFailure {
    return {
      code: "duplicate",
      message:
        `${HOTKEY_LABELS[kind]} is not active because it duplicates ` +
        `${HOTKEY_LABELS[existing]}. Choose another combination.`
    };
  }

  private display(accelerator: string): string {
    return acceleratorToDisplayText(accelerator, this.platform) || "that combination";
  }

  private unavailable(
    kind: HotkeyKind,
    accelerator: string,
    cause?: unknown
  ): HotkeyRegistrationError {
    return new HotkeyRegistrationError({
      code: "hotkey_unavailable",
      hotkeyKind: kind,
      accelerator,
      message:
        `${HOTKEY_LABELS[kind]} could not claim ${this.display(accelerator)}. ` +
        `${shortcutPlatformLabel(this.platform)} or another app may reserve that combination. ` +
        "Choose another combination. The saved shortcut was not changed.",
      ...(cause === undefined ? {} : { cause })
    });
  }

  private callback(kind: HotkeyKind): () => void {
    const callback = this.callbacks.get(kind);
    if (callback === undefined) throw new Error(`missing hotkey callback for ${kind}`);
    return callback;
  }

  private safeUnregister(accelerator: string, operation: string): void {
    try {
      this.registrar.unregister(accelerator);
    } catch (cause) {
      this.logger.error(`${operation} threw`, {
        accelerator,
        platform: this.platform,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }

  private logBootFailure(kind: HotkeyKind, accelerator: string, cause: unknown): void {
    this.logger.warn("failed to register persisted hotkey", {
      kind,
      accelerator,
      platform: this.platform,
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }
}
