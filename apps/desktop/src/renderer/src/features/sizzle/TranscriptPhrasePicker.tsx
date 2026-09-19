// Searchable dropdown over the timed transcript phrases a preview
// produced — the clip inspector's "Word" timing arm. The timeline's word
// ribbon is the primary way to anchor a clip; this is the searchable
// fallback.

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement
} from "react";
import type { SizzleSequenceTranscriptPhrase } from "@pwrsnap/shared";
import { formatTranscriptPhraseOptionLabel, transcriptPhraseMatches } from "./sizzle-helpers";

/** The popover's height ceiling. Keep in step with
 *  `.szl__sequence-phrase-popover { max-height }` in sizzle.css. */
export const PHRASE_POPOVER_MAX_HEIGHT_PX = 320;
const POPOVER_GAP_PX = 4;
const VIEWPORT_GUTTER_PX = 8;

/**
 * Where the fixed-position popover goes, in viewport coordinates.
 *
 * It opens below the button when the full-height popover fits there, and
 * otherwise on whichever side has more room — capped to that room, so it
 * never runs off the window. The inspector is a drawer at the BOTTOM of the
 * Sizzle rail, which puts the button in the lower third of the window:
 * always opening downward left most of the phrase list off-screen.
 *
 * The side is decided against the popover's CEILING, not its current
 * height: the list grows and shrinks as the user types in the search box,
 * and a popover placed for a short list would overflow once they clear it.
 * Anchoring an upward popover by `bottom` keeps it against the button
 * while it grows.
 */
export function phrasePopoverStyle(
  anchor: DOMRect,
  boundary: DOMRect,
  viewport: { width: number; height: number }
): CSSProperties {
  const gutter = VIEWPORT_GUTTER_PX;
  const width = Math.max(240, Math.min(420, boundary.width - gutter * 2, viewport.width - 32));
  const minLeft = boundary.left + gutter;
  const maxLeft = boundary.right - gutter - width;
  const left = Math.min(Math.max(anchor.left, minLeft), Math.max(minLeft, maxLeft));

  const spaceBelow = viewport.height - anchor.bottom - POPOVER_GAP_PX - gutter;
  const spaceAbove = anchor.top - POPOVER_GAP_PX - gutter;
  if (spaceBelow >= PHRASE_POPOVER_MAX_HEIGHT_PX || spaceBelow >= spaceAbove) {
    return {
      left,
      width,
      top: anchor.bottom + POPOVER_GAP_PX,
      maxHeight: Math.max(0, Math.min(PHRASE_POPOVER_MAX_HEIGHT_PX, spaceBelow))
    };
  }
  return {
    left,
    width,
    bottom: viewport.height - anchor.top + POPOVER_GAP_PX,
    maxHeight: Math.min(PHRASE_POPOVER_MAX_HEIGHT_PX, spaceAbove)
  };
}

export function TranscriptPhrasePicker(props: {
  currentPhrase: string;
  phrases: SizzleSequenceTranscriptPhrase[];
  onSelect: (phrase: SizzleSequenceTranscriptPhrase) => void;
}): ReactElement {
  const { currentPhrase, phrases, onSelect } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(currentPhrase);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});
  const hasTranscript = phrases.length > 0;
  const visiblePhrases = useMemo(() => {
    const filtered = phrases.filter((phrase) => transcriptPhraseMatches(phrase, query));
    return filtered.slice(0, 12);
  }, [phrases, query]);
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (containerRef.current?.contains(target) === true) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return undefined;
    const updatePosition = (): void => {
      const container = containerRef.current;
      if (container === null) return;
      const boundary =
        container.closest<HTMLElement>(".szl__scene--sequence") ??
        container.closest<HTMLElement>(".szl__editor");
      const boundaryRect =
        boundary?.getBoundingClientRect() ??
        new DOMRect(0, 0, window.innerWidth, window.innerHeight);
      setPopoverStyle(
        phrasePopoverStyle(container.getBoundingClientRect(), boundaryRect, {
          width: window.innerWidth,
          height: window.innerHeight
        })
      );
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  if (!hasTranscript) {
    return (
      <button
        className="szl__sequence-phrase-button"
        disabled
        title="Preview the narration to generate a timed transcript before choosing phrase anchors."
        type="button"
      >
        {currentPhrase.length > 0 ? currentPhrase : "Preview for transcript"}
      </button>
    );
  }

  return (
    <div ref={containerRef} className="szl__sequence-phrase-control">
      <button
        className="szl__sequence-phrase-button"
        onClick={() => {
          setQuery(currentPhrase);
          setOpen((value) => !value);
        }}
        title="Choose a phrase from the timed transcript"
        type="button"
      >
        <span>{currentPhrase.length > 0 ? currentPhrase : "Choose transcript phrase"}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div className="szl__sequence-phrase-popover" style={popoverStyle}>
          <input
            className="szl__sequence-phrase-search"
            autoFocus
            value={query}
            placeholder="Search transcript"
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="szl__sequence-phrase-list" role="listbox">
            {visiblePhrases.length > 0 ? (
              visiblePhrases.map((phrase) => (
                <button
                  key={`${phrase.wordStartIndex}-${phrase.wordEndIndex}`}
                  className={
                    "szl__sequence-phrase-option" +
                    (phrase.text === currentPhrase ? " is-selected" : "")
                  }
                  onClick={() => {
                    onSelect(phrase);
                    setOpen(false);
                    setQuery(phrase.text);
                  }}
                  role="option"
                  type="button"
                >
                  <span>{formatTranscriptPhraseOptionLabel(phrase)}</span>
                  <strong>{phrase.text}</strong>
                </button>
              ))
            ) : (
              <span className="szl__sequence-phrase-empty">No matching transcript phrase</span>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
