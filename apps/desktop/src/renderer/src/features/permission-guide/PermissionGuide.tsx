// The macOS permission guide panel (main: capture/permission-guide.ts).
//
// Sits beside System Settings → Screen & System Audio Recording and holds
// the running app bundle as a native file drag. Main owns every decision —
// where the window goes, which bundle is dragged, when the grant landed —
// and this renderer only draws the state it is sent and reports its height.
//
// Sizing follows the tray / float-over pattern (AGENTS.md "Tray + float-over
// popover sizing"): measure an inline-block wrapper outside the styled card,
// never the card itself.
//
// The window is non-activating, so nothing here takes keyboard focus and
// System Settings stays the active app while the user drags into it.

import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { EVENT_CHANNELS, type PermissionGuideState } from "@pwrsnap/shared";
import { dispatch, subscribe } from "../../lib/pwrsnap";
import { PwrSnapMark } from "../shared/BrandMark";

/** How long the handle reads as "lifted" after a drag starts. A drag handed
 *  to the OS fires no dragend in the page, so this is a timer, not an event. */
const LIFTED_MS = 4_000;

type Step = { key: string; body: ReactElement };

function steps(appName: string): Step[] {
  return [
    { key: "drag", body: <>Drag <b>{appName}</b> into the list on the left.</> },
    { key: "confirm", body: <>Confirm with Touch ID or your password. Make sure its switch is on.</> },
    { key: "relaunch", body: <>Relaunch {appName} from this panel.</> }
  ];
}

export function PermissionGuide(): ReactElement | null {
  const [state, setState] = useState<PermissionGuideState | null>(null);
  const [lifted, setLifted] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const liftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Subscribe, THEN ask: main may have published before this mounted.
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = subscribe(EVENT_CHANNELS.permissionGuideState, (payload) => {
      setState(payload as PermissionGuideState);
    });
    void dispatch("permissions:guideState", {}).then((res) => {
      if (!cancelled && res.ok && res.value !== null) {
        setState((current) => current ?? res.value);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => () => {
    if (liftTimer.current !== null) clearTimeout(liftTimer.current);
  }, []);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (el === null) return;
    let posted = -1;
    const post = (): void => {
      const height = Math.ceil(el.getBoundingClientRect().height);
      if (height === posted || height === 0) return;
      posted = height;
      void dispatch("permissions:guideResize", { height });
    };
    post();
    const ro = new ResizeObserver(post);
    ro.observe(el);
    return () => ro.disconnect();
  }, [state === null]);

  if (state === null) return null;

  const startDrag = (event: React.DragEvent<HTMLDivElement>): void => {
    // Hand the drag to the OS: main calls startDrag with the bundle path.
    event.preventDefault();
    window.pwrsnapApi?.startPermissionGuideDrag();
    setLifted(true);
    if (liftTimer.current !== null) clearTimeout(liftTimer.current);
    liftTimer.current = setTimeout(() => setLifted(false), LIFTED_MS);
  };

  const { phase, notch } = state;
  const lede =
    phase === "granted"
      ? "Allowed. Relaunch to start capturing."
      : phase === "settings-closed"
      ? "System Settings closed before PwrSnap was added."
      : lifted
      ? "Drop it in the list on the left."
      : `Drag ${state.appName} into the list to allow screen recording.`;

  return (
    <div className="pgd-wrap" ref={wrapRef}>
      <div
        className="pgd"
        data-phase={phase}
        data-notch={notch?.side ?? "none"}
        style={notch === null ? undefined : ({ "--pgd-notch-y": `${notch.y}px` } as React.CSSProperties)}
      >
        <div className="pgd__hd">
          <PwrSnapMark size={14} decorative />
          <span className="pgd__eyebrow">Screen Recording</span>
          <button
            type="button"
            className="pgd__x"
            aria-label="Close"
            data-tip="Close"
            onClick={() => void dispatch("permissions:guideClose", {})}
          >
            ✕
          </button>
        </div>
        <p className="pgd__lede">{lede}</p>

        {phase === "granted" ? null : (
          <div
            className={"pgd__handle" + (lifted ? " is-lifted" : "")}
            draggable
            onDragStart={startDrag}
            aria-label={`Drag ${state.appName} into the System Settings list`}
          >
            {state.appIconDataUrl === null ? (
              <span className="pgd__icon pgd__icon--empty" />
            ) : (
              <img className="pgd__icon" src={state.appIconDataUrl} alt="" draggable={false} />
            )}
            <span className="pgd__meta">
              <b>{state.appName}</b>
              <code title={state.appPath}>{state.appPath}</code>
            </span>
          </div>
        )}

        {state.otherCopies.length > 0 && phase !== "granted" ? (
          <div className="pgd__note is-warn">
            <b>
              {state.otherCopies.length === 1
                ? `Another ${state.appName} is on this Mac:`
                : `${state.otherCopies.length} other copies of ${state.appName} are on this Mac:`}
            </b>
            {state.otherCopies.slice(0, 3).map((p) => (
              <code key={p} title={p}>{p}</code>
            ))}
            The list names every copy “{state.appName}”. Drag this one in. If one is already listed and
            capture still fails, select it, remove it with −, then drag again. Relaunch from here
            rather than macOS's Quit &amp; Reopen, which can open the other copy.
          </div>
        ) : null}

        {!state.packaged && phase !== "granted" ? (
          <div className="pgd__note">
            <b>Development build.</b> When it is launched from a terminal, macOS checks the
            terminal's Screen Recording grant instead of this app's.
          </div>
        ) : null}

        {phase === "granted" ? (
          <div className="pgd__note is-ok">
            <b>Screen Recording is on.</b> macOS applies it the next time {state.appName} starts, so
            relaunch before you capture.
          </div>
        ) : (
          <>
            <ol className="pgd__steps">
              {steps(state.appName).map((s, i) => (
                <li key={s.key} className={i === 0 ? "is-now" : undefined}>
                  <i>{i + 1}</i>
                  <span>{s.body}</span>
                </li>
              ))}
            </ol>
            <p className="pgd__fine">{state.appName} only records the screen when you start a capture.</p>
          </>
        )}

        <div className="pgd__ft">
          {phase === "granted" ? (
            <span className="pgd__st is-ok"><span className="pgd__dot" />Granted</span>
          ) : phase === "settings-closed" ? (
            <span className="pgd__st">Not added yet</span>
          ) : (
            <span className="pgd__st"><span className="pgd__dot" />Waiting for the switch…</span>
          )}
          {phase === "settings-closed" ? (
            <button
              type="button"
              className="pgd__btn is-pri"
              onClick={() => void dispatch("permissions:guideReopenSettings", {})}
            >
              Open System Settings
            </button>
          ) : null}
          {phase === "settings-closed" ? null : (
            <button
              type="button"
              className={"pgd__btn " + (phase === "granted" ? "is-pri" : "is-ghost")}
              onClick={() => void dispatch("permissions:guideRelaunch", {})}
            >
              Relaunch {state.appName}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
