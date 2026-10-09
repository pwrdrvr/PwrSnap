// The microphone, as a recording source chip in the region selector, and
// its device picker.
//
// The chip names the device the take will record from. Its caret opens a
// picker that changes the device (saved through the settings substrate by
// the caller), shows a level meter fine enough to set gain by, with a peak
// hold and a clip latch, and offers a short record-and-play-back test.
//
// Pre-record only. The selector is gone before the take starts, and so is
// everything here; the recording HUD never opens this.

import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactElement } from "react";
import { resolveDevicePreference, type RecordingDevicePreference } from "@pwrsnap/shared";
import { useDismissable } from "../../lib/useDismissable";
import { useFocusReturn } from "../../lib/useFocusReturn";
import { chipDensity, SourceChip, type SourceChipState, type SourceChipVariant } from "../shared/SourceChip";
import { METER_FLOOR_DB, meterFraction, type LevelMeterStore } from "../shared/mic-level-meter";
import type { MicrophoneMonitor } from "../shared/useMicrophoneMonitor";
import { MIC_TEST_SECONDS, useMicrophoneTest } from "../shared/useMicrophoneTest";
import "./microphone-chip.css";

/**
 * The label the chip and the picker show for the device the take will use,
 * or would use if the microphone were turned on: an off chip still names
 * the saved pick, so the tile says which microphone M would arm.
 */
export function microphoneDeviceName({
  state,
  monitor,
  preference
}: {
  readonly state: SourceChipState;
  readonly monitor: Pick<MicrophoneMonitor, "activeLabel" | "followsDefault">;
  readonly preference: RecordingDevicePreference | null;
}): string | undefined {
  // No microphone subsystem: there is nothing to name.
  if (state === "unsupported") return undefined;
  // The device that is actually open is the only name we KNOW. Gated on
  // the state, because the monitor closes one render after the chip turns
  // off and its last label would otherwise linger.
  if (state !== "off" && monitor.activeLabel !== null) return monitor.activeLabel;
  // Unopened (off, or a Quick Capture that only offers Record): the saved
  // pick is what the recorder will be asked for.
  if (preference !== null && preference.label !== "") return preference.label;
  return "System default";
}

export function MicrophoneChip({
  state,
  why,
  armed,
  monitor,
  preference,
  onToggle,
  onArm,
  onPick,
  onOpenSettings,
  onOpenSoundSettings,
  openRequest = 0,
  variant = "tile"
}: {
  readonly state: SourceChipState;
  readonly why: string | undefined;
  /** The stream may be opened for this show (see `sourcesArmed`). */
  readonly armed: boolean;
  readonly monitor: MicrophoneMonitor;
  readonly preference: RecordingDevicePreference | null;
  readonly onToggle: () => void;
  /**
   * Opening the picker is an explicit act: it may open the microphone. The
   * selector draws this chip only once the stream is already armed, so
   * nothing there needs it.
   */
  readonly onArm?: () => void;
  /** `null` = follow the system default. */
  readonly onPick: (preference: RecordingDevicePreference | null) => void;
  readonly onOpenSettings: () => void;
  /** The footer's Sound settings link; absent where there is no such page. */
  readonly onOpenSoundSettings?: (() => void) | undefined;
  /**
   * Bumped by the selector to open the picker without a click: Record
   * found the saved microphone gone. The value at mount is not a request.
   */
  readonly openRequest?: number;
  /** Which HUD the chip sits in: the tile row, the Shutter's orbs, the Clapperboard's slate. */
  readonly variant?: SourceChipVariant;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const on = state !== "off" && state !== "unsupported";
  const test = useMicrophoneTest({
    getStream: monitor.getStream,
    deviceKey: open && on ? monitor.activeDeviceId : null
  });

  // A request opens the picker and puts the keyboard on System default,
  // the row the take falls back to, so ↵ / Space / the arrows work
  // without reaching for the mouse.
  const handledRequest = useRef(openRequest);
  const focusOnOpen = useRef(false);
  useEffect(() => {
    if (openRequest === handledRequest.current) return;
    handledRequest.current = openRequest;
    if (openRequest === 0) return;
    triggerRef.current = rootRef.current?.querySelector<HTMLElement>(".ps-chip__devices") ?? null;
    focusOnOpen.current = true;
    setOpen(true);
  }, [openRequest]);
  useEffect(() => {
    if (!open || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    popRef.current?.querySelector<HTMLElement>('[data-testid="region-hud-mic-default"]')?.focus();
  }, [open]);

  // Nothing to pick from once the chip is switched off.
  useEffect(() => {
    if (!on) setOpen(false);
  }, [on]);
  // A prewarmed selector that is hidden takes its picker down with it.
  useEffect(() => {
    const hidden = (): void => {
      if (document.hidden) setOpen(false);
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, []);

  useDismissable({
    open,
    onDismiss: () => setOpen(false),
    surfaceRef: popRef,
    triggerRef,
    dismissOnFocusLeave: true
  });
  // A row click blurs itself (the HUD drops focus after every click), so a
  // close can strand focus on <body>; hand it back to the caret.
  useFocusReturn({ open, containerRef: popRef, returnFocusRef: triggerRef });
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent): void => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);
  // Closing the picker ends a test in flight.
  const cancelTest = test.cancel;
  useEffect(() => {
    if (!open) cancelTest();
  }, [open, cancelTest]);

  const device = microphoneDeviceName({ state, monitor, preference });
  const followDefault = preference === null || monitor.missing !== null;
  const resolved = followDefault ? null : resolveDevicePreference(monitor.devices, preference);
  const pickedId = resolved?.kind === "found" ? resolved.device.deviceId : null;
  const caretOffered = on && state !== "denied";

  return (
    <span
      className="mic-chip"
      data-variant={variant}
      ref={rootRef}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // The selector binds M, A, K, Enter and Space on window. Inside the
        // picker those keys belong to its rows and buttons.
        if (open) event.stopPropagation();
      }}
    >
      <SourceChip
        source="microphone"
        state={state}
        level={monitor.segments / 7}
        // Armed but unopened: the chip knows the user's choice and nothing
        // about the signal, so it must not draw a meter that reads as silence.
        noMeter={!armed}
        device={device}
        clipping={monitor.clipping}
        {...(why !== undefined ? { why } : {})}
        {...(state === "ask" ? { act: "Allow", onAct: () => void monitor.request() } : {})}
        {...(state === "denied" ? { act: "Settings", onAct: onOpenSettings } : {})}
        kbd="M"
        hasDevices={caretOffered}
        onOpenDevices={() => {
          triggerRef.current = rootRef.current?.querySelector<HTMLElement>(".ps-chip__devices") ?? null;
          if (!open) onArm?.();
          setOpen((value) => !value);
        }}
        onToggle={onToggle}
        density={chipDensity(variant)}
        testId="region-hud-mic"
      />
      {open ? (
        <div
          ref={popRef}
          className="mic-pop"
          role="dialog"
          aria-label="Microphone"
          data-testid="region-hud-mic-devices"
        >
          <div className="mic-pop__hd">Microphone</div>
          <div className="mic-pop__list" role="radiogroup" aria-label="Microphone device">
            <button
              type="button"
              role="radio"
              aria-checked={followDefault}
              className="mic-pop__row"
              data-testid="region-hud-mic-default"
              onClick={() => {
                if (!followDefault || monitor.missing !== null) onPick(null);
              }}
            >
              <span className="mic-pop__dot" aria-hidden="true" />
              <span className="mic-pop__name">System default</span>
              {monitor.defaultLabel !== null ? (
                <span className="mic-pop__sub">{monitor.defaultLabel}</span>
              ) : null}
            </button>
            {monitor.devices.length === 0 ? (
              <span className="mic-pop__empty">
                {monitor.error ?? (armed ? "Opening microphone…" : "Turn the microphone on to list devices")}
              </span>
            ) : (
              monitor.devices.map((entry) => (
                <button
                  key={entry.deviceId}
                  type="button"
                  role="radio"
                  aria-checked={entry.deviceId === pickedId}
                  className="mic-pop__row"
                  onClick={() => {
                    if (entry.deviceId === pickedId) return;
                    onPick({ deviceId: entry.deviceId, label: entry.label });
                  }}
                >
                  <span className="mic-pop__dot" aria-hidden="true" />
                  <span className="mic-pop__name">{entry.label}</span>
                </button>
              ))
            )}
          </div>
          {monitor.missing !== null ? (
            <p className="mic-pop__note mic-pop__note--warn" role="status">
              {monitor.missing.label !== "" ? `“${monitor.missing.label}”` : "The saved microphone"} is not
              connected. This take records from the system default.
            </p>
          ) : null}
          <MicLevelMeter store={monitor.meter} live={armed && monitor.activeLabel !== null} />
          <p className="mic-pop__note" aria-live="polite" data-testid="region-hud-mic-advice">
            {monitor.clipping
              ? "Clipping. Turn the input level down in Sound settings, or move back from the microphone."
              : "Speak at your normal volume. Peaks between −18 and −6 dB are a good level."}
          </p>
          <div className="mic-pop__test">
            <button
              type="button"
              className="mic-pop__test-btn"
              data-testid="region-hud-mic-test"
              disabled={!test.available || monitor.activeLabel === null}
              aria-describedby="mic-pop-test-status"
              onClick={() => (test.phase === "idle" || test.phase === "failed" ? test.start() : test.cancel())}
            >
              {test.phase === "recording" || test.phase === "playing" ? "Stop" : `Test ${MIC_TEST_SECONDS} s`}
            </button>
            <span id="mic-pop-test-status" className="mic-pop__test-status" role="status">
              {test.phase === "recording"
                ? `Recording… ${test.secondsLeft}`
                : test.phase === "playing"
                  ? "Playing back"
                  : test.phase === "failed"
                    ? test.error
                    : "Hear yourself. Nothing is saved."}
            </span>
          </div>
          {monitor.devices.length > 0 || onOpenSoundSettings !== undefined ? (
            <div className="mic-pop__ft">
              <span>{inputCount(monitor.devices.length)}</span>
              {onOpenSoundSettings !== undefined ? (
                <button type="button" className="mic-pop__link" onClick={onOpenSoundSettings}>
                  Sound settings
                  <span aria-hidden="true"> ↗</span>
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}

function inputCount(n: number): string {
  if (n === 0) return "";
  return n === 1 ? "1 input" : `${n} inputs`;
}

/**
 * The picker's meter: the current peak as a bar, the held peak as a tick,
 * and CLIP. Subscribes to the monitor's store, so only this re-renders as
 * the level moves.
 */
export function MicLevelMeter({
  store,
  live
}: {
  readonly store: LevelMeterStore;
  readonly live: boolean;
}): ReactElement {
  const reading = useSyncExternalStore(store.subscribe, store.get, store.get);
  const silent = !live || reading.peakDb <= METER_FLOOR_DB;
  const readout = silent ? "−∞ dB" : `${reading.peakDb === 0 ? "0" : `−${-reading.peakDb}`} dB`;
  return (
    <div className="mic-meter" data-clipping={reading.clipping} data-testid="region-hud-mic-meter">
      <div
        className="mic-meter__track"
        role="meter"
        aria-label="Input peak"
        aria-valuemin={METER_FLOOR_DB}
        aria-valuemax={0}
        aria-valuenow={live ? reading.peakDb : METER_FLOOR_DB}
        aria-valuetext={reading.clipping ? `${readout}, clipping` : readout}
      >
        <span
          className="mic-meter__fill"
          style={{ "--level": live ? meterFraction(reading.levelDb) : 0 } as CSSProperties}
        />
        {!silent ? (
          <span className="mic-meter__hold" style={{ left: `${meterFraction(reading.peakDb) * 100}%` }} />
        ) : null}
      </div>
      <span className="mic-meter__db" aria-hidden="true">
        {readout}
      </span>
      <span className="mic-meter__clip" data-on={reading.clipping} aria-hidden="true">
        CLIP
      </span>
    </div>
  );
}
