import { useEffect, useRef, useState } from "react";
import { PwrSnapMark } from "../shared/BrandMark";
import { CopyButton, presetMetrics, type CopyPreset } from "../shared/CopyButton";
import type { PresetMetricMap } from "../shared/usePresetRenderMetrics";
import { FoIcon } from "./FoIcons";

const RES_PRESETS = [
  { id: "low", label: "Low" },
  { id: "med", label: "Med" },
  { id: "high", label: "High" }
] as const satisfies ReadonlyArray<{
  id: CopyPreset;
  label: string;
}>;

const VARIANTS = {
  compact: { showAnnotate: false, showAi: false, showFooter: false, showStorage: false, autoMs: 4000 },
  standard: { showAnnotate: true, showAi: true, showFooter: true, showStorage: false, autoMs: 6000 },
  full: { showAnnotate: true, showAi: true, showFooter: true, showStorage: true, autoMs: 8000 }
} as const;

type VariantId = keyof typeof VARIANTS;

function dimText(w: number, h: number) {
  return `${w.toLocaleString()} × ${h.toLocaleString()}`;
}

function FoTags({
  tags,
  onAdd,
  onRemove,
  suggestions = [],
  onAcceptSuggest
}: {
  tags: string[];
  onAdd: (t: string) => void;
  onRemove: (t: string) => void;
  suggestions?: string[];
  onAcceptSuggest: (t: string) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div className="fo__tags">
      {tags.map((t) => (
        <span key={t} className="fo__tag">
          {t}
          <button className="fo__tag-x" onClick={() => onRemove(t)} aria-label={`remove ${t}`}>
            ×
          </button>
        </span>
      ))}
      {suggestions
        .filter((s) => !tags.includes(s))
        .slice(0, 2)
        .map((s) => (
          <span key={s} className="fo__tag is-suggest" onClick={() => onAcceptSuggest(s)}>
            + {s}
          </span>
        ))}
      <input
        className="fo__tag-input"
        placeholder={tags.length ? "" : "tag…"}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && draft.trim()) {
            onAdd(draft.trim());
            setDraft("");
            e.preventDefault();
          } else if (e.key === "Backspace" && !draft && tags.length) {
            onRemove(tags[tags.length - 1]!);
          }
        }}
      />
    </div>
  );
}

export function FloatOver({
  variant = "standard",
  src,
  enhancedSrc,
  srcW = 2880,
  srcH = 1800,
  srcBytes = 2.4 * 1024 * 1024,
  copyMetrics,
  onDismiss,
  onEdit,
  onCopy,
  onDragFile,
  onDragPreset,
  startCountdown = true,
  initialDescription = "",
  initialTags = [],
  aiSuggestions = ["pwragnt", "ui", "thread-list"],
  aiDescription = "PwrAgnt thread list with selected resume-menu thread",
  thinking = false
}: {
  variant?: VariantId;
  src: string;
  enhancedSrc?: string | undefined;
  srcW?: number;
  srcH?: number;
  srcBytes?: number;
  copyMetrics?: PresetMetricMap | undefined;
  onDismiss?: () => void;
  onEdit?: () => void;
  /** Fired when the user clicks Low / Med / High in the toast. The
   *  parent dispatches `clipboard:copy` with the preset; this
   *  component just animates the "copied" badge. Without this prop
   *  wired (which was the original bug), the buttons looked
   *  responsive but never actually copied anything. */
  onCopy?: (preset: "low" | "med" | "high") => void;
  /** Fired from a drag-start gesture to hand a real PNG file to the OS. */
  onDragFile?: () => void;
  /** Fired from a Low / Med / High drag gesture to hand that preset to the OS. */
  onDragPreset?: (preset: "low" | "med" | "high") => void;
  startCountdown?: boolean;
  initialDescription?: string;
  initialTags?: string[];
  aiSuggestions?: string[];
  aiDescription?: string;
  thinking?: boolean;
}) {
  const cfg = VARIANTS[variant];
  // Note: the prior `copiedId` / `initiallyCopied` state is gone — the
  // shared CopyButton component now owns its own copied state and the
  // visual is the orange "Copied" overlay (no `is-primary` highlight,
  // no bytes-text swap). See features/shared/CopyButton.tsx.
  const [description, setDescription] = useState(initialDescription);
  const [tags, setTags] = useState<string[]>(initialTags);
  const [hovering, setHovering] = useState(false);
  const [progress, setProgress] = useState(1);
  const [exiting, setExiting] = useState(false);
  const [aiAccepted, setAiAccepted] = useState(false);
  const [storage, setStorage] = useState({ drive: false, dropbox: false, s3: false });
  const [visibleSrc, setVisibleSrc] = useState(src);
  const [sourceLoaded, setSourceLoaded] = useState(false);

  const startedAt = useRef(Date.now());
  const elapsedAtPause = useRef(0);
  const rafRef = useRef<number | null>(null);
  // Exit-animation timeout handle. Stored in a ref so we can clear it
  // on unmount — without this, an in-flight `setTimeout(..., 220)` from
  // the previous capture's exit animation would survive a renderer
  // re-mount and call `onDismiss` ~220ms after the NEW toast appears,
  // hiding it. That was the "toast flashes for a microsecond" bug.
  // (With the persistent renderer + state machine added in this same
  // phase, re-mount is rare — but defensive cleanup is cheap.)
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isPaused =
    hovering ||
    description.length > 0 ||
    tags.length > initialTags.length ||
    aiAccepted;

  useEffect(() => {
    setVisibleSrc(src);
    setSourceLoaded(false);
  }, [src]);

  useEffect(() => {
    if (!sourceLoaded || enhancedSrc === undefined || enhancedSrc === src) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setVisibleSrc(enhancedSrc);
    };
    img.src = enhancedSrc;
    return () => {
      cancelled = true;
    };
  }, [sourceLoaded, src, enhancedSrc]);

  useEffect(() => {
    if (!startCountdown || !cfg.autoMs) return;
    if (isPaused) {
      elapsedAtPause.current += Date.now() - startedAt.current;
      startedAt.current = Date.now();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      return;
    }
    const tick = () => {
      const elapsed = elapsedAtPause.current + (Date.now() - startedAt.current);
      const p = Math.max(0, 1 - elapsed / cfg.autoMs);
      setProgress(p);
      if (p <= 0) {
        setExiting(true);
        exitTimerRef.current = setTimeout(() => onDismiss?.(), 220);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    startedAt.current = Date.now();
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [isPaused, startCountdown, cfg.autoMs, onDismiss]);

  // Clear any pending exit-animation timer on unmount. Prevents a
  // setTimeout from a previous mount firing onDismiss after the NEW
  // toast has appeared (the "microsecond flash" bug).
  useEffect(() => {
    return () => {
      if (exitTimerRef.current !== null) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
    };
  }, []);

  const dismissNow = () => {
    setExiting(true);
    exitTimerRef.current = setTimeout(() => onDismiss?.(), 220);
  };

  const dragFile = (event: React.DragEvent): void => {
    if (onDragFile === undefined) return;
    event.preventDefault();
    onDragFile();
  };

  return (
    <div
      className={[
        "fo",
        `fo--variant-${variant}`,
        exiting ? "is-exiting" : "is-entering",
        isPaused ? "is-paused" : "",
        thinking ? "is-thinking" : ""
      ]
        .join(" ")
        .trim()}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      {startCountdown && cfg.autoMs ? (
        <div className="fo__progress">
          <div className="fo__progress-fill" style={{ transform: `scaleX(${progress})` }} />
        </div>
      ) : null}

      <div className="fo__scanner" />

      <div className="fo__hdr">
        <span className="fo__hdr-mark">
          <PwrSnapMark size={12} />
        </span>
        <div className="fo__hdr-meta">
          <div className="fo__hdr-title">Snap captured</div>
          <div className="fo__hdr-sub">{dimText(srcW, srcH)} · just now</div>
        </div>
        <div className="fo__hdr-actions">
          {/* Auto-dismiss pauses on hover / typing — no need for a
              separate Pin affordance. The footer Edit button is the
              primary editor entry; an extra pencil here would be
              redundant. */}
          <button className="fo__icon-btn" title="Dismiss" onClick={dismissNow}>
            <FoIcon name="x" size={12} />
          </button>
        </div>
      </div>

      <div className="fo__preview">
        <img
          src={visibleSrc}
          alt="capture preview"
          draggable
          onDragStart={dragFile}
          onLoad={() => {
            if (visibleSrc === src) setSourceLoaded(true);
          }}
        />
        <div className="fo__preview-dim">
          <FoIcon name="ruler" size={10} style={{ color: "var(--accent)" }} />
          <b>{dimText(srcW, srcH)}</b>
        </div>
        <div className="fo__preview-size">2× retina</div>

        <div className="fo__preview-actions">
          <div className="fo__preview-actions-l">
            <button
              className="fo__hover-btn"
              title="Drag PNG file"
              draggable={onDragFile !== undefined}
              onDragStart={dragFile}
              disabled={onDragFile === undefined}
            >
              <FoIcon name="hand" size={11} /> Drag
            </button>
          </div>
          <div className="fo__preview-actions-r">
            <button
              className="fo__hover-btn"
              title="Open in editor"
              onClick={() => onEdit?.()}
              disabled={onEdit === undefined}
            >
              <FoIcon name="pen-line" size={11} /> Edit
            </button>
            <button className="fo__hover-btn" title="Reveal in library">
              <FoIcon name="folder-open" size={11} />
            </button>
          </div>
        </div>
      </div>

      <div className="fo__copy">
        {RES_PRESETS.map((p) => {
          const m = copyMetrics?.[p.id] ?? presetMetrics(p.id, srcW, srcH, srcBytes);
          return (
            <CopyButton
              key={p.id}
              preset={p.id}
              label={p.label}
              dim={m.dim}
              bytes={m.bytes}
              onCopy={(preset) => onCopy?.(preset)}
              {...(onDragPreset !== undefined ? { onDrag: onDragPreset } : {})}
            />
          );
        })}
      </div>

      {cfg.showAnnotate && (
        <div className="fo__annotate">
          <textarea
            className="fo__desc"
            placeholder="What is this? (a line of context now saves you 20 minutes later)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
          />
          <FoTags
            tags={tags}
            onAdd={(t) => setTags([...tags, t])}
            onRemove={(t) => setTags(tags.filter((x) => x !== t))}
            suggestions={aiSuggestions}
            onAcceptSuggest={(s) => setTags([...tags, s])}
          />
        </div>
      )}

      {cfg.showAi && (
        <div className="fo__ai">
          <span className="fo__ai-mark">
            <FoIcon name="sparkles" size={12} />
          </span>
          <span className="fo__ai-text">
            {thinking ? (
              <>
                Codex is reading the snap<span className="fo__ai-thinking" />
              </>
            ) : aiAccepted ? (
              <>
                Description filled from <b>Codex</b>.
              </>
            ) : (
              <>
                Codex thinks: <b>{aiDescription}</b>
              </>
            )}
          </span>
          {!thinking && !aiAccepted && (
            <button
              className="fo__ai-accept"
              onClick={() => {
                setDescription(aiDescription);
                setTags(Array.from(new Set([...tags, ...aiSuggestions.slice(0, 2)])));
                setAiAccepted(true);
              }}
            >
              Use
            </button>
          )}
        </div>
      )}

      {cfg.showFooter && (
        <div className="fo__foot">
          {cfg.showStorage ? (
            <div className="fo__dest">
              <button
                className={"fo__dest-btn " + (storage.drive ? "is-on" : "")}
                onClick={() => setStorage({ ...storage, drive: !storage.drive })}
                title="Sync to Google Drive"
              >
                <FoIcon name="hard-drive" size={11} /> Drive
              </button>
              <button
                className={"fo__dest-btn " + (storage.dropbox ? "is-on" : "")}
                onClick={() => setStorage({ ...storage, dropbox: !storage.dropbox })}
                title="Sync to Dropbox"
              >
                <FoIcon name="package" size={11} /> Dropbox
              </button>
              <button
                className={"fo__dest-btn " + (storage.s3 ? "is-on" : "")}
                onClick={() => setStorage({ ...storage, s3: !storage.s3 })}
                title="Upload to S3 / R2"
              >
                <FoIcon name="cloud-upload" size={11} /> S3
              </button>
            </div>
          ) : (
            <div className="fo__dest-saved">
              {/* Path mirrors db.getCapturesRoot() — see that comment
                  for why captures live in Documents instead of
                  Application Support. Hardcoded for now; if a future
                  setting makes this configurable, surface that value
                  through props. */}
              <FoIcon name="check" size={11} /> saved · ~/Documents/PwrSnap
            </div>
          )}
          <div className="fo__foot-actions">
            <button className="fo__foot-btn" onClick={dismissNow}>
              Dismiss
            </button>
            <button
              className="fo__foot-btn is-primary"
              type="button"
              onClick={() => onEdit?.()}
              disabled={onEdit === undefined}
              title="Open in Library editor"
            >
              <FoIcon name="pen-line" size={11} /> Edit
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function FoDesktopFrame({
  children,
  sampleSrc
}: {
  children?: React.ReactNode;
  sampleSrc: string;
}) {
  return (
    <div className="fo-frame">
      <div className="fo-desktop">
        <div className="fo-menubar">
          <div className="fo-menubar__l">
            <span className="fo-menubar__active">Finder</span>
            <span>File</span>
            <span>Edit</span>
            <span>View</span>
            <span>Go</span>
          </div>
          <div className="fo-menubar__r">
            <span className="fo-menubar__pwr">
              <span className="fo-menubar__pwr-dot" />
              <PwrSnapMark size={11} />
              <span style={{ color: "var(--accent-bright)", fontSize: 10, fontWeight: 600 }}>
                PwrSnap
              </span>
            </span>
            <span>WiFi</span>
            <span>Tue 10:43 PM</span>
          </div>
        </div>

        <div className="fo-window" style={{ left: 60, top: 70, right: 200, bottom: 130 }}>
          <img src={sampleSrc} alt="" />
        </div>

        {children}
      </div>
    </div>
  );
}
