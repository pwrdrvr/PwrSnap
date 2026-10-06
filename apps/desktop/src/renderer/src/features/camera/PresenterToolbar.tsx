// The presenter's object toolbar — rides just above the selected presenter
// on the stage, the way a selected annotation's property bar does in the
// editor. Every field of `AvatarStyle` a person changes is here or on the
// object itself (drag = position, corner handles = size); there is no
// settings form.
//
//   eye │ Look: Cut out ◯ ▢ ▭ │ Framing ▾  mirror  snap ▾ │ SYNC ‹ +0.13 s › │ ⋯

import {
  useEffect,
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
  | { type: "reset" }
  | { type: "inherit" };

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
  menuSide,
  onAction
}: {
  readonly style: AvatarStyle;
  readonly geometry: PresenterGeometry;
  /** One camera frame, drawn behind each framing preview. */
  readonly posterUrl?: string | undefined;
  /** A reel scene with its own presenter can go back to the recording's. */
  readonly inheritable?: boolean;
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
                Use the recording’s presenter
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

function ToolbarMenu({
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
  readonly children: (close: () => void) => ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const close = (): void => setOpen(false);
  useDismissable({ open, onDismiss: close, surfaceRef: menuRef, triggerRef });
  useMenuNavigation({ open, menuRef, onClose: close, returnFocusRef: triggerRef });
  useOutsidePointer(open, rootRef, close);
  const align = useMenuAlign(open, rootRef, menuRef);
  return (
    <span className="pres-menuwrap" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClass + (open ? " is-open" : "")}
        aria-label={label}
        aria-haspopup="menu"
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
          role="menu"
          aria-label={label}
          tabIndex={-1}
          onBlur={closeWhenFocusLeaves(close)}
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
