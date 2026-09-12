// Recording SOURCE CHIP — the one control that states what a recording
// will contain, and whether it is actually working.
//
// Why this exists
// ───────────────
// "Which sources is this take capturing, and are they live?" used to be
// answered in five different places, in five different vocabularies: a
// Settings switch, a selector pill, a click-through status card, a
// focused permission panel, and a native alert after the fact. None of
// them could show a level, so a muted microphone and a working one
// looked identical right up until playback.
//
// The chip collapses that into one object rendered at three densities:
//
//   region selector   control   label + meter + device caret + hotkey
//   recording HUD     monitor   `dense`  — glyph + meter
//   float-over toast  receipt   `static` — glyph + label, no interaction
//
// The meter is the load-bearing part. An accent border only says
// "requested"; a moving meter says "and it is arriving".
//
// Styling notes live in SourceChip.css — in particular why the geometry
// copies `.region-hud__toggle`, and why `--onScrim` exists.

import type { ReactElement } from "react";
import type { RecordingSourceKind } from "@pwrsnap/shared";
import "./SourceChip.css";

/**
 * What the chip is telling the user right now.
 *
 * These are PRESENTATION states, deliberately not a mirror of
 * `RecordingPermissionStatus`. Several permission statuses collapse to
 * the same chip (`restricted` and `unavailable` both read as
 * `unsupported`, because the user's next action is identical: nothing),
 * and two chip states have no permission analogue at all (`live` and
 * `silent` are about signal, not access).
 */
export type SourceChipState =
  /** Available, not requested. */
  | "off"
  /** Requested, granted, signal arriving. */
  | "live"
  /** Requested and granted, but nothing has arrived. */
  | "silent"
  /** Never granted. Carries an inline grant action. */
  | "ask"
  /** Granted once, revoked since. Carries an inline Settings action. */
  | "denied"
  /** Granted, but there is no such device attached. */
  | "nodevice"
  /** This recorder cannot capture this source at all. */
  | "unsupported";

export type SourceChipProps = {
  readonly source: RecordingSourceKind;
  readonly state: SourceChipState;
  /** 0..1. Only read in `live`; `silent` forces an empty, tinted meter. */
  readonly level?: number;
  /** Overrides the default source name. */
  readonly label?: string;
  /** Short reason shown in place of a meter — "needs access", "macOS only". */
  readonly why?: string;
  /** Inline action label — "Allow", "Settings". Implies `onAct`. */
  readonly act?: string;
  readonly onAct?: () => void;
  /** Hotkey glyph. Omitted in dense/static densities. */
  readonly kbd?: string;
  /** Draw the device caret. Only meaningful with `onOpenDevices`. */
  readonly hasDevices?: boolean;
  readonly onOpenDevices?: () => void;
  readonly onToggle?: () => void;
  readonly density?: "control" | "dense" | "static";
  /** Pin legible values for the recording HUD's black scrim. */
  readonly onScrim?: boolean;
  /**
   * Receipt meters have no live level to show. `recorded` draws a
   * static full read instead of faking one.
   */
  readonly meterTone?: "live" | "flat" | "recorded";
  /**
   * Suppress the meter on an audio source that is armed but cannot be
   * monitored.
   *
   * System audio is the case this exists for. macOS exposes no
   * renderer-reachable system-audio tap — the only way to hear it is
   * ScreenCaptureKit, inside the recorder, after the take has started —
   * so that chip has nothing to measure. An idle meter would read as
   * "armed but silent", which is precisely the wrong thing to tell
   * someone whose system audio is working fine.
   */
  readonly noMeter?: boolean;
  readonly testId?: string;
};

const SOURCE_LABEL: Record<RecordingSourceKind, string> = {
  screen: "Screen",
  systemAudio: "System audio",
  microphone: "Microphone",
  camera: "Camera"
};

/**
 * States in which the source is switched on for this take.
 *
 * This is the user's arm/disarm choice, not the device's health, so every
 * state the mapper can only reach with `on === true` belongs here. `ask`,
 * `denied` and `nodevice` all describe a source that IS armed and WILL ride
 * the commit payload; reporting `aria-pressed={false}` for them told a
 * screen-reader user the opposite of what the take was about to do.
 */
const ON_STATES: ReadonlySet<SourceChipState> = new Set<SourceChipState>([
  "live",
  "silent",
  "ask",
  "denied",
  "nodevice"
]);

/**
 * States the user cannot act on at all.
 *
 * `nodevice` is deliberately NOT here. `microphoneChipState` only returns it
 * when the source is ON, so disabling the chip removed the one control that
 * could switch off a microphone the machine does not have — and the take then
 * failed outright in the recorder (`microphone_unavailable` aborts the start).
 * The `M` key stayed live throughout, so mouse and keyboard disagreed about
 * the same control. `unsupported` is genuinely inert: there is no device
 * subsystem to arm.
 */
const INERT_STATES: ReadonlySet<SourceChipState> = new Set<SourceChipState>(["unsupported"]);

function SourceGlyph({ source }: { readonly source: RecordingSourceKind }): ReactElement {
  const common = {
    width: 13,
    height: 13,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: "ps-chip__ico",
    "aria-hidden": true
  };
  switch (source) {
    case "microphone":
      return (
        <svg {...common}>
          <rect x="5.6" y="1.6" width="4.8" height="8" rx="2.4" />
          <path d="M3.2 7.4a4.8 4.8 0 0 0 9.6 0" />
          <path d="M8 12.2v2.2" />
        </svg>
      );
    case "systemAudio":
      return (
        <svg {...common}>
          <path d="M2.2 6.2h2.4L8 3.2v9.6L4.6 9.8H2.2z" />
          <path d="M10.8 6.1a2.6 2.6 0 0 1 0 3.8" />
          <path d="M12.7 4.2a5.2 5.2 0 0 1 0 7.6" />
        </svg>
      );
    case "camera":
      return (
        <svg {...common}>
          <rect x="1.4" y="4" width="9.2" height="8" rx="2" />
          <path d="M10.6 7.6l4-2.2v5.2l-4-2.2z" />
        </svg>
      );
    case "screen":
      return (
        <svg {...common}>
          <rect x="1.4" y="2.6" width="13.2" height="9" rx="1.8" />
          <path d="M5.6 14h4.8" />
        </svg>
      );
  }
}

const METER_SEGMENTS = 7;

/**
 * Seven-segment LED level. `tone` decides what the segments MEAN:
 * `live` lights `level`, `flat` lights none over a warm tint (granted
 * but silent), `recorded` lights all as a static receipt.
 */
export function SourceMeter({
  level,
  tone
}: {
  // `| undefined` is required under exactOptionalPropertyTypes: callers
  // forward an optional prop through, which is a present key holding
  // undefined rather than an absent key.
  readonly level?: number | undefined;
  readonly tone?: "live" | "flat" | "recorded" | undefined;
}): ReactElement {
  const resolved = tone ?? "live";
  const lit =
    resolved === "flat"
      ? 0
      : resolved === "recorded"
        ? METER_SEGMENTS
        : Math.round(Math.max(0, Math.min(1, level ?? 0)) * METER_SEGMENTS);
  return (
    <span className="ps-meter" data-tone={resolved} data-level={lit} aria-hidden="true">
      {Array.from({ length: METER_SEGMENTS }, (_unused, i) => (
        <i key={i} data-on={i < lit} />
      ))}
    </span>
  );
}

function Caret(): ReactElement {
  return (
    <span className="ps-chip__caret" aria-hidden="true">
      <svg
        width="8"
        height="8"
        viewBox="0 0 10 10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M2.4 3.8L5 6.4l2.6-2.6" />
      </svg>
    </span>
  );
}

export function SourceChip({
  source,
  state,
  level,
  label,
  why,
  act,
  onAct,
  kbd,
  hasDevices,
  onOpenDevices,
  onToggle,
  density = "control",
  onScrim = false,
  meterTone,
  noMeter = false,
  testId
}: SourceChipProps): ReactElement {
  const name = label ?? SOURCE_LABEL[source];
  const on = ON_STATES.has(state);
  const inert = INERT_STATES.has(state);
  const isAudio = source === "microphone" || source === "systemAudio";
  // Screen has no level to report and camera's evidence is a picture,
  // so neither draws a meter; only the two audio sources do — and only
  // when something can actually measure them (see `noMeter`).
  // A meter claims "a level is being measured", which is only true where a
  // stream is actually open. `on` is now the broader arm/disarm fact, so it
  // cannot be the meter's gate: `ask` / `denied` / `nodevice` are armed but
  // have nothing to measure and must draw no meter at all.
  const measurable = state === "live" || state === "silent";
  const showMeter = measurable && isAudio && !noMeter;
  // `silent` outranks an explicit tone. Callers pass `meterTone="recorded"`
  // for a whole receipt row, and letting that win painted a full accent
  // meter for a source that captured nothing — pixel-identical to one that
  // worked, which is the single thing this row exists to distinguish.
  const tone: "live" | "flat" | "recorded" =
    state === "silent" ? "flat" : (meterTone ?? "live");

  const className = [
    "ps-chip",
    density === "dense" ? "ps-chip--dense" : null,
    density === "static" ? "ps-chip--static" : null,
    onScrim ? "ps-chip--onScrim" : null
  ]
    .filter((part): part is string => part !== null)
    .join(" ");

  // A receipt is not a button. Rendering it as one would put it in the
  // tab order and invite a click that does nothing.
  if (density === "static") {
    return (
      <span
        className={className}
        data-state={state}
        data-source={source}
        {...(testId !== undefined ? { "data-testid": testId } : {})}
      >
        <SourceGlyph source={source} />
        <span className="ps-chip__name">{name}</span>
        {showMeter ? <SourceMeter level={level} tone={tone} /> : null}
        {why !== undefined ? <span className="ps-chip__why">{why}</span> : null}
      </span>
    );
  }

  // Anything that is NOT the toggle. The chip is a plain wrapper until
  // one of these exists; only then is it a group of controls that a
  // screen reader should be told about, and only then does announcing
  // "group" around a single button stop being noise.
  const hasAct = act !== undefined;
  const hasCaret = hasDevices === true && !inert;
  const grouped = hasAct || hasCaret;

  // The chip is a GROUP, not a button.
  //
  // The grant action and the device caret used to be `role="button"`
  // spans NESTED inside the chip's own <button>. `role="button"` has
  // presentational children per ARIA, and Chromium prunes descendant
  // roles out of a button's accessibility tree, so neither was
  // reachable: a VoiceOver user on the microphone chip in `ask` heard
  // one button named "Microphone needs access Allow M" and had no way
  // to press Allow — the only in-chip affordance that fires the macOS
  // TCC grant. Same for `denied` -> Settings. Interactive content
  // inside <button> is also invalid HTML, so no engine owed us the
  // behavior it happened to give.
  //
  // Siblings inside a non-interactive wrapper is the fix. The wrapper
  // keeps every class, data attribute and `title` the <button> carried,
  // so all the `.ps-chip[data-state=...]` rules and both test suites
  // still resolve against one element; `.ps-chip__body` adds no chrome
  // and no width of its own (see SourceChip.css).
  return (
    <span
      className={className}
      data-state={state}
      data-source={source}
      title={why}
      {...(grouped ? { role: "group", "aria-label": name } : {})}
      {...(testId !== undefined ? { "data-testid": testId } : {})}
    >
      <button
        type="button"
        className="ps-chip__body"
        aria-pressed={on}
        disabled={inert}
        // Dense drops the visible label, which left the button with an
        // aria-hidden glyph and an aria-hidden meter — no accessible
        // name at all. Elsewhere the name comes from the visible text,
        // which is what voice control needs to match.
        {...(density === "dense" ? { "aria-label": name } : {})}
        // The real home for "press M". It rode in as a trailing "M" on
        // the button's name before, which said nothing about what it
        // was.
        {...(kbd !== undefined ? { "aria-keyshortcuts": kbd } : {})}
        onClick={onToggle}
      >
        <SourceGlyph source={source} />
        {density === "dense" ? null : <span className="ps-chip__name">{name}</span>}
        {showMeter ? <SourceMeter level={level} tone={tone} /> : null}
        {why !== undefined ? <span className="ps-chip__why">{why}</span> : null}
      </button>
      {hasAct ? (
        // No stopPropagation any more: there is no enclosing button left
        // for a click to reach.
        <button type="button" className="ps-chip__act" onClick={onAct}>
          {act}
        </button>
      ) : null}
      {hasCaret ? (
        <button
          type="button"
          className="ps-chip__devices"
          aria-label={`Choose ${name.toLowerCase()} device`}
          onClick={onOpenDevices}
        >
          <Caret />
        </button>
      ) : null}
      {kbd !== undefined && density === "control" ? (
        // Decorative now that `aria-keyshortcuts` carries the fact.
        <kbd className="ps-chip__kbd" aria-hidden="true">
          {kbd}
        </kbd>
      ) : null}
    </span>
  );
}
