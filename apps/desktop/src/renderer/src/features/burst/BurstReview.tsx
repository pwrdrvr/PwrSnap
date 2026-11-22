// Burst Review: pick which stills of a burst become snaps.
//
// A burst is a ring of stills the recorder took up to ten times a second
// while the screen changed. Stop opens this window on it. The user looks
// through the strip, chooses stills, and Keep turns exactly those into
// ordinary snaps (captured at their own time, tagged `burst`, optionally
// labelled with the time). Everything else is deleted — the stills live in
// a temp directory main owns, and they exist nowhere else.
//
// Keys (whole-window; nothing here is an overlay):
//   ← / →        previous / next still (Shift extends the choice)
//   Home / End   first / last still
//   Space        choose / unchoose the still on the stage
//   A            choose all / none
//   Cmd/Ctrl+Enter  keep the chosen stills

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { acceleratorToDisplayKeys, BURST_FPS, type BurstFrame, type BurstSessionView } from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";
import { rendererShortcutPlatform } from "../../lib/shortcut-platform";
import { paintsOwnCaptionButtons, rendererPlatform } from "../../lib/window-chrome";
import { PwrSnapMark, PwrSnapWordmark } from "../shared/BrandMark";
import { WindowControls } from "../shared/WindowControls";
import {
  formatClock,
  formatGap,
  formatOffset,
  reconcileSelection,
  selectRange,
  stampPreview,
  stillGaps,
  toggleAll,
  toggleFrame,
  type Selection
} from "./burst-review-model";
import "./BurstReview.css";

export function readBurstId(hash: string = window.location.hash): string | null {
  const id = new URLSearchParams(hash.replace(/^#/, "")).get("burst");
  return id !== null && /^[A-Za-z0-9_-]{6,32}$/.test(id) ? id : null;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "gone" }
  | { kind: "ready"; view: BurstSessionView };

type Busy = null | "keep" | "discard";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    (target instanceof HTMLInputElement && target.type !== "checkbox") ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}

/** Space / Enter on a focused control are that control's, not the window's. */
function isControlTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.closest("button, input, select, textarea, a") !== null);
}

export function BurstReview({ burstId = readBurstId() }: { readonly burstId?: string | null }): ReactElement {
  const [load, setLoad] = useState<LoadState>(burstId === null ? { kind: "gone" } : { kind: "loading" });
  const [selection, setSelection] = useState<Selection>([]);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [stamp, setStamp] = useState(true);
  // The pointer is not in the stills' pixels; this draws it on top here and
  // gives each kept snap a removable Cursor layer.
  const [withPointer, setWithPointer] = useState(true);
  const [busy, setBusy] = useState<Busy>(null);
  const [discardArmed, setDiscardArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const thumbRefs = useRef(new Map<number, HTMLElement>());

  const refresh = useCallback(async (): Promise<void> => {
    if (burstId === null) return;
    const result = await dispatch("burst:get", { burstId });
    if (!result.ok) {
      setLoad({ kind: "gone" });
      return;
    }
    setLoad({ kind: "ready", view: result.value });
  }, [burstId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const view = load.kind === "ready" ? load.view : null;
  const frames: readonly BurstFrame[] = view?.frames ?? [];
  const kept = useMemo(() => new Set(view?.keptIndexes ?? []), [view]);
  const gaps = useMemo(() => stillGaps(frames, BURST_FPS), [frames]);

  // A fresh view (first load, or after a partial keep) settles the stage on
  // the newest still — the moment the user stopped is usually just after
  // the thing they wanted — and drops choices that are no longer keepable.
  useEffect(() => {
    if (view === null) return;
    setSelection((prev) => reconcileSelection(prev, view.frames, new Set(view.keptIndexes)));
    setFocusIndex((prev) =>
      prev !== null && view.frames.some((f) => f.index === prev) ? prev : view.frames.at(-1)?.index ?? null
    );
  }, [view]);

  const focusPos = frames.findIndex((f) => f.index === focusIndex);
  const focused = focusPos >= 0 ? frames[focusPos]! : null;
  const hasPointer = useMemo(() => frames.some((f) => f.pointer !== undefined), [frames]);
  // One Set per choice: the strip asks "is this still chosen?" per thumb.
  const chosenSet = useMemo(() => new Set(selection), [selection]);
  const firstChosenOffset = useMemo(() => {
    const first = frames.find((f) => chosenSet.has(f.index));
    return first?.offsetMs ?? null;
  }, [frames, chosenSet]);

  useEffect(() => {
    if (focusIndex === null) return;
    thumbRefs.current.get(focusIndex)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [focusIndex]);

  const moveFocus = useCallback(
    (toPos: number, extend: boolean) => {
      const target = frames[Math.max(0, Math.min(frames.length - 1, toPos))];
      if (target === undefined) return;
      setFocusIndex(target.index);
      if (extend) {
        const from = anchor ?? focusIndex ?? target.index;
        setSelection((prev) => selectRange(prev, frames, from, target.index, kept));
        if (anchor === null) setAnchor(from);
      } else {
        setAnchor(target.index);
      }
    },
    [frames, anchor, focusIndex, kept]
  );

  const keep = useCallback(async (): Promise<void> => {
    if (burstId === null || busy !== null || selection.length === 0) return;
    setBusy("keep");
    setError(null);
    const result = await dispatch("burst:keep", {
      burstId,
      frameIndexes: [...selection],
      stampTime: stamp,
      pointer: withPointer
    });
    setBusy(null);
    // On success main ends the session, and the session's end closes this
    // window. Nothing to do here but wait for it.
    if (result.ok) return;
    setError(`Couldn’t keep every still — ${result.error.message}. The ones marked Kept are in your Library.`);
    await refresh();
  }, [burstId, busy, selection, stamp, withPointer, refresh]);

  const discard = useCallback(async (): Promise<void> => {
    if (burstId === null || busy !== null) return;
    if (!discardArmed) {
      setDiscardArmed(true);
      return;
    }
    setBusy("discard");
    setError(null);
    const result = await dispatch("burst:discard", { burstId });
    setBusy(null);
    setDiscardArmed(false);
    if (!result.ok) setError(`Couldn’t discard the burst — ${result.error.message}`);
  }, [burstId, busy, discardArmed]);

  // An armed Discard disarms itself if the user does anything else.
  useEffect(() => {
    if (!discardArmed) return;
    const timer = window.setTimeout(() => setDiscardArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [discardArmed]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (isTypingTarget(event.target)) return;
      const mod = event.metaKey || event.ctrlKey;
      if (event.key === "Enter" && mod) {
        event.preventDefault();
        void keep();
        return;
      }
      if (mod || event.altKey) return;
      switch (event.key) {
        case "ArrowLeft":
        case "ArrowRight": {
          event.preventDefault();
          const step = event.key === "ArrowLeft" ? -1 : 1;
          moveFocus((focusPos < 0 ? frames.length - 1 : focusPos) + step, event.shiftKey);
          return;
        }
        case "Home":
          event.preventDefault();
          moveFocus(0, event.shiftKey);
          return;
        case "End":
          event.preventDefault();
          moveFocus(frames.length - 1, event.shiftKey);
          return;
        case " ":
          if (isControlTarget(event.target) || focused === null) return;
          event.preventDefault();
          setSelection((prev) => toggleFrame(prev, focused.index, kept));
          setAnchor(focused.index);
          return;
        case "a":
        case "A":
          event.preventDefault();
          setSelection((prev) => toggleAll(prev, frames, kept));
          return;
        default:
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [frames, focusPos, focused, kept, keep, moveFocus]);

  const onThumbClick = (frame: BurstFrame, shift: boolean): void => {
    setFocusIndex(frame.index);
    if (shift) {
      const from = anchor ?? focusIndex ?? frame.index;
      setSelection((prev) => selectRange(prev, frames, from, frame.index, kept));
      return;
    }
    setAnchor(frame.index);
  };

  const onCheckClick = (frame: BurstFrame, shift: boolean): void => {
    if (shift && anchor !== null) {
      setSelection((prev) => selectRange(prev, frames, anchor, frame.index, kept));
    } else {
      setSelection((prev) => toggleFrame(prev, frame.index, kept));
      setAnchor(frame.index);
    }
    setFocusIndex(frame.index);
  };

  const keepable = frames.filter((f) => !kept.has(f.index)).length;
  const focusedChosen = focused !== null && chosenSet.has(focused.index);
  const focusedKept = focused !== null && kept.has(focused.index);
  const spanMs = frames.length > 1 ? frames.at(-1)!.offsetMs - frames[0]!.offsetMs : 0;
  // Platform words for the modifier keys (⌘ on macOS, Ctrl elsewhere).
  const platform = rendererShortcutPlatform();
  const keepKeys = acceleratorToDisplayKeys("CommandOrControl+Enter", platform).join("");
  const shiftKey = acceleratorToDisplayKeys("Shift", platform)[0] ?? "Shift";

  return (
    <div className="ps-doc ps-burst" data-testid="burst-review">
      <header className="ps-doc__titlebar">
        <div className="ps-doc__brand">
          <PwrSnapMark size={20} decorative />
          <PwrSnapWordmark />
        </div>
        <div className="ps-doc__crumb">
          <span>Burst</span>
          <span aria-hidden="true">/</span>
          <b>
            {frames.length} {frames.length === 1 ? "still" : "stills"}
            {view?.sourceAppName ? ` · ${view.sourceAppName}` : ""}
          </b>
        </div>
        {paintsOwnCaptionButtons(rendererPlatform()) ? <WindowControls /> : null}
      </header>

      {load.kind === "loading" && <main className="ps-burst__empty">Loading the burst…</main>}
      {load.kind === "gone" && (
        <main className="ps-burst__empty" role="status">
          This burst has ended. Its stills were kept or discarded.
        </main>
      )}
      {view !== null && (
        <main className="ps-burst__main">
          <section className="ps-burst__stage" aria-label="Selected still">
            {focused !== null ? (
              <>
                <div className="ps-burst__stage-box">
                  <div
                    className="ps-burst__stage-frame"
                    style={{ "--ps-burst-ar": focused.widthPx / focused.heightPx } as CSSProperties}
                  >
                    <img
                      key={`thumb-${focused.index}`}
                      className="ps-burst__stage-under"
                      src={focused.thumbUrl}
                      alt=""
                      aria-hidden="true"
                    />
                    <img
                      key={`full-${focused.index}`}
                      className="ps-burst__stage-img"
                      src={focused.url}
                      alt={`Still ${focusPos + 1} of ${frames.length}, ${formatClock(focused.capturedAt)}`}
                      data-testid="burst-stage-img"
                    />
                    {withPointer && focused.pointer !== undefined && (
                      <img
                        className="ps-burst__pointer"
                        src={focused.pointer.url}
                        alt=""
                        aria-hidden="true"
                        draggable={false}
                        data-testid="burst-stage-pointer"
                        style={{
                          left: `${focused.pointer.left * 100}%`,
                          top: `${focused.pointer.top * 100}%`,
                          width: `${focused.pointer.width * 100}%`,
                          height: `${focused.pointer.height * 100}%`
                        }}
                      />
                    )}
                  </div>
                </div>
                <div className="ps-burst__chip" data-testid="burst-stage-time">
                  <b>{formatClock(focused.capturedAt)}</b>
                  <span>{formatOffset(focused.offsetMs)}</span>
                  <span className="ps-burst__chip-n">
                    {focusPos + 1} / {frames.length}
                  </span>
                </div>
                <button
                  type="button"
                  className="ps-burst__pick"
                  data-testid="burst-stage-pick"
                  aria-pressed={focusedChosen || focusedKept}
                  disabled={focusedKept}
                  data-tip={focusedKept ? "Already kept" : focusedChosen ? "Don’t keep this still" : "Keep this still"}
                  data-tip-keys="Space"
                  onClick={() => {
                    if (focused === null) return;
                    setSelection((prev) => toggleFrame(prev, focused.index, kept));
                    setAnchor(focused.index);
                  }}
                >
                  <CheckGlyph on={focusedChosen || focusedKept} />
                  {focusedKept ? "Kept" : focusedChosen ? "Keeping" : "Keep"}
                </button>
              </>
            ) : (
              <p className="ps-burst__empty">This burst has no stills — the screen never changed.</p>
            )}
          </section>

          <div
            className="ps-burst__strip"
            role="listbox"
            aria-label="Burst stills"
            aria-multiselectable="true"
            data-testid="burst-strip"
          >
            {frames.map((frame, pos) => {
              const chosen = chosenSet.has(frame.index);
              const isKept = kept.has(frame.index);
              const gap = gaps.get(frame.index);
              return (
                <div className="ps-burst__cell" key={frame.index}>
                  <div
                    ref={(el) => {
                      if (el === null) thumbRefs.current.delete(frame.index);
                      else thumbRefs.current.set(frame.index, el);
                    }}
                    role="option"
                    aria-selected={chosen || isKept}
                    aria-current={frame.index === focusIndex ? "true" : undefined}
                    aria-label={`Still ${pos + 1}, ${formatOffset(frame.offsetMs)}${isKept ? ", kept" : chosen ? ", chosen" : ""}`}
                    className="ps-burst__thumb"
                    data-testid="burst-thumb"
                    data-index={frame.index}
                    data-chosen={chosen}
                    data-kept={isKept}
                    onClick={(e) => onThumbClick(frame, e.shiftKey)}
                  >
                    <img src={frame.thumbUrl} alt="" loading="lazy" decoding="async" draggable={false} />
                    <button
                      type="button"
                      className="ps-burst__check"
                      data-testid="burst-thumb-check"
                      tabIndex={-1}
                      aria-label={isKept ? "Already kept" : chosen ? "Don’t keep" : "Keep"}
                      disabled={isKept}
                      onClick={(e) => {
                        e.stopPropagation();
                        onCheckClick(frame, e.shiftKey);
                      }}
                    >
                      <CheckGlyph on={chosen || isKept} />
                    </button>
                    <span className="ps-burst__offset">{isKept ? "Kept" : formatOffset(frame.offsetMs)}</span>
                  </div>
                  {gap !== undefined && (
                    <div
                      className="ps-burst__gap"
                      data-testid="burst-gap"
                      data-tip={`Nothing on screen changed for ${formatGap(gap)}`}
                    >
                      <span>{formatGap(gap)}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <footer className="ps-burst__bar">
            <div className="ps-burst__summary" aria-live="polite">
              <b data-testid="burst-chosen-count">
                {selection.length} of {keepable}
              </b>{" "}
              chosen
              <span className="ps-burst__meta">
                {" · "}
                {formatGap(spanMs)} at up to {BURST_FPS}/s
                {view.evictedFrames > 0 ? ` · ${view.evictedFrames} older stills already gone` : ""}
                {view.droppedFrames > 0 ? ` · ${view.droppedFrames} skipped while busy` : ""}
              </span>
            </div>
            <label className="ps-burst__stamp" data-tip="A removable text layer — delete it in the editor to hide the time">
              <input
                type="checkbox"
                checked={stamp}
                data-testid="burst-stamp"
                onChange={(e) => setStamp(e.target.checked)}
              />
              <span>
                Label kept snaps with their time
                {stamp && focused !== null && (
                  <code data-testid="burst-stamp-preview">
                    {stampPreview(focused, firstChosenOffset ?? focused.offsetMs)}
                  </code>
                )}
              </span>
            </label>
            {hasPointer && (
              <label className="ps-burst__stamp" data-tip="A removable Cursor layer — delete it in the editor to hide the pointer">
                <input
                  type="checkbox"
                  checked={withPointer}
                  data-testid="burst-pointer"
                  onChange={(e) => setWithPointer(e.target.checked)}
                />
                <span>Pointer</span>
              </label>
            )}
            <span className="ps-burst__spacer" />
            <button
              type="button"
              className="ps-burst__btn ps-burst__btn--ghost"
              data-testid="burst-discard"
              aria-pressed={discardArmed}
              disabled={busy !== null}
              onClick={() => void discard()}
            >
              {busy === "discard"
                ? "Discarding…"
                : discardArmed
                  ? `Discard ${keepable} ${keepable === 1 ? "still" : "stills"}?`
                  : "Discard all"}
            </button>
            <button
              type="button"
              className="ps-burst__btn ps-burst__btn--primary"
              data-testid="burst-keep"
              disabled={busy !== null || selection.length === 0}
              data-tip="Keep the chosen stills as snaps and delete the rest"
              data-tip-keys={keepKeys}
              onClick={() => void keep()}
            >
              {busy === "keep"
                ? "Keeping…"
                : `Keep ${selection.length} ${selection.length === 1 ? "snap" : "snaps"}`}
            </button>
          </footer>
          {error !== null && (
            <p className="ps-burst__error" role="alert">
              {error}
            </p>
          )}
          <p className="ps-burst__keys" aria-hidden="true">
            <kbd>←</kbd>
            <kbd>→</kbd> step · <kbd>Space</kbd> keep · <kbd>{shiftKey}</kbd> range · <kbd>A</kbd> all ·{" "}
            <kbd>{keepKeys}</kbd> keep chosen
          </p>
        </main>
      )}
    </div>
  );
}

function CheckGlyph({ on }: { readonly on: boolean }): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" data-on={on}>
      <rect x="1.5" y="1.5" width="13" height="13" rx="3.5" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5" />
      {on && <path d="M4.6 8.2l2.2 2.2 4.6-4.8" fill="none" stroke="var(--bg-app)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}
