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
  readonly testId?: string;
};

const SOURCE_LABEL: Record<RecordingSourceKind, string> = {
  screen: "Screen",
  systemAudio: "System audio",
  microphone: "Microphone",
  camera: "Camera"
};

/** States in which the source is switched on for this take. */
const ON_STATES: ReadonlySet<SourceChipState> = new Set<SourceChipState>(["live", "silent"]);

/** States the user cannot act on at all. */
const INERT_STATES: ReadonlySet<SourceChipState> = new Set<SourceChipState>([
  "nodevice",
  "unsupported"
]);

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
  testId
}: SourceChipProps): ReactElement {
  const name = label ?? SOURCE_LABEL[source];
  const on = ON_STATES.has(state);
  const inert = INERT_STATES.has(state);
  const isAudio = source === "microphone" || source === "systemAudio";
  // Screen has no level to report and camera's evidence is a picture,
  // so neither draws a meter; only the two audio sources do.
  const showMeter = on && isAudio;
  const tone: "live" | "flat" | "recorded" =
    meterTone ?? (state === "silent" ? "flat" : "live");

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

  return (
    <button
      type="button"
      className={className}
      data-state={state}
      data-source={source}
      aria-pressed={on}
      disabled={inert}
      title={why}
      onClick={onToggle}
      {...(testId !== undefined ? { "data-testid": testId } : {})}
    >
      <SourceGlyph source={source} />
      {density === "dense" ? null : <span className="ps-chip__name">{name}</span>}
      {showMeter ? <SourceMeter level={level} tone={tone} /> : null}
      {why !== undefined ? <span className="ps-chip__why">{why}</span> : null}
      {act !== undefined ? (
        <span
          className="ps-chip__act"
          role="button"
          tabIndex={0}
          onClick={(event) => {
            // The chip itself is a toggle; the grant action is not.
            event.stopPropagation();
            onAct?.();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            onAct?.();
          }}
        >
          {act}
        </span>
      ) : null}
      {hasDevices === true && !inert ? (
        <span
          role="button"
          tabIndex={0}
          aria-label={`Choose ${name.toLowerCase()} device`}
          onClick={(event) => {
            event.stopPropagation();
            onOpenDevices?.();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            onOpenDevices?.();
          }}
        >
          <Caret />
        </span>
      ) : null}
      {kbd !== undefined && density === "control" ? (
        <kbd className="ps-chip__kbd">{kbd}</kbd>
      ) : null}
    </button>
  );
}
