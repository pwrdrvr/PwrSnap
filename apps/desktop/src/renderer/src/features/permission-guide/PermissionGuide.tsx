// The macOS permission guide panel (main: capture/permission-guide.ts).
// Design: Claude Design → PwrSnap → "PwrSnap Permission Guide v2.html".
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
// System Settings stays the active app while the user drags into it. That is
// also why Reset confirms inline: there is no dialog to raise.

import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { EVENT_CHANNELS, type PermissionGuideState } from "@pwrsnap/shared";
import { dispatch, subscribe } from "../../lib/pwrsnap";
import { PwrSnapMark } from "../shared/BrandMark";

/** How long the handle reads as "lifted" after a drag starts. A drag handed
 *  to the OS fires no dragend in the page, so this is a timer, not an event. */
const LIFTED_MS = 4_000;
/** The drag hint plays this many loops when the panel opens, then stops. */
const HINT_LOOPS_ON_OPEN = 3;
/** How long a button that finished says so before it goes back. */
const DONE_MS = 1_500;

type Step = { key: string; body: ReactElement };

function steps(appName: string): Step[] {
  return [
    { key: "drag", body: <>Drag <b>{appName}</b> into the list on the left.</> },
    { key: "confirm", body: <>Confirm with Touch ID or your password. Make sure its switch is on.</> },
    { key: "relaunch", body: <>Relaunch {appName} from this panel.</> }
  ];
}

type ShowListUi = "idle" | "busy" | "done";
type ResetUi = "idle" | "confirm" | "busy";

export function PermissionGuide(): ReactElement | null {
  const [state, setState] = useState<PermissionGuideState | null>(null);
  const [lifted, setLifted] = useState(false);
  // Loops left to play, and a key that restarts the animation on replay.
  const [hint, setHint] = useState({ loops: HINT_LOOPS_ON_OPEN, run: 0 });
  const [hintDone, setHintDone] = useState(false);
  const [showList, setShowList] = useState<ShowListUi>("idle");
  const [resetUi, setResetUi] = useState<ResetUi>("idle");
  const [relaunching, setRelaunching] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const liftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    if (doneTimer.current !== null) clearTimeout(doneTimer.current);
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
    // A real drag ends the demonstration for good.
    setHint((h) => ({ ...h, loops: 0 }));
    setHintDone(true);
    setLifted(true);
    if (liftTimer.current !== null) clearTimeout(liftTimer.current);
    liftTimer.current = setTimeout(() => setLifted(false), LIFTED_MS);
  };

  const replayHint = (): void => {
    if (hintDone || lifted || hint.loops > 0) return;
    setHint((h) => ({ loops: 1, run: h.run + 1 }));
  };

  const onShowList = async (): Promise<void> => {
    if (showList === "busy") return;
    setShowList("busy");
    const res = await dispatch("permissions:guideReopenSettings", {});
    if (!res.ok) {
      setShowList("idle");
      return;
    }
    setShowList("done");
    if (doneTimer.current !== null) clearTimeout(doneTimer.current);
    doneTimer.current = setTimeout(() => setShowList("idle"), DONE_MS);
  };

  const onRemove = async (): Promise<void> => {
    setResetUi("busy");
    // Main publishes the outcome (state.reset); this only ends the busy state.
    await dispatch("permissions:guideResetGrant", {});
    setResetUi("idle");
  };

  const onRelaunch = (): void => {
    setRelaunching(true);
    void dispatch("permissions:guideRelaunch", {});
  };

  const { phase, notch, appName } = state;
  const granted = phase === "granted";
  const hinting = hint.loops > 0 && !lifted && !granted;
  const lede = granted
    ? "Allowed. Relaunch to start capturing."
    : phase === "settings-closed"
    ? `System Settings closed before ${appName} was added.`
    : lifted
    ? "Drop it in the list on the left."
    : state.reset === "done"
    ? `Old entry removed. Drag ${appName} in again.`
    : `Drag ${appName} into the list to allow screen recording.`;

  const cardStyle: Record<string, string> = { "--pgd-hint-loops": String(hint.loops) };
  if (notch !== null) cardStyle["--pgd-notch-y"] = `${notch.y}px`;

  return (
    <div className="pgd-wrap" ref={wrapRef}>
      <div
        className={"pgd" + (hinting ? " is-hinting" : "")}
        data-phase={phase}
        data-notch={notch?.side ?? "none"}
        style={cardStyle as React.CSSProperties}
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

        {granted ? null : (
          <div
            className={"pgd__handle" + (lifted ? " is-lifted" : "")}
            draggable
            onDragStart={startDrag}
            onMouseEnter={replayHint}
            aria-label={`Drag ${appName} into the System Settings list`}
          >
            {state.appIconDataUrl === null ? (
              <span className="pgd__icon pgd__icon--empty" />
            ) : (
              <img className="pgd__icon" src={state.appIconDataUrl} alt="" draggable={false} />
            )}
            <span className="pgd__meta">
              <b>{appName}</b>
              <code title={state.appPath}>{state.appPath}</code>
            </span>
            {hinting && state.appIconDataUrl !== null ? (
              <span
                key={hint.run}
                className="pgd__ghost"
                aria-hidden="true"
                onAnimationEnd={() => setHint((h) => ({ ...h, loops: 0 }))}
              >
                <img src={state.appIconDataUrl} alt="" draggable={false} />
                <span className="pgd__cursor" />
              </span>
            ) : null}
          </div>
        )}

        {state.reset === "done" && !granted ? (
          <div className="pgd__note is-ok">
            <b>Reset.</b> {appName} is out of the list. The handle above is this copy.
          </div>
        ) : state.reset === "failed" && !granted ? (
          <div className="pgd__note is-warn">
            <b>Couldn't reset the entry.</b> Select {appName} in the list, remove it with −, then
            drag it in again.
          </div>
        ) : null}

        {state.otherCopies.length > 0 && !granted ? (
          <div className="pgd__note is-warn">
            <b>
              {state.otherCopies.length === 1
                ? `Another ${appName} is on this Mac:`
                : `${state.otherCopies.length} other copies of ${appName} are on this Mac:`}
            </b>
            {state.otherCopies.slice(0, 3).map((p) => (
              <code key={p} title={p}>{p}</code>
            ))}
            The list names every copy “{appName}”. Drag this one in, and relaunch from here rather
            than macOS's Quit &amp; Reopen, which can open the other copy.
          </div>
        ) : null}

        {!state.packaged && !granted ? (
          <div className="pgd__note">
            <b>Development build.</b> When it is launched from a terminal, macOS checks the
            terminal's Screen Recording grant instead of this app's.
          </div>
        ) : null}

        {granted ? (
          <div className="pgd__note is-ok">
            <b>Screen Recording is on.</b> macOS applies it the next time {appName} starts, so
            relaunch before you capture.
          </div>
        ) : (
          <>
            <ol className="pgd__steps">
              {steps(appName).map((s, i) => (
                <li key={s.key} className={i === 0 ? "is-now" : undefined}>
                  <i>{i + 1}</i>
                  <span>{s.body}</span>
                </li>
              ))}
            </ol>
            <p className="pgd__fine">{appName} only records the screen when you start a capture.</p>
          </>
        )}

        {phase === "waiting" ? (
          <div className="pgd__fix">
            <div className="pgd__fix-hd">If it isn't working</div>
            <div className="pgd__fix-row">
              <span className="pgd__fix-txt"><b>Settings is on another page</b></span>
              <button
                type="button"
                className={"pgd__btn" + (showList === "done" ? " is-done" : "")}
                aria-busy={showList === "busy"}
                onClick={() => void onShowList()}
              >
                {showList === "busy" ? (
                  <><span className="pgd__spin" />Opening</>
                ) : showList === "done" ? (
                  "✓ Opened"
                ) : (
                  "Show list"
                )}
              </button>
            </div>
            {state.bundleId === null ? null : (
              <div className="pgd__fix-row">
                <span className="pgd__fix-txt">
                  <b>Listed, but still blocked</b>The row may belong to another copy.
                </span>
                <button
                  type="button"
                  className={"pgd__btn is-danger" + (resetUi === "idle" ? "" : " is-open")}
                  aria-expanded={resetUi !== "idle"}
                  onClick={() => setResetUi((ui) => (ui === "idle" ? "confirm" : ui === "confirm" ? "idle" : ui))}
                >
                  Reset…
                </button>
              </div>
            )}
            {resetUi === "idle" ? null : (
              <div className="pgd__confirm" role="group" aria-label="Confirm reset">
                <b>Remove {appName} from Screen Recording?</b>
                Every copy of {appName} loses the permission. Then drag this one back in.
                <div className="pgd__confirm-btns">
                  <button
                    type="button"
                    className="pgd__btn is-quiet"
                    disabled={resetUi === "busy"}
                    onClick={() => setResetUi("idle")}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="pgd__btn is-danger-solid"
                    aria-busy={resetUi === "busy"}
                    onClick={() => void onRemove()}
                  >
                    {resetUi === "busy" ? <><span className="pgd__spin" />Removing</> : "Remove"}
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : null}

        <div className="pgd__ft">
          {granted ? (
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
          ) : (
            <button
              type="button"
              className={"pgd__btn " + (granted ? "is-pri" : "is-quiet")}
              aria-busy={relaunching}
              onClick={onRelaunch}
            >
              {relaunching ? <><span className="pgd__spin" />Relaunching</> : `Relaunch ${appName}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
