// Searchable dropdown over the timed transcript phrases a preview
// produced, used by the legacy beat row's `phrase` timing arm. The
// timeline's word ribbon (plan PR 4) supersedes it as the primary way to
// anchor a clip; this stays for the form-row fallback until PR 6.

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
      const rect = container.getBoundingClientRect();
      const boundary =
        container.closest<HTMLElement>(".szl__scene--sequence") ??
        container.closest<HTMLElement>(".szl__editor");
      const boundaryRect =
        boundary?.getBoundingClientRect() ??
        new DOMRect(0, 0, window.innerWidth, window.innerHeight);
      const gutter = 8;
      const width = Math.max(
        240,
        Math.min(420, boundaryRect.width - gutter * 2, window.innerWidth - 32)
      );
      const minLeft = boundaryRect.left + gutter;
      const maxLeft = boundaryRect.right - gutter - width;
      const left = Math.min(Math.max(rect.left, minLeft), Math.max(minLeft, maxLeft));
      setPopoverStyle({
        left,
        top: rect.bottom + 4,
        width
      });
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
