import { useEffect, useRef, useState } from "react";
import { PwrSnapMark } from "../shared/BrandMark";
import { FoIcon } from "./FoIcons";

const RES_PRESETS = [
  { id: "low", label: "Low", scale: 0.4, bytes: "182 KB" },
  { id: "med", label: "Med", scale: 0.7, bytes: "612 KB" },
  { id: "high", label: "High", scale: 1.0, bytes: "2.4 MB" }
] as const;

type ResPreset = (typeof RES_PRESETS)[number];

const VARIANTS = {
  compact: { showAnnotate: false, showAi: false, showFooter: false, showStorage: false, autoMs: 4000 },
  standard: { showAnnotate: true, showAi: true, showFooter: true, showStorage: false, autoMs: 6000 },
  full: { showAnnotate: true, showAi: true, showFooter: true, showStorage: true, autoMs: 8000 }
} as const;

type VariantId = keyof typeof VARIANTS;

function dimText(w: number, h: number) {
  return `${w.toLocaleString()} × ${h.toLocaleString()}`;
}

function FoCopyButton({
  preset,
  primary,
  copied,
  onClick,
  srcW,
  srcH
}: {
  preset: ResPreset;
  primary?: boolean;
  copied?: boolean;
  onClick: () => void;
  srcW: number;
  srcH: number;
}) {
  const w = Math.round(preset.scale * srcW);
  const h = Math.round(preset.scale * srcH);
  const cls = ["fo__copy-btn", primary ? "is-primary" : "", copied ? "is-copied" : ""]
    .join(" ")
    .trim();
  return (
    <button className={cls} onClick={onClick}>
      <div className="fo__copy-btn-row1">
        <span className="fo__copy-label">{preset.label}</span>
        <span className="fo__copy-kbd">⌘{preset.id === "low" ? 1 : preset.id === "med" ? 2 : 3}</span>
      </div>
      <div className="fo__copy-meta">
        <span className="fo__copy-dim">{dimText(w, h)}</span>
        <span className="fo__copy-bytes">{copied ? "copied" : preset.bytes}</span>
      </div>
    </button>
  );
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
  srcW = 2880,
  srcH = 1800,
  onDismiss,
  startCountdown = true,
  initialDescription = "",
  initialTags = [],
  aiSuggestions = ["pwragnt", "ui", "thread-list"],
  aiDescription = "PwrAgnt thread list with selected resume-menu thread",
  thinking = false,
  initiallyCopied = null,
  pinned: pinnedProp = false
}: {
  variant?: VariantId;
  src: string;
  srcW?: number;
  srcH?: number;
  onDismiss?: () => void;
  startCountdown?: boolean;
  initialDescription?: string;
  initialTags?: string[];
  aiSuggestions?: string[];
  aiDescription?: string;
  thinking?: boolean;
  initiallyCopied?: string | null;
  pinned?: boolean;
}) {
  const cfg = VARIANTS[variant];
  const [copiedId, setCopiedId] = useState<string | null>(initiallyCopied);
  const [description, setDescription] = useState(initialDescription);
  const [tags, setTags] = useState<string[]>(initialTags);
  const [pinned, setPinned] = useState(pinnedProp);
  const [hovering, setHovering] = useState(false);
  const [progress, setProgress] = useState(1);
  const [exiting, setExiting] = useState(false);
  const [aiAccepted, setAiAccepted] = useState(false);
  const [storage, setStorage] = useState({ drive: false, dropbox: false, s3: false });

  const startedAt = useRef(Date.now());
  const elapsedAtPause = useRef(0);
  const rafRef = useRef<number | null>(null);

  const isPaused =
    pinned ||
    hovering ||
    description.length > 0 ||
    tags.length > initialTags.length ||
    aiAccepted;

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
        setTimeout(() => onDismiss?.(), 220);
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

  const handleCopy = (presetId: string) => {
    setCopiedId(presetId);
    setTimeout(() => setCopiedId((c) => (c === presetId ? null : c)), 1200);
  };

  const dismissNow = () => {
    setExiting(true);
    setTimeout(() => onDismiss?.(), 220);
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
          <button
            className={"fo__icon-btn " + (pinned ? "is-pinned" : "")}
            title={pinned ? "Unpin" : "Pin (don't auto-dismiss)"}
            onClick={() => setPinned(!pinned)}
          >
            <FoIcon name="pin" size={12} />
          </button>
          <button className="fo__icon-btn" title="Open in editor">
            <FoIcon name="pen-line" size={12} />
          </button>
          <button className="fo__icon-btn" title="Dismiss" onClick={dismissNow}>
            <FoIcon name="x" size={12} />
          </button>
        </div>
      </div>

      <div className="fo__preview">
        <img src={src} alt="capture preview" draggable />
        <div className="fo__preview-dim">
          <FoIcon name="ruler" size={10} style={{ color: "var(--accent)" }} />
          <b>{dimText(srcW, srcH)}</b>
        </div>
        <div className="fo__preview-size">2× retina</div>

        <div className="fo__preview-actions">
          <div className="fo__preview-actions-l">
            <button className="fo__hover-btn" title="Drag to any app">
              <FoIcon name="hand" size={11} /> Drag
            </button>
          </div>
          <div className="fo__preview-actions-r">
            <button className="fo__hover-btn" title="Open in editor">
              <FoIcon name="pen-line" size={11} /> Edit
            </button>
            <button className="fo__hover-btn" title="Reveal in library">
              <FoIcon name="folder-open" size={11} />
            </button>
          </div>
        </div>
      </div>

      <div className="fo__copy">
        {RES_PRESETS.map((p) => (
          <FoCopyButton
            key={p.id}
            preset={p}
            primary={p.id === "high"}
            copied={copiedId === p.id}
            onClick={() => handleCopy(p.id)}
            srcW={srcW}
            srcH={srcH}
          />
        ))}
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
              <FoIcon name="check" size={11} /> saved · ~/Snaps/2026-05-03
            </div>
          )}
          <div className="fo__foot-actions">
            <button className="fo__foot-btn" onClick={dismissNow}>
              Dismiss
            </button>
            <button className="fo__foot-btn is-primary">
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
