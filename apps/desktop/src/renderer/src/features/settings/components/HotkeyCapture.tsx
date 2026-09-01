// Compact, controlled shortcut recorder for Settings → Hotkeys.
//
// The page owns which row is active, so there can be only one window-level
// keyboard listener at a time. This component owns the transient interaction
// state (held modifiers, pending candidate, save/error feedback), but never
// mutates the saved value itself. Escape, focus loss, navigation, and modal
// changes simply cancel; only the explicit Clear button calls `onUnbind`.

import {
  acceleratorToAccessibleText,
  acceleratorToDisplayKeys,
  type ShortcutPlatform
} from "@pwrsnap/shared";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement
} from "react";
import { Hk, HkUnset } from "./Hk";
import { Kbd } from "./Kbd";
import { dispatch } from "../../../lib/pwrsnap";

export type HotkeyCaptureProps = {
  /** Stable human label, used in recorder status and accessible names. */
  label: string;
  /** The current accelerator. Empty string = unbound. */
  value: string;
  /** Explicit OS semantics supplied by the preload bridge. */
  platform: ShortcutPlatform;
  /** Exactly one row on the page may be recording at a time. */
  recording: boolean;
  onStart: () => void;
  onCancel: () => void;
  /** Lets the page block modal actions while the native lease is arming. */
  onPreparingChange?: (preparing: boolean) => void;
  /** Resolves only after main has accepted and activated the binding. */
  onCommit: (next: string) => void | Promise<void>;
  /** Explicit Clear action. Keyboard input never calls this callback. */
  onUnbind?: () => void | Promise<void>;
};

export type HotkeyEventDecision =
  | { kind: "cancel" }
  | { kind: "ignore" }
  | { kind: "intermediate"; accelerator: string }
  | { kind: "candidate"; accelerator: string }
  | { kind: "reject"; message: string };

const MODIFIER_KEYS = new Set([
  "Control",
  "Alt",
  "AltGraph",
  "Shift",
  "Meta",
  "OS",
  "Hyper",
  "Super"
]);

const CODE_KEY: Readonly<Record<string, string>> = {
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Equal: "=",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
  NumpadAdd: "numadd",
  NumpadDecimal: "numdec",
  NumpadDivide: "numdiv",
  NumpadMultiply: "nummult",
  NumpadSubtract: "numsub"
};

function eventHasAltGraph(event: KeyboardEvent, platform: ShortcutPlatform): boolean {
  let reported = false;
  try {
    reported = event.getModifierState("AltGraph");
  } catch {
    // A synthetic event can omit getModifierState. The physical Right-Alt
    // fallback below covers Windows' Ctrl+Alt representation of AltGr.
  }
  return (
    reported ||
    (platform === "win32" &&
      event.code === "AltRight" &&
      event.ctrlKey &&
      event.altKey)
  );
}

function modifierParts(
  event: KeyboardEvent,
  platform: ShortcutPlatform,
  altGraphActive: boolean
): string[] {
  if (altGraphActive) {
    const parts = ["AltGr"];
    if (event.metaKey) parts.push(platform === "darwin" ? "Command" : "Super");
    if (event.shiftKey) parts.push("Shift");
    return parts;
  }

  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Control");
  if (event.metaKey) parts.push(platform === "darwin" ? "Command" : "Super");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  return parts;
}

function normalizeEventKey(
  event: KeyboardEvent,
  altGraphActive: boolean
): string | null {
  const { code, key } = event;
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
  // AltGr produces a layout character such as `@`, but Electron's AltGr
  // accelerator grammar names the physical base key. Other chords prefer
  // `event.key` so QWERTZ/AZERTY users save the key printed on the keycap,
  // rather than the US-layout position reported by `event.code`.
  if (altGraphActive && /^Key[A-Z]$/.test(code)) return code.slice(3);
  if (altGraphActive && /^Digit[0-9]$/.test(code)) return code.slice(5);
  if (key === "+") return "Plus";

  if (key.length === 1) {
    if (key === " ") return "Space";
    if (/^[\x21-\x7e]$/.test(key)) return key.toUpperCase();
  }
  // Option-modified characters can be non-ASCII (for example Option+C → ç).
  // Fall back to the physical Electron key name only when the layout value
  // cannot be represented in accelerator grammar.
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  const codeKey = CODE_KEY[code];
  if (codeKey !== undefined) return codeKey;
  switch (key) {
    case "Enter":
      return "Return";
    case "Tab":
      return "Tab";
    case "Backspace":
      return "Backspace";
    case "Delete":
      return "Delete";
    case "ArrowUp":
      return "Up";
    case "ArrowDown":
      return "Down";
    case "ArrowLeft":
      return "Left";
    case "ArrowRight":
      return "Right";
    case "Home":
      return "Home";
    case "End":
      return "End";
    case "PageUp":
      return "PageUp";
    case "PageDown":
      return "PageDown";
    case "Insert":
      return "Insert";
    default:
      return /^F([1-9]|1[0-9]|2[0-4])$/.test(key) ? key : null;
  }
}

/** Pure DOM-event interpreter. Platform is mandatory: Windows Meta means
 * Windows/Super, while macOS Meta means Command. `altGraphActive` carries the
 * physical AltRight fallback across the Ctrl → AltRight → character event
 * sequence used by Windows layouts. */
export function interpretHotkeyEvent(
  event: KeyboardEvent,
  platform: ShortcutPlatform,
  altGraphActive = false
): HotkeyEventDecision {
  // Escape is the recorder's unconditional cancel gesture, even if another
  // modifier happens to be held or the keydown is an auto-repeat.
  if (event.key === "Escape") return { kind: "cancel" };
  if (event.repeat) return { kind: "ignore" };
  if (event.isComposing || event.key === "Process") {
    return {
      kind: "reject",
      message: "Finish text composition, then press a shortcut combination."
    };
  }

  const isAltGraph = altGraphActive || eventHasAltGraph(event, platform);
  const modifiers = modifierParts(event, platform, isAltGraph);
  if (MODIFIER_KEYS.has(event.key)) {
    return { kind: "intermediate", accelerator: modifiers.join("+") };
  }

  const keyPart = normalizeEventKey(event, isAltGraph);
  if (keyPart === null) {
    return {
      kind: "reject",
      message: `PwrSnap cannot use ${event.key || "that key"} in a global shortcut.`
    };
  }

  if (modifiers.length === 0 || modifiers.every((part) => part === "Shift")) {
    const clearHint = keyPart === "Backspace" || keyPart === "Delete";
    return {
      kind: "reject",
      message: clearHint
        ? "Backspace and Delete do not clear a shortcut. Use the Clear button to unbind it."
        : platform === "darwin"
          ? "Include Command, Control, or Option in the shortcut."
          : "Include Ctrl, Alt, or the Windows key in the shortcut."
    };
  }

  return { kind: "candidate", accelerator: [...modifiers, keyPart].join("+") };
}

/** Compatibility helper retained for existing imports. Prefer the richer
 * interpreter when the caller needs cancellation/intermediate/error states. */
export function accelFromKeyboardEvent(
  event: KeyboardEvent,
  platform: ShortcutPlatform,
  altGraphActive = false
): string | null {
  const decision = interpretHotkeyEvent(event, platform, altGraphActive);
  return decision.kind === "candidate" ? decision.accelerator : null;
}

function messageFromError(error: unknown, verb: "save" | "clear"): string {
  const detail = error instanceof Error && error.message.trim() !== "" ? error.message : null;
  return detail === null
    ? `PwrSnap could not ${verb} this shortcut. The previous binding is still active.`
    : `${detail} The previous binding is still active.`;
}

function swallowKeyboardEvent(event: KeyboardEvent): void {
  event.preventDefault();
  // The recorder owns keyboard input while it is active. In particular,
  // stopPropagation alone does not prevent a second same-window listener
  // from seeing the chord and firing an editor/settings command.
  event.stopImmediatePropagation();
}

function newRecorderSessionId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid !== undefined) return randomUuid;
  return `recorder_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

// All rows share one renderer realm. This sequence makes the last clicked row
// win even if two begin IPC responses settle out of order; the stale row ends
// only its own session, which main ignores if a newer lease already owns the
// guard.
let recorderStartSequence = 0;

function RecorderKeys({
  keys,
  accessibleText,
  example
}: {
  keys: string[];
  accessibleText: string;
  example: boolean;
}): ReactElement {
  return (
    <span
      className={`pss__hk-capture-keys${example ? " is-example" : " is-live"}`}
      aria-label={accessibleText}
    >
      {keys.map((key, index) => (
        <span className="pss__hk-capture-key-part" key={`${key}-${index}`}>
          {index > 0 ? (
            <span className="pss__hk-capture-plus" aria-hidden="true">
              +
            </span>
          ) : null}
          <Kbd>{key}</Kbd>
        </span>
      ))}
    </span>
  );
}

export function HotkeyCapture({
  label,
  value,
  platform,
  recording,
  onStart,
  onCancel,
  onPreparingChange,
  onCommit,
  onUnbind
}: HotkeyCaptureProps): ReactElement {
  const [liveAccelerator, setLiveAccelerator] = useState<string>("");
  const [saving, setSaving] = useState<boolean>(false);
  const [clearing, setClearing] = useState<boolean>(false);
  const [arming, setArming] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [candidateReady, setCandidateReady] = useState<boolean>(false);
  const pendingCandidate = useRef<{ accelerator: string; code: string; key: string } | null>(
    null
  );
  const altGraphActive = useRef<boolean>(false);
  const busy = useRef<boolean>(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<boolean>(false);
  const activeLeaseSession = useRef<string | null>(null);
  const activeLeaseGeneration = useRef<number | null>(null);
  const pendingLeaseSession = useRef<string | null>(null);
  const leaseHeartbeat = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleLeaseHeartbeatRef = useRef<
    (sessionId: string, generation: number, expiresAt: number) => void
  >(() => undefined);
  const onCancelRef = useRef(onCancel);
  const onCommitRef = useRef(onCommit);
  const onPreparingChangeRef = useRef(onPreparingChange);
  // Page/context updates can replace callback identities while a transactional
  // save is in flight. Keep the listener stable and invoke the latest callback
  // so an unrelated render cannot dispose the rejection/error path.
  onCancelRef.current = onCancel;
  onCommitRef.current = onCommit;
  onPreparingChangeRef.current = onPreparingChange;

  const setPreparing = useCallback((next: boolean): void => {
    setArming(next);
    onPreparingChangeRef.current?.(next);
  }, []);

  const releaseLease = useCallback((specific?: {
    sessionId: string;
    generation: number;
  }): void => {
    const sessionId = specific?.sessionId ?? activeLeaseSession.current;
    const generation = specific?.generation ?? activeLeaseGeneration.current;
    if (sessionId === null || generation === null) return;
    if (
      activeLeaseSession.current === sessionId &&
      activeLeaseGeneration.current === generation
    ) {
      activeLeaseSession.current = null;
      activeLeaseGeneration.current = null;
      if (leaseHeartbeat.current !== null) clearTimeout(leaseHeartbeat.current);
      leaseHeartbeat.current = null;
    }
    if (pendingLeaseSession.current === sessionId) pendingLeaseSession.current = null;
    void dispatch("settings:endHotkeyRecording", { sessionId, generation }).catch(
      () => undefined
    );
  }, []);

  const stopAfterLostLease = useCallback((detail: string): void => {
    releaseLease();
    pendingCandidate.current = null;
    altGraphActive.current = false;
    restoreFocus.current = false;
    setLiveAccelerator("");
    setCandidateReady(false);
    setSaving(false);
    setError(`Shortcut recording stopped because PwrSnap could not renew its guard. ${detail}`);
    onCancelRef.current();
  }, [releaseLease]);

  const scheduleLeaseHeartbeat = useCallback((
    sessionId: string,
    generation: number,
    expiresAt: number
  ): void => {
    if (leaseHeartbeat.current !== null) clearTimeout(leaseHeartbeat.current);
    const remaining = Math.max(1_000, expiresAt - Date.now());
    leaseHeartbeat.current = setTimeout(() => {
      void (async () => {
        try {
          const result = await dispatch("settings:beginHotkeyRecording", {
            sessionId,
            generation
          });
          if (
            activeLeaseSession.current !== sessionId ||
            activeLeaseGeneration.current !== generation
          ) {
            return;
          }
          if (!result.ok || !result.value.accepted) {
            stopAfterLostLease(
              result.ok ? "A newer recorder session took ownership." : result.error.message
            );
            return;
          }
          scheduleLeaseHeartbeatRef.current(
            sessionId,
            generation,
            result.value.expiresAt
          );
        } catch (cause) {
          if (
            activeLeaseSession.current === sessionId &&
            activeLeaseGeneration.current === generation
          ) {
            stopAfterLostLease(cause instanceof Error ? cause.message : String(cause));
          }
        }
      })();
    }, Math.max(1_000, Math.floor(remaining / 2)));
  }, [stopAfterLostLease]);
  scheduleLeaseHeartbeatRef.current = scheduleLeaseHeartbeat;

  const cancel = useCallback((shouldRestoreFocus = true): void => {
    pendingCandidate.current = null;
    altGraphActive.current = false;
    restoreFocus.current = shouldRestoreFocus;
    setLiveAccelerator("");
    setCandidateReady(false);
    setError(null);
    releaseLease();
    onCancelRef.current();
  }, [releaseLease]);

  useEffect(
    () => () => {
      const active = activeLeaseSession.current;
      const generation = activeLeaseGeneration.current;
      if (leaseHeartbeat.current !== null) clearTimeout(leaseHeartbeat.current);
      leaseHeartbeat.current = null;
      activeLeaseSession.current = null;
      activeLeaseGeneration.current = null;
      pendingLeaseSession.current = null;
      if (active !== null && generation !== null) {
        void dispatch("settings:endHotkeyRecording", {
          sessionId: active,
          generation
        }).catch(() => undefined);
      }
      // A pending begin continuation observes the cleared ref and sends its
      // own matching end if begin won the race. If IPC never settles, main's
      // Settings-window cleanup / bounded timeout remains the backstop.
    },
    []
  );

  useEffect(() => {
    if (recording) return;
    releaseLease();
    pendingCandidate.current = null;
    altGraphActive.current = false;
    busy.current = false;
    setLiveAccelerator("");
    setCandidateReady(false);
    setSaving(false);
    if (restoreFocus.current) {
      restoreFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [recording, releaseLease]);

  useEffect(() => {
    if (!recording) return;
    let disposed = false;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (busy.current) {
        swallowKeyboardEvent(event);
        return;
      }
      if (eventHasAltGraph(event, platform)) altGraphActive.current = true;
      const decision = interpretHotkeyEvent(event, platform, altGraphActive.current);
      swallowKeyboardEvent(event);

      switch (decision.kind) {
        case "cancel":
          cancel(true);
          return;
        case "ignore":
          return;
        case "reject":
          pendingCandidate.current = null;
          setLiveAccelerator("");
          setCandidateReady(false);
          setError(decision.message);
          return;
        case "intermediate":
          pendingCandidate.current = null;
          setLiveAccelerator(decision.accelerator);
          setCandidateReady(false);
          setError(null);
          return;
        case "candidate":
          pendingCandidate.current = {
            accelerator: decision.accelerator,
            code: event.code,
            key: event.key
          };
          setLiveAccelerator(decision.accelerator);
          setCandidateReady(true);
          setError(null);
      }
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      swallowKeyboardEvent(event);
      if (event.code === "AltRight" || event.key === "AltGraph") {
        altGraphActive.current = false;
      }
      const candidate = pendingCandidate.current;
      if (candidate === null || busy.current) {
        if (MODIFIER_KEYS.has(event.key) && !busy.current) {
          const modifiers = modifierParts(event, platform, altGraphActive.current);
          setLiveAccelerator(modifiers.join("+"));
          setCandidateReady(false);
        }
        return;
      }
      const sameKey =
        candidate.code !== "" && event.code !== ""
          ? candidate.code === event.code
          : candidate.key === event.key;
      if (!sameKey) return;
      pendingCandidate.current = null;
      setCandidateReady(false);
      busy.current = true;
      restoreFocus.current = true;
      setSaving(true);
      void Promise.resolve(onCommitRef.current(candidate.accelerator))
        .then(() => releaseLease())
        .catch((commitError: unknown) => {
          if (!disposed) {
            restoreFocus.current = false;
            setError(messageFromError(commitError, "save"));
            setLiveAccelerator("");
            setCandidateReady(false);
          }
        })
        .finally(() => {
          busy.current = false;
          if (!disposed) setSaving(false);
        });
    };

    const onBlur = (): void => cancel(false);
    const onVisibilityChange = (): void => {
      if (document.visibilityState !== "visible") cancel(false);
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [recording, platform, cancel, releaseLease]);

  const startRecording = async (): Promise<void> => {
    if (arming || clearing || pendingLeaseSession.current !== null) return;
    const startSequence = ++recorderStartSequence;
    const sessionId = newRecorderSessionId();
    pendingLeaseSession.current = sessionId;
    setPreparing(true);
    setError(null);
    restoreFocus.current = false;
    let result: Awaited<ReturnType<typeof dispatch<"settings:beginHotkeyRecording">>>;
    try {
      result = await dispatch("settings:beginHotkeyRecording", {
        sessionId,
        generation: startSequence
      });
    } catch (cause) {
      if (pendingLeaseSession.current === sessionId) {
        pendingLeaseSession.current = null;
        setPreparing(false);
        setError(
          `PwrSnap could not pause its current shortcuts for recording. ${
            cause instanceof Error ? cause.message : String(cause)
          }`
        );
      }
      return;
    }
    if (
      pendingLeaseSession.current !== sessionId ||
      startSequence !== recorderStartSequence
    ) {
      if (pendingLeaseSession.current === sessionId) {
        pendingLeaseSession.current = null;
        setPreparing(false);
      }
      if (result.ok && result.value.accepted) {
        releaseLease({ sessionId, generation: startSequence });
      }
      return;
    }
    pendingLeaseSession.current = null;
    setPreparing(false);
    if (!result.ok) {
      setError(
        `PwrSnap could not pause its current shortcuts for recording. ${result.error.message}`
      );
      return;
    }
    if (!result.value.accepted) {
      setError(
        "Another shortcut recorder took ownership before this one was ready. Try again."
      );
      return;
    }
    activeLeaseSession.current = sessionId;
    activeLeaseGeneration.current = startSequence;
    scheduleLeaseHeartbeat(sessionId, startSequence, result.value.expiresAt);
    try {
      onStart();
    } catch (cause) {
      releaseLease({ sessionId, generation: startSequence });
      throw cause;
    }
  };

  const clear = async (): Promise<void> => {
    if (onUnbind === undefined || clearing) return;
    setError(null);
    setClearing(true);
    try {
      await onUnbind();
    } catch (clearError) {
      setError(messageFromError(clearError, "clear"));
    } finally {
      setClearing(false);
    }
  };

  if (recording) {
    const exampleAccelerator = platform === "darwin" ? "Command+Shift+C" : "Control+Shift+C";
    const shownAccelerator = liveAccelerator || exampleAccelerator;
    const keys = acceleratorToDisplayKeys(shownAccelerator, platform);
    const accessible = acceleratorToAccessibleText(shownAccelerator, platform);
    return (
      <span className="pss__hk-capture is-recording" aria-live="polite">
        <span className="pss__hk-capture-prompt">
          <span className="pss__hk-capture-hint">
            {saving
              ? `Saving ${label}…`
              : candidateReady
                ? "Release to save this combination"
                : liveAccelerator
                  ? "Keep holding and press another key"
                  : "Press a combination now"}
          </span>
          <RecorderKeys
            keys={keys}
            accessibleText={accessible}
            example={liveAccelerator === ""}
          />
          {error !== null ? (
            <span className="pss__hk-capture-error" role="alert">
              {error}
            </span>
          ) : null}
        </span>
        <button
          type="button"
          className="pss__hk-capture-cancel"
          onClick={() => cancel(true)}
          disabled={saving}
          aria-label={`Cancel recording ${label}`}
        >
          Cancel
        </button>
      </span>
    );
  }

  const glyphs = acceleratorToDisplayKeys(value, platform);
  const accessibleValue = value === "" ? "not set" : acceleratorToAccessibleText(value, platform);
  return (
    <span className="pss__hk-capture">
      <button
        ref={triggerRef}
        type="button"
        className="pss__hk-capture-trigger"
        onClick={() => void startRecording()}
        disabled={clearing || arming}
        aria-busy={arming}
        aria-label={`${value === "" ? "Set" : "Change"} ${label} hotkey, currently ${accessibleValue}`}
      >
        {arming ? (
          "Preparing recorder…"
        ) : glyphs.length === 0 ? (
          <HkUnset />
        ) : (
          <Hk keys={glyphs} />
        )}
      </button>
      {value !== "" && onUnbind !== undefined ? (
        <button
          type="button"
          className="pss__hk-capture-clear"
          onClick={() => void clear()}
          disabled={clearing}
          aria-label={`Clear ${label} hotkey`}
          title="Clear hotkey"
        >
          {clearing ? "…" : "×"}
        </button>
      ) : null}
      {error !== null ? (
        <span className="pss__hk-capture-error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
