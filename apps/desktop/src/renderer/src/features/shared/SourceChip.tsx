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
//                     `orb`     Shutter HUD: a round button + caption
//                     `cell`    Clapperboard HUD: a slate cell
//   recording HUD     monitor   `dense`  — glyph + meter
//   float-over toast  receipt   `static` — glyph + label, no interaction
//
// `orb` and `cell` are fixed-width boxes. A device name is the one thing
// in them whose length nobody controls ("Granola Interface (USB Audio
// Class 2.0)"), so it is ellipsized inside the box and carried whole in
// the tooltip: a selector bar that resizes when a device changes moves
// every control on it.
//
// The meter is the load-bearing part. An accent border only says
// "requested"; a moving meter says "and it is arriving".
//
// Styling notes live in SourceChip.css — in particular why the selector's
// orb and cell are fixed-width, and why `--onScrim` exists.

import { useId, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { shortDeviceLabel, type RecordingSourceKind } from "@pwrsnap/shared";
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
  /**
   * The device this source will record from, shown beside the name at
   * control density. Answers "WHICH microphone?" before the take rather
   * than in playback. Dense and static densities have no room for it.
   */
  readonly device?: string | undefined;
  /** A clipped sample arrived recently. Lights the meter's top segment. */
  readonly clipping?: boolean;
  /** Short reason shown in place of a meter — "needs access", "macOS only". */
  readonly why?: string;
  /**
   * The long form of `why`, carried as the receipt chip's tooltip. The
   * receipt prints a one-word reason where the meter would be (see
   * `reasonTakesMeterSlot`) and keeps the full sentence here.
   */
  readonly detail?: string;
  /** Inline action label — "Allow", "Settings". Implies `onAct`. */
  readonly act?: string;
  readonly onAct?: () => void;
  /** The key that toggles this source. Announced at control density
   *  (`aria-keyshortcuts`), never drawn: the selector's legend lists it. */
  readonly kbd?: string;
  /** Draw the device caret. Only meaningful with `onOpenDevices`. */
  readonly hasDevices?: boolean;
  readonly onOpenDevices?: () => void;
  readonly onToggle?: () => void;
  readonly density?: "control" | "dense" | "static" | "orb" | "cell";
  /**
   * Live media drawn in place of the glyph at `orb` density, and as the
   * signal at `cell` density: the camera's own preview.
   */
  readonly media?: ReactNode;
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

/** Which selector HUD a device chip (microphone, camera) is drawn in. */
export type SourceChipVariant = "tile" | "orb" | "cell";

/** The chip density each selector HUD draws its sources at. */
export function chipDensity(variant: SourceChipVariant): "control" | "orb" | "cell" {
  return variant === "tile" ? "control" : variant;
}

const SOURCE_LABEL: Record<RecordingSourceKind, string> = {
  screen: "Screen",
  systemAudio: "System audio",
  microphone: "Microphone",
  camera: "Camera"
};

/** The `cell` density's eyebrow. */
const SOURCE_EYEBROW: Record<RecordingSourceKind, string> = {
  screen: "SCREEN",
  systemAudio: "SYSTEM",
  microphone: "MIC",
  camera: "CAMERA"
};

/** The `orb` density's caption when there is no device to name. */
const SOURCE_SHORT: Record<RecordingSourceKind, string> = {
  screen: "Screen",
  systemAudio: "System",
  microphone: "Mic",
  camera: "Camera"
};

/** States drawn amber or red: the source is armed and something is wrong. */
const TROUBLE_STATES: ReadonlySet<SourceChipState> = new Set<SourceChipState>([
  "ask",
  "denied",
  "nodevice"
]);

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

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
/**
 * The `orb` density's level: a ring around the orb, filled clockwise to
 * the level. One element; the fill is a conic gradient masked to a ring.
 */
function OrbRing({ level, flat }: { readonly level: number | undefined; readonly flat: boolean }): ReactElement {
  const lit = flat ? 0 : Math.round(Math.max(0, Math.min(1, level ?? 0)) * 100);
  return (
    <span
      className="ps-orb__ring"
      data-tone={flat ? "flat" : "live"}
      data-level={lit}
      style={{ "--lvl": `${lit}%` } as CSSProperties}
      aria-hidden="true"
    />
  );
}

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

/** Drawn in place of the source's glyph when it is armed and in trouble. */
function WarnGlyph(): ReactElement {
  return (
    <svg
      className="ps-chip__ico ps-chip__ico--warn"
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2.2l6.2 11H1.8z" />
      <path d="M8 6.6v3" />
      <path d="M8 11.6v.1" />
    </svg>
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
  device,
  clipping = false,
  why,
  detail,
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
  media,
  testId
}: SourceChipProps): ReactElement {
  const name = label ?? SOURCE_LABEL[source];
  const subId = useId();
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
  // In a receipt, a stated reason REPLACES the meter rather than joining it.
  // A silent receipt used to draw its flat meter AND "no audio captured",
  // saying the same thing twice and making the failure case the widest
  // chip: screen + a live mic + a silent system audio came to 456px in the
  // float-over's 366px row, so the row wrapped exactly when it mattered and
  // the toast grew past its window. The receipt now passes a one-word
  // reason sized to the meter's slot, so a clean take and a broken one lay
  // out identically.
  const reasonTakesMeterSlot = density === "static" && why !== undefined;
  const showMeter = measurable && isAudio && !noMeter && !reasonTakesMeterSlot;
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
    density === "control" ? "ps-chip--tile" : null,
    density === "orb" ? "ps-chip--orb" : null,
    density === "cell" ? "ps-chip--cell" : null,
    density === "control" && act !== undefined && !INERT_STATES.has(state) ? "ps-chip--act" : null,
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
        // The long reason the one-word `why` stands for. The receipt is in
        // the float-over toast, so it gets the app's fast tooltip.
        data-tip={detail}
        {...(testId !== undefined ? { "data-testid": testId } : {})}
      >
        <SourceGlyph source={source} />
        <span className="ps-chip__name">{name}</span>
        {showMeter ? <SourceMeter level={level} tone={tone} /> : null}
        {why !== undefined ? <span className="ps-chip__why">{why}</span> : null}
      </span>
    );
  }

  if (density === "orb" || density === "cell") {
    return (
      <HudSourceChip
        density={density}
        className={className}
        source={source}
        state={state}
        name={name}
        on={on}
        inert={inert}
        level={level}
        device={device}
        clipping={clipping}
        why={why}
        act={act}
        onAct={onAct}
        kbd={kbd}
        hasDevices={hasDevices}
        onOpenDevices={onOpenDevices}
        onToggle={onToggle}
        meter={measurable && isAudio && !noMeter}
        flat={state === "silent"}
        media={media}
        testId={testId}
      />
    );
  }

  // Anything that is NOT the toggle. The chip is a plain wrapper until
  // one of these exists; only then is it a group of controls that a
  // screen reader should be told about, and only then does announcing
  // "group" around a single button stop being noise.
  // Both carry `!inert`. The enclosing <button> used to be `disabled`,
  // which Chromium made swallow clicks on everything inside it; as
  // siblings they are only as inert as they say they are, and an
  // "Allow" on a source with no device subsystem to arm is a control
  // that cannot do anything.
  const hasAct = act !== undefined && !inert;
  const hasCaret = hasDevices === true && !inert;
  const grouped = hasAct || hasCaret;
  // Only the selector's control density has a key handler behind it. The
  // key is announced, not drawn: the selector's shortcut legend (behind its
  // "?") lists M / A / K, and a badge on every tile cost the bar ~75px.
  const keyBound = kbd !== undefined && density === "control";

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
  // keeps every class and data attribute the <button> carried, so all
  // the `.ps-chip[data-state=...]` rules and both test suites still
  // resolve against one element; `.ps-chip__body` adds no chrome and no
  // width of its own (see SourceChip.css).
  //
  // The tooltip says what the chip does not draw. At control density the
  // name and the reason are both visible text, so there is nothing to
  // add. Dense drops the name, and dense is only the recording HUD: a
  // window sized to its own pill, which an in-page tooltip could not leave
  // and would cover the HUD's buttons inside. So it keeps the native
  // `title`, which the OS draws in a window of its own.
  // The selector draws a two-line tile: the source and its meter on top,
  // and below it the reason, when there is one, then the device. A row
  // of single-line chips carrying both had to be ~400px wide for one
  // microphone, and resized itself whenever a reason came or went.
  const tile = density === "control";
  const shownDevice = tile && device !== undefined ? shortDeviceLabel(device) : "";
  const subline = tile && (why !== undefined || shownDevice !== "");
  const hudTitle =
    density === "dense" ? (why === undefined ? name : `${name} — ${why}`) : undefined;
  return (
    <span
      className={className}
      data-state={state}
      data-source={source}
      {...(clipping ? { "data-clipping": "true" } : {})}
      title={hudTitle}
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
        // was. Gated on `keyBound`, not on `kbd` alone: announcing a
        // shortcut the surface does not bind is the same
        // two-predicates-that-must-agree bug as the hint legend's.
        {...(keyBound ? { "aria-keyshortcuts": kbd } : {})}
        {...(subline ? { "aria-describedby": subId } : {})}
        onClick={onToggle}
      >
        <SourceGlyph source={source} />
        {density === "dense" ? null : <span className="ps-chip__name">{name}</span>}
        {showMeter ? <SourceMeter level={level} tone={tone} /> : null}
        {!tile && why !== undefined ? <span className="ps-chip__why">{why}</span> : null}
      </button>
      {hasAct ? (
        // No stopPropagation any more: there is no enclosing button left
        // for a click to reach. Wrapped rather than passed straight to
        // `onClick`, which would hand the SyntheticEvent to a callback
        // the prop type declares as zero-argument — a caller whose
        // function takes an optional first parameter would read it as a
        // truthy argument.
        <button type="button" className="ps-chip__act" onClick={() => onAct?.()}>
          {act}
        </button>
      ) : null}
      {hasCaret ? (
        <button
          type="button"
          className="ps-chip__devices"
          aria-label={`Choose ${name.toLowerCase()} device`}
          onClick={() => onOpenDevices?.()}
        >
          <Caret />
        </button>
      ) : null}
      {subline ? (
        // Outside the toggle, so it is not part of the button's name, but
        // the toggle's ::after overlay still covers it: a click here
        // toggles like anywhere else on the tile.
        <span className="ps-chip__sub" id={subId}>
          {why !== undefined ? <span className="ps-chip__why">{why}</span> : null}
          {why !== undefined && shownDevice !== "" ? <span aria-hidden="true"> · </span> : null}
          {shownDevice !== "" ? <span className="ps-chip__dev">{shownDevice}</span> : null}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The selector HUD's two fixed-width shapes.
 *
 *   orb   a 34px round toggle with the signal on it (the microphone's
 *         level as a ring, the camera's own picture), and one caption
 *         line under it: the device, or what is wrong.
 *   cell  a slate cell: an eyebrow and the signal on the top line, the
 *         device (or what is wrong) on the bottom line, caret beside it.
 *
 * The structure is the control density's — a group holding the toggle,
 * the grant action and the device caret as sibling buttons — so the
 * `[data-state]` cascade and the accessibility contract are the same.
 * What differs is that the box never changes width: the caption is
 * ellipsized, and the whole name rides the fast tooltip.
 */
function HudSourceChip({
  density,
  className,
  source,
  state,
  name,
  on,
  inert,
  level,
  device,
  clipping,
  why,
  act,
  onAct,
  kbd,
  hasDevices,
  onOpenDevices,
  onToggle,
  meter,
  flat,
  media,
  testId
}: {
  readonly density: "orb" | "cell";
  readonly className: string;
  readonly source: RecordingSourceKind;
  readonly state: SourceChipState;
  readonly name: string;
  readonly on: boolean;
  readonly inert: boolean;
  readonly level: number | undefined;
  readonly device: string | undefined;
  readonly clipping: boolean;
  readonly why: string | undefined;
  readonly act: string | undefined;
  readonly onAct: (() => void) | undefined;
  readonly kbd: string | undefined;
  readonly hasDevices: boolean | undefined;
  readonly onOpenDevices: (() => void) | undefined;
  readonly onToggle: (() => void) | undefined;
  readonly meter: boolean;
  readonly flat: boolean;
  readonly media: ReactNode;
  readonly testId: string | undefined;
}): ReactElement {
  const captionId = useId();
  const hasAct = act !== undefined && !inert;
  // The orb's grant action takes the caption's line.
  const captionShown = !(hasAct && density === "orb");
  const hasCaret = hasDevices === true && !inert;
  const trouble = TROUBLE_STATES.has(state);
  const shownDevice = device !== undefined ? shortDeviceLabel(device) : "";
  // The caption says one thing: what is wrong when the source cannot
  // record, else the device. A reason on a source that WILL record —
  // `silent` ("no signal"), a camera still starting — stays out of it:
  // silence is the normal state of a microphone in a quiet room, and
  // swapping the device's name for "No signal" until the user made a
  // noise hid the one thing the caption is for. The ring (or meter) says
  // there is no level, and the tooltip carries the reason. The full device
  // name is in the tooltip too, which is what lets the caption be cut
  // short without losing anything.
  const captionWhy = why !== undefined && (trouble || inert) ? why : undefined;
  const caption =
    captionWhy !== undefined ? (
      <span className="ps-chip__why">{sentenceCase(captionWhy)}</span>
    ) : shownDevice !== "" ? (
      <span className="ps-chip__dev">{shownDevice}</span>
    ) : density === "orb" ? (
      SOURCE_SHORT[source]
    ) : on ? (
      "On"
    ) : (
      "Off"
    );
  const tip = device !== undefined && device !== "" ? `${name} · ${device}` : name;
  const tipDetail = why !== undefined ? sentenceCase(why) : undefined;
  const signal =
    density === "orb" ? (
      <span className="ps-orb">
        {meter ? <OrbRing level={level} flat={flat} /> : null}
        {media !== undefined && media !== null ? (
          <span className="ps-orb__media">{media}</span>
        ) : (
          trouble ? <WarnGlyph /> : <SourceGlyph source={source} />
        )}
      </span>
    ) : (
      <>
        <span className="ps-cell__eye">
          {trouble ? <WarnGlyph /> : null}
          {SOURCE_EYEBROW[source]}
        </span>
        <span className="ps-cell__vis">
          {!on ? (
            <span className="ps-cell__off">OFF</span>
          ) : trouble ? null : media !== undefined && media !== null ? (
            <span className="ps-cell__media">{media}</span>
          ) : meter ? (
            <SourceMeter level={level} tone={flat ? "flat" : "live"} />
          ) : (
            <span className="ps-cell__led" />
          )}
        </span>
      </>
    );
  return (
    <span
      className={className}
      data-state={state}
      data-source={source}
      {...(clipping ? { "data-clipping": "true" } : {})}
      {...(hasAct || hasCaret ? { role: "group", "aria-label": name } : {})}
      {...(testId !== undefined ? { "data-testid": testId } : {})}
    >
      <button
        type="button"
        className="ps-chip__body"
        aria-pressed={on}
        aria-label={name}
        {...(captionShown ? { "aria-describedby": captionId } : {})}
        disabled={inert}
        data-tip={tip}
        {...(kbd !== undefined ? { "data-tip-keys": kbd, "aria-keyshortcuts": kbd } : {})}
        {...(tipDetail !== undefined ? { "data-tip-detail": tipDetail } : {})}
        onClick={onToggle}
      >
        {signal}
      </button>
      {!captionShown ? (
        // The grant action takes the caption's line: the orb is already
        // amber, and the tooltip carries the reason.
        <button type="button" className="ps-chip__act" onClick={() => onAct?.()}>
          {act}
        </button>
      ) : (
        <span className="ps-chip__cap" id={captionId}>
          {caption}
        </span>
      )}
      {hasAct && density === "cell" ? (
        <button type="button" className="ps-chip__act" onClick={() => onAct?.()}>
          {act}
        </button>
      ) : null}
      {hasCaret ? (
        <button
          type="button"
          className="ps-chip__devices"
          aria-label={`Choose ${name.toLowerCase()} device`}
          onClick={() => onOpenDevices?.()}
        >
          <Caret />
        </button>
      ) : null}
    </span>
  );
}

/**
 * The cursor bake, drawn as a peer of the source orbs and cells. It is not
 * a recording source (nothing is captured from it), so it has no state
 * beyond on and off, no meter and no device.
 */
export function CursorChip({
  density,
  on,
  onToggle,
  testId
}: {
  readonly density: "orb" | "cell";
  readonly on: boolean;
  readonly onToggle: () => void;
  readonly testId?: string;
}): ReactElement {
  const captionId = useId();
  const glyph = (
    <svg
      className="ps-chip__ico"
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.4 2.2l9.2 5.6-4.1 1.1-1.9 3.9z" />
    </svg>
  );
  return (
    <span
      className={`ps-chip ps-chip--${density}`}
      data-state={on ? "live" : "off"}
      data-source="cursor"
      {...(testId !== undefined ? { "data-testid": `${testId}-chip` } : {})}
    >
      <button
        type="button"
        className="ps-chip__body"
        aria-pressed={on}
        aria-label={`Record cursor: ${on ? "on" : "off"}`}
        aria-describedby={captionId}
        aria-keyshortcuts="C"
        data-tip="Bake the pointer into the recording"
        data-tip-keys="C"
        {...(testId !== undefined ? { "data-testid": testId } : {})}
        onClick={onToggle}
      >
        {density === "orb" ? (
          <span className="ps-orb">{glyph}</span>
        ) : (
          <>
            <span className="ps-cell__eye">CURSOR</span>
            <span className="ps-cell__vis">{on ? glyph : <span className="ps-cell__off">OFF</span>}</span>
          </>
        )}
      </button>
      <span className="ps-chip__cap" id={captionId}>
        {density === "orb" ? "Cursor" : on ? "Shown" : "Hidden"}
      </span>
    </span>
  );
}
