// The presenter's object toolbar — rides just above the selected presenter
// on the stage, the way a selected annotation's property bar does in the
// editor. Every field of `AvatarStyle` a person changes is here or on the
// object itself (drag = position, corner handles = size); there is no
// settings form.
//
//   [This piece | All] │ eye │ Look: Cut out ◯ ▢ ▭  edge ▾ │ Framing ▾  mirror  snap ▾ │ SYNC ‹ +0.13 s › │ ⋯
//
// The scope switch shows once the clip has pieces (splits) or a piece has
// its own presenter; Edge shows for a cut-out only.

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject
} from "react";
import {
  acceleratorToDisplayKeys,
  formatSyncOffset,
  framingCrop,
  presenterAnchor,
  presenterEdge,
  presenterFraming,
  presenterLook,
  presenterSize,
  type AvatarStyle,
  type PresenterAnchor,
  type PresenterFraming,
  type PresenterGeometry,
  type PresenterLook,
  type PresenterSize
} from "@pwrsnap/shared";
import { rendererShortcutPlatform } from "../../lib/shortcut-platform";
import { useDismissable } from "../../lib/useDismissable";
import { useMenuNavigation } from "../../lib/useMenuNavigation";
import { closeWhenFocusLeaves } from "../shared/close-when-focus-leaves";
import { PresenterIcon } from "./PresenterIcons";

export type PresenterAction =
  | { type: "toggleVisible" }
  | { type: "look"; look: PresenterLook }
  | { type: "framing"; framing: PresenterFraming }
  | { type: "mirror" }
  | { type: "place"; anchor: PresenterAnchor }
  | { type: "size"; size: PresenterSize }
  | { type: "sync"; frames: number }
  | { type: "edge"; edge: number }
  | { type: "reset" }
  | { type: "inherit" };

export type PresenterScopeControl = {
  readonly value: "piece" | "all";
  readonly onChange: (scope: "piece" | "all") => void;
};

const LOOKS: ReadonlyArray<{ look: PresenterLook; label: string; icon: "person" | "circle" | "rounded" | "square" }> = [
  { look: "cut", label: "Cut out", icon: "person" },
  { look: "circle", label: "Circle", icon: "circle" },
  { look: "rounded", label: "Rounded", icon: "rounded" },
  { look: "square", label: "Square", icon: "square" }
];

const FRAMINGS: ReadonlyArray<{ framing: PresenterFraming; label: string }> = [
  { framing: "face", label: "Face" },
  { framing: "upper", label: "Upper body" },
  { framing: "full", label: "Whole camera" }
];

const SIZES: ReadonlyArray<{ size: PresenterSize; label: string; pct: string }> = [
  { size: "small", label: "Small", pct: "16%" },
  { size: "medium", label: "Medium", pct: "24%" },
  { size: "large", label: "Large", pct: "34%" }
];

const ANCHORS: ReadonlyArray<PresenterAnchor> = (["top", "middle", "bottom"] as const).flatMap((v) =>
  (["left", "center", "right"] as const).map((h) => ({ h, v }))
);

const ANCHOR_LABEL = (a: PresenterAnchor): string =>
  a.v === "middle" && a.h === "center"
    ? "Centre"
    : `${a.v === "middle" ? "Middle" : a.v === "top" ? "Top" : "Bottom"} ${a.h === "center" ? "centre" : a.h}`;

/** "⌥← ⌥→" on macOS, "Alt+← Alt+→" elsewhere. */
export function syncNudgeKeys(): string {
  const platform = rendererShortcutPlatform();
  const alt = acceleratorToDisplayKeys("Alt", platform)[0] ?? "Alt";
  const join = platform === "darwin" ? "" : "+";
  return `${alt}${join}← ${alt}${join}→`;
}

export function PresenterToolbar({
  style,
  geometry,
  posterUrl,
  inheritable = false,
  inheritLabel = "Use the recording’s presenter",
  scope,
  menuSide,
  onAction
}: {
  readonly style: AvatarStyle;
  readonly geometry: PresenterGeometry;
  /** One camera frame, drawn behind each framing preview. */
  readonly posterUrl?: string | undefined;
  /** A reel scene with its own presenter can go back to the recording's. */
  readonly inheritable?: boolean;
  readonly inheritLabel?: string;
  /** Present once the clip has pieces: what the next edit changes. */
  readonly scope?: PresenterScopeControl | undefined;
  readonly menuSide: "up" | "down";
  readonly onAction: (action: PresenterAction) => void;
}): ReactElement {
  const look = presenterLook(style);
  const framing = presenterFraming(style, geometry.cameraAspect);
  const size = presenterSize(style);
  const anchor = presenterAnchor(style, geometry);
  const sync = style.syncOffsetSec ?? 0;
  return (
    <div
      className="pres-bar"
      role="toolbar"
      aria-label="Presenter"
      data-presenter-ui=""
      data-testid="presenter-toolbar"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {scope !== undefined ? (
        <>
          <span
            className="pres-seg pres-seg--scope"
            role="radiogroup"
            aria-label="Change"
            data-testid="presenter-scope"
          >
            {(
              [
                { value: "piece", label: "This piece", tip: "Changes apply to the piece under the playhead" },
                { value: "all", label: "All", tip: "Changes apply to every piece" }
              ] as const
            ).map((entry) => (
              <button
                key={entry.value}
                type="button"
                role="radio"
                aria-checked={scope.value === entry.value}
                className={scope.value === entry.value ? "is-on" : undefined}
                data-tip={entry.tip}
                onClick={() => scope.onChange(entry.value)}
                data-testid={`presenter-scope-${entry.value}`}
              >
                {entry.label}
              </button>
            ))}
          </span>
          <span className="pres-bar__sep" aria-hidden="true" />
        </>
      ) : null}
      <button
        type="button"
        className="pres-ib"
        aria-label="Hide presenter"
        data-tip="Hide presenter"
        data-tip-keys="H"
        onClick={() => onAction({ type: "toggleVisible" })}
        data-testid="presenter-hide"
      >
        <PresenterIcon name="eye" />
      </button>
      <span className="pres-bar__sep" aria-hidden="true" />
      <span className="pres-seg" role="radiogroup" aria-label="Look">
        {LOOKS.map((entry) => (
          <button
            key={entry.look}
            type="button"
            role="radio"
            aria-checked={look === entry.look}
            aria-label={entry.label}
            className={look === entry.look ? "is-on" : undefined}
            {...(entry.look === "cut" ? {} : { "data-tip": entry.label })}
            onClick={() => onAction({ type: "look", look: entry.look })}
            data-testid={`presenter-look-${entry.look}`}
          >
            <PresenterIcon name={entry.icon} />
            {entry.look === "cut" ? <span>Cut out</span> : null}
          </button>
        ))}
      </span>
      {look === "cut" ? (
        <ToolbarMenu
          kind="dialog"
          label="Edge"
          side={menuSide}
          trigger={<PresenterIcon name="edge" />}
          triggerClass="pres-ib"
          tip="Edge"
          testId="presenter-edge"
        >
          {() => <EdgeControl edge={presenterEdge(style)} onChange={(edge) => onAction({ type: "edge", edge })} />}
        </ToolbarMenu>
      ) : null}
      <span className="pres-bar__sep" aria-hidden="true" />
      <ToolbarMenu
        label="Framing"
        side={menuSide}
        trigger={
          <>
            <span>{FRAMINGS.find((f) => f.framing === framing)?.label ?? "Custom"}</span>
            <PresenterIcon name="chevronDown" />
          </>
        }
        triggerClass="pres-pick"
        testId="presenter-framing"
      >
        {(close) => (
          <>
            <div className="pres-menu__hd" aria-hidden="true">
              Framing
            </div>
            {FRAMINGS.map((entry) => {
              const crop = framingCrop(entry.framing, geometry.cameraAspect, look);
              return (
                <button
                  key={entry.framing}
                  type="button"
                  role="menuitemradio"
                  aria-checked={framing === entry.framing}
                  tabIndex={-1}
                  className="pres-menu__row pres-menu__row--tall"
                  onClick={() => {
                    close();
                    onAction({ type: "framing", framing: entry.framing });
                  }}
                >
                  <span className="pres-menu__tick">
                    {framing === entry.framing ? <PresenterIcon name="tick" /> : null}
                  </span>
                  <span
                    className="pres-crop"
                    style={{
                      aspectRatio: String(geometry.cameraAspect),
                      ...(posterUrl !== undefined ? { backgroundImage: `url(${posterUrl})` } : {})
                    }}
                    aria-hidden="true"
                  >
                    <i
                      style={{
                        left: `${crop.x * 100}%`,
                        top: `${crop.y * 100}%`,
                        width: `${crop.width * 100}%`,
                        height: `${crop.height * 100}%`,
                        borderRadius: look === "circle" ? "50%" : undefined
                      }}
                    />
                  </span>
                  {entry.label}
                </button>
              );
            })}
          </>
        )}
      </ToolbarMenu>
      <button
        type="button"
        className={"pres-ib" + (style.mirror ? " is-on" : "")}
        aria-label="Mirror"
        aria-pressed={style.mirror}
        data-tip="Mirror"
        data-tip-detail="Off, the export shows what the camera saw"
        onClick={() => onAction({ type: "mirror" })}
        data-testid="presenter-mirror"
      >
        <PresenterIcon name="mirror" />
      </button>
      <ToolbarMenu
        label="Position and size"
        side={menuSide}
        trigger={<PresenterIcon name="snap" />}
        triggerClass="pres-ib"
        tip="Position and size"
        testId="presenter-place"
      >
        {(close) => (
          <>
            <div className="pres-menu__hd" aria-hidden="true">
              Snap to
            </div>
            <div className="pres-grid9">
              {ANCHORS.map((a) => {
                const on = a.h === anchor.h && a.v === anchor.v;
                return (
                  <button
                    key={`${a.v}-${a.h}`}
                    type="button"
                    role="menuitemradio"
                    aria-checked={on}
                    aria-label={ANCHOR_LABEL(a)}
                    tabIndex={-1}
                    className={on ? "is-on" : undefined}
                    data-h={a.h}
                    data-v={a.v}
                    onClick={() => {
                      close();
                      onAction({ type: "place", anchor: a });
                    }}
                  />
                );
              })}
            </div>
            <div className="pres-menu__sep" aria-hidden="true" />
            {SIZES.map((entry) => (
              <button
                key={entry.size}
                type="button"
                role="menuitemradio"
                aria-checked={size === entry.size}
                tabIndex={-1}
                className="pres-menu__row"
                onClick={() => {
                  close();
                  onAction({ type: "size", size: entry.size });
                }}
              >
                <span className="pres-menu__tick">
                  {size === entry.size ? <PresenterIcon name="tick" /> : null}
                </span>
                {entry.label}
                <em>{entry.pct}</em>
              </button>
            ))}
          </>
        )}
      </ToolbarMenu>
      <span className="pres-bar__sep" aria-hidden="true" />
      <span
        className="pres-sync"
        role="group"
        aria-label="Camera sync"
        data-tip="Camera sync"
        data-tip-keys={syncNudgeKeys()}
        data-tip-detail="One frame earlier or later. Or drag the camera lane."
      >
        <span className="pres-sync__lbl" aria-hidden="true">
          SYNC
        </span>
        <button
          type="button"
          aria-label="Camera one frame earlier"
          onClick={() => onAction({ type: "sync", frames: -1 })}
          data-testid="presenter-sync-earlier"
        >
          <PresenterIcon name="left" />
        </button>
        <b aria-live="polite" data-testid="presenter-sync-value">
          {formatSyncOffset(sync)}
        </b>
        <button
          type="button"
          aria-label="Camera one frame later"
          onClick={() => onAction({ type: "sync", frames: 1 })}
          data-testid="presenter-sync-later"
        >
          <PresenterIcon name="right" />
        </button>
      </span>
      <ToolbarMenu
        label="More presenter options"
        side={menuSide}
        trigger={<PresenterIcon name="more" />}
        triggerClass="pres-ib"
        tip="More"
        testId="presenter-more"
      >
        {(close) => (
          <>
            {inheritable ? (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="pres-menu__row"
                onClick={() => {
                  close();
                  onAction({ type: "inherit" });
                }}
              >
                <span className="pres-menu__tick" />
                {inheritLabel}
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="pres-menu__row"
              onClick={() => {
                close();
                onAction({ type: "reset" });
              }}
            >
              <span className="pres-menu__tick" />
              Reset presenter
            </button>
          </>
        )}
      </ToolbarMenu>
    </div>
  );
}

/**
 * How hard the cut-out trims its edge. Soft keeps the model's whole
 * confidence ramp (hair, but a halo where the light or the angle fools
 * it); tight cuts close to the person.
 */
export function EdgeControl({
  edge,
  onChange
}: {
  readonly edge: number;
  readonly onChange: (edge: number) => void;
}): ReactElement {
  const id = useId();
  return (
    <div className="pres-edge">
      <label className="pres-edge__hd" htmlFor={id}>
        Edge
      </label>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        step={5}
        value={Math.round(edge * 100)}
        aria-valuetext={edge < 0.2 ? "Soft" : edge > 0.8 ? "Tight" : `${Math.round(edge * 100)}%`}
        onChange={(e) => onChange(Number(e.currentTarget.value) / 100)}
        data-testid="presenter-edge-range"
      />
      <div className="pres-edge__ends" aria-hidden="true">
        <span>Soft</span>
        <span>Tight</span>
      </div>
      <p className="pres-edge__note">Tighter removes a halo around hair or a hat.</p>
    </div>
  );
}

function ToolbarMenu({
  kind = "menu",
  label,
  side,
  trigger,
  triggerClass,
  tip,
  testId,
  children
}: {
  readonly label: string;
  readonly side: "up" | "down";
  readonly trigger: ReactNode;
  readonly triggerClass: string;
  readonly tip?: string;
  readonly testId: string;
  /** A `dialog` holds controls (a slider) that need the arrow keys. */
  readonly kind?: "menu" | "dialog";
  readonly children: (close: () => void) => ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const close = (): void => setOpen(false);
  useDismissable({ open, onDismiss: close, surfaceRef: menuRef, triggerRef, dismissOnFocusLeave: kind === "dialog" });
  useMenuNavigation({ open: open && kind === "menu", menuRef, onClose: close, returnFocusRef: triggerRef });
  useEffect(() => {
    if (open && kind === "dialog") menuRef.current?.querySelector<HTMLElement>("input, button")?.focus();
  }, [open, kind]);
  useOutsidePointer(open, rootRef, close);
  const align = useMenuAlign(open, rootRef, menuRef);
  return (
    <span className="pres-menuwrap" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClass + (open ? " is-open" : "")}
        aria-label={label}
        aria-haspopup={kind}
        aria-expanded={open}
        {...(tip !== undefined ? { "data-tip": tip } : {})}
        onClick={() => setOpen((v) => !v)}
        data-testid={testId}
      >
        {trigger}
      </button>
      {open ? (
        <div
          ref={menuRef}
          className={`pres-menu is-${side} is-${align}`}
          role={kind}
          aria-label={label}
          tabIndex={-1}
          {...(kind === "menu" ? { onBlur: closeWhenFocusLeaves(close) } : {})}
          data-testid={`${testId}-menu`}
        >
          {children(close)}
        </div>
      ) : null}
    </span>
  );
}

function useOutsidePointer(
  open: boolean,
  rootRef: RefObject<HTMLElement | null>,
  onOutside: () => void
): void {
  const cb = useRef(onOutside);
  cb.current = onOutside;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      const root = rootRef.current;
      if (root !== null && e.target instanceof Node && root.contains(e.target)) return;
      cb.current();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open, rootRef]);
}

/** Open the menu leftward when it would run past the stage's right edge. */
function useMenuAlign(
  open: boolean,
  rootRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLElement | null>
): "start" | "end" {
  const [align, setAlign] = useState<"start" | "end">("start");
  useLayoutEffect(() => {
    if (!open) {
      setAlign("start");
      return;
    }
    const root = rootRef.current;
    const menu = menuRef.current;
    const bounds = root?.closest<HTMLElement>("[data-presenter-bounds]");
    if (!root || !menu || !bounds) return;
    const right = root.getBoundingClientRect().left + menu.offsetWidth;
    setAlign(right > bounds.getBoundingClientRect().right - 4 ? "end" : "start");
  }, [open, rootRef, menuRef]);
  return align;
}
