// The inspector footer's Duplicate button and its chooser.
//
// A snap with no edits copies the same either way, so the button just makes
// the copy. A snap WITH edits asks once — With Edits (naming them) or Base
// Image Only / Full Recording — pre-selected from the last answer, which it
// then remembers (`library.duplicateWithEdits`), so ⇧⌘D and File ▸
// Duplicate Snap follow it without asking. "Open the copy in the editor"
// turns the same popover into Edit a Copy.
//
// Same mechanics as DeleteConfirm, and for the same reasons: portaled and
// fixed-positioned against the trigger (the rail is an overflow:hidden
// chain), focus trapped while open, Escape and outside clicks dismiss, and
// focus goes back to the trigger.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement
} from "react";
import { createPortal } from "react-dom";
import {
  formatCaptureEditSummary,
  type CaptureEditSummary,
  type CaptureRecord,
  type LibraryDuplicateWithEditsSettings
} from "@pwrsnap/shared";

import { useDismissable } from "../../lib/useDismissable";
import { useDuplicateJobForSource } from "./DuplicateProgress";
import { useFocusTrap } from "../../lib/useFocusTrap";
import "../shared/DeleteConfirm.css";
import {
  captureEditSummaryFor,
  duplicateChoiceLabels,
  duplicateShortcutLabel,
  type DuplicateMode
} from "./useCaptureDuplicate";

const GAP = 8;
const MARGIN = 8;

export type DuplicateRequest = {
  withEdits: boolean;
  mode: DuplicateMode;
  remember: boolean;
};

export function DuplicateChooser({
  record,
  prefs,
  onDuplicate
}: {
  record: CaptureRecord;
  prefs: LibraryDuplicateWithEditsSettings;
  onDuplicate: (record: CaptureRecord, request: DuplicateRequest) => void;
}): ReactElement {
  const kind = record.kind === "video" ? "video" : "image";
  const labels = duplicateChoiceLabels(record.kind);
  const [summary, setSummary] = useState<CaptureEditSummary | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // A background copy of this recording is still running: one at a time.
  const copying = useDuplicateJobForSource(record.id) !== null;
  const [withEdits, setWithEdits] = useState(prefs[kind]);
  const [openCopy, setOpenCopy] = useState(false);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setCoords(null);
  }, []);

  // A different snap selected under an open chooser: the question was about
  // the other one.
  useEffect(() => close(), [record.id, close]);
  useEffect(() => {
    if (copying) close();
  }, [copying, close]);

  const onTrigger = useCallback(async () => {
    if (copying) return;
    if (open) {
      close();
      return;
    }
    setBusy(true);
    const next = await captureEditSummaryFor(record);
    setBusy(false);
    if (next !== null && !next.hasEdits) {
      onDuplicate(record, { withEdits: true, mode: "duplicate", remember: false });
      return;
    }
    setSummary(next);
    setWithEdits(prefs[kind]);
    setOpenCopy(false);
    setOpen(true);
  }, [copying, open, close, record, onDuplicate, prefs, kind]);

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const pop = popoverRef.current;
    if (anchor === null || pop === null) return;
    const a = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    let left = a.left + a.width / 2 - w / 2;
    let top = a.top - GAP - h;
    if (top < MARGIN) top = a.bottom + GAP;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - w - MARGIN));
    top = Math.max(MARGIN, Math.min(top, window.innerHeight - h - MARGIN));
    setCoords({ left, top });
  }, [open]);

  useFocusTrap({
    open: open && coords !== null,
    containerRef: popoverRef,
    initialFocusRef: confirmRef,
    returnFocusRef: anchorRef,
    preventScroll: true
  });
  useDismissable({ open, onDismiss: close, surfaceRef: popoverRef });

  useEffect(() => {
    if (!open) return;
    const outside = (target: EventTarget | null): boolean =>
      !(target instanceof Node && popoverRef.current?.contains(target) === true);
    const onPointerDown = (event: PointerEvent): void => {
      if (outside(event.target) && !anchorRef.current?.contains(event.target as Node)) close();
    };
    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target;
      if (!outside(target)) return;
      if (target instanceof Element && target.closest('[aria-modal="true"]') !== null) return;
      close();
    };
    const onScrollOrResize = (): void => close();
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open, close]);

  const hint = summary === null ? null : formatCaptureEditSummary(summary);
  const name = `ps-duplicate-${record.id}`;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        title={copying ? "Copying this recording…" : `Duplicate (${duplicateShortcutLabel()})`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-busy={busy || copying}
        // Not `disabled`: confirming the chooser returns focus to this
        // button just as its copy starts, and a disabled button would
        // drop that focus to <body>.
        aria-disabled={copying || undefined}
        onClick={() => void onTrigger()}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="8" y="8" width="13" height="13" rx="2" />
          <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
        </svg>
        Duplicate
      </button>
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            className="ps-confirm ps-confirm--top ps-duplicate"
            role="dialog"
            aria-modal="true"
            aria-label="Duplicate snap"
            tabIndex={-1}
            style={{
              left: coords?.left ?? 0,
              top: coords?.top ?? 0,
              visibility: coords === null ? "hidden" : "visible"
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="ps-confirm__msg">Duplicate snap</div>
            <div className="ps-duplicate__choices" role="radiogroup" aria-label="What to copy">
              <label className="ps-duplicate__choice">
                <input
                  type="radio"
                  name={name}
                  checked={withEdits}
                  onChange={() => setWithEdits(true)}
                />
                <span>
                  <span className="ps-duplicate__label">{labels.withEdits}</span>
                  {hint ? <span className="ps-duplicate__hint">{hint}</span> : null}
                </span>
              </label>
              <label className="ps-duplicate__choice">
                <input
                  type="radio"
                  name={name}
                  checked={!withEdits}
                  onChange={() => setWithEdits(false)}
                />
                <span className="ps-duplicate__label">{labels.baseOnly}</span>
              </label>
            </div>
            <label className="ps-confirm__dont-ask">
              <input
                type="checkbox"
                checked={openCopy}
                onChange={(event) => setOpenCopy(event.target.checked)}
              />
              <span>Open the copy in the editor</span>
            </label>
            <div className="ps-confirm__actions">
              <button type="button" className="ps-confirm__btn" onClick={close}>
                Cancel
              </button>
              <button
                ref={confirmRef}
                type="button"
                className="ps-confirm__btn is-primary"
                onClick={() => {
                  close();
                  onDuplicate(record, {
                    withEdits,
                    mode: openCopy ? "edit-copy" : "duplicate",
                    remember: true
                  });
                }}
              >
                Duplicate
              </button>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
