import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactElement
} from "react";
import {
  EVENT_CHANNELS,
  SIZZLE_VOICES,
  distributeSequenceBeatStarts,
  normalizeSizzleSequenceBeatContinuity,
  resolveSizzleAudioSource,
  resolveSizzleVideoFit,
  type CaptureRecord,
  type SizzleBeatTiming,
  type SizzleProject,
  type SizzleRenderProgressEvent,
  type SizzleScene,
  type SizzleSequencePreviewBeat,
  type SizzleSequencePreviewPlan,
  type SizzleSequenceTranscriptPhrase,
  type SizzleSequencePreviewWarning,
  type SizzleSequenceBeat,
  type SizzleTransition,
  type SizzleTransitionType,
  type SizzleVideoFitPolicy,
  type SizzleVoice
} from "@pwrsnap/shared";
import { IterableQueueMapperSimple } from "@shutterstock/p-map-iterable";
import { cacheUrl, captureSrcUrl, dispatch, subscribe } from "../../lib/pwrsnap";
import { PwrSnapMark, PwrSnapWordmark } from "../shared/BrandMark";
import { SizzleChatPanel } from "./SizzleChatPanel";
import "./sizzle.css";

type RenderStatus = {
  phase: SizzleRenderProgressEvent["phase"] | "idle";
  message: string;
  ratio: number;
  error: string | null;
};

type PickerTarget =
  | { kind: "scene" }
  | { kind: "sequenceBeat"; sceneId: string };

type ProjectContextMenuState = {
  projectId: string;
  projectName: string;
  x: number;
  y: number;
};

const IDLE_STATUS: RenderStatus = {
  phase: "idle",
  message: "",
  ratio: 0,
  error: null
};

const RECENT_PROJECT_LIMIT = 5;
const PROJECT_LIST_LIMIT = 100;
const PROJECT_CONTEXT_MENU_WIDTH = 188;
const PROJECT_CONTEXT_MENU_HEIGHT = 70;

function clampContextMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number
): { x: number; y: number } {
  return {
    x: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(y, window.innerHeight - height - 8))
  };
}

/**
 * Apply a debounced edit's patch to the local project state. Used to
 * keep the renderer's view of the project in sync with what the user
 * just typed/picked, before the dispatched write hits disk.
 *
 * `scenes` is replaced wholesale (the patch carries the full array
 * because in-place scene mutation is wrong — the parent passes a new
 * array on every edit). Every other field is a shallow assign.
 */
/**
 * `M:SS` for durations ≥ 1 minute, else `NNs`. Mirrors
 * `formatDurationLabel` in Library.tsx (not exported there); kept
 * inline so the sizzle feature doesn't reach across feature
 * boundaries for a 6-line helper.
 */
function formatDur(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins === 0) return `${secs}s`;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export type SequencePreviewDisplayWarning = {
  key: string;
  label: string;
  message: string;
};

export function formatSequencePreviewWarnings(
  warnings: SizzleSequencePreviewWarning[],
  beatIds: string[] = []
): SequencePreviewDisplayWarning[] {
  const beatNumberById = new Map(beatIds.map((beatId, index) => [beatId, index + 1]));
  const consumed = new Set<number>();
  return warnings.flatMap((warning, index): SequencePreviewDisplayWarning[] => {
    if (consumed.has(index)) return [];
    const label = labelForSequenceWarning(warning, beatNumberById);
    if (warning.code === "media_trim_clamped" && warning.beatId !== undefined) {
      const pairedFitIndex = warnings.findIndex(
        (candidate, candidateIndex) =>
          candidateIndex !== index &&
          !consumed.has(candidateIndex) &&
          candidate.beatId === warning.beatId &&
          candidate.code === "video_fit"
      );
      if (pairedFitIndex >= 0) consumed.add(pairedFitIndex);
      return [
        {
          key: `${warning.code}-${warning.beatId}-${index}`,
          label,
          message:
            pairedFitIndex >= 0
              ? `${warning.message}; using freeze-end because speed-to-fit would be too aggressive`
              : warning.message
        }
      ];
    }
    if (warning.code === "video_fit") {
      const pairedTrimIndex =
        warning.beatId === undefined
          ? -1
          : warnings.findIndex(
              (candidate, candidateIndex) =>
                candidateIndex !== index &&
                !consumed.has(candidateIndex) &&
                candidate.beatId === warning.beatId &&
                candidate.code === "media_trim_clamped"
            );
      if (pairedTrimIndex >= 0) {
        consumed.add(pairedTrimIndex);
        return [
          {
            key: `${warning.code}-${warning.beatId ?? "scene"}-${index}`,
            label,
            message: `${warnings[pairedTrimIndex]!.message}; using freeze-end because speed-to-fit would be too aggressive`
          }
        ];
      }
      return [
        {
          key: `${warning.code}-${warning.beatId ?? "scene"}-${index}`,
          label,
          message: warning.message
        }
      ];
    }
    if (warning.code === "phrase_unresolved") {
      return [
        {
          key: `${warning.code}-${warning.beatId ?? "scene"}-${index}`,
          label,
          message: warning.message
        }
      ];
    }
    return [
      {
        key: `${warning.code}-${warning.beatId ?? "scene"}-${index}`,
        label,
        message: warning.message
      }
    ];
  });
}

export function formatTranscriptPhraseOptionLabel(
  phrase: SizzleSequenceTranscriptPhrase
): string {
  return `${formatTranscriptTime(phrase.startSec)} - ${formatTranscriptTime(phrase.endSec)}`;
}

function formatTranscriptTime(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds * 10) / 10);
  return Number.isInteger(rounded) ? `${rounded}s` : `${rounded.toFixed(1)}s`;
}

function searchKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function transcriptPhraseMatches(
  phrase: SizzleSequenceTranscriptPhrase,
  query: string
): boolean {
  const q = searchKey(query);
  if (q.length === 0) return true;
  return searchKey(phrase.text).includes(q);
}

function occurrenceForTranscriptPhrase(
  selected: SizzleSequenceTranscriptPhrase,
  phrases: SizzleSequenceTranscriptPhrase[]
): number {
  let occurrence = 0;
  for (const phrase of phrases) {
    if (phrase.text !== selected.text) continue;
    occurrence += 1;
    if (
      phrase.startSec === selected.startSec &&
      phrase.wordStartIndex === selected.wordStartIndex
    ) {
      return occurrence;
    }
  }
  return 1;
}

function referencedCaptureIdsForProject(project: SizzleProject | null): string[] {
  if (project === null) return [];
  const ids = new Set<string>();
  for (const scene of project.scenes) {
    ids.add(scene.captureId);
    if (scene.kind !== "sequence" || scene.beats === undefined) continue;
    for (const beat of scene.beats) ids.add(beat.captureId);
  }
  return [...ids];
}

function TranscriptPhrasePicker(props: {
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

function labelForSequenceWarning(
  warning: SizzleSequencePreviewWarning,
  beatNumberById: Map<string, number>
): string {
  if (warning.beatId === undefined) return "Scene warning";
  const beatNumber = beatNumberById.get(warning.beatId);
  return beatNumber === undefined ? "Beat warning" : `Beat ${beatNumber}`;
}

function transitionType(transition: SizzleTransition): SizzleTransitionType {
  return typeof transition === "string" ? transition : transition.type;
}

function transitionFromType(type: SizzleTransitionType): SizzleTransition {
  if (type === "cut" || type === "crossfade") return type;
  return { type, durationSec: type === "none" ? 0 : 0.18 };
}

function transitionLabel(transition: SizzleTransition): string {
  return transitionType(transition)
    .replace(/-/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function clampTime(value: number, durationSec: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), Math.max(0, durationSec));
}

function formatProjectDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "Unknown date";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function isDifferentProjectDate(a: string, b: string): boolean {
  const left = new Date(a);
  const right = new Date(b);
  if (!Number.isFinite(left.getTime()) || !Number.isFinite(right.getTime())) {
    return a !== b;
  }
  return Math.abs(right.getTime() - left.getTime()) > 1000;
}

function admitRecentProject(prev: string[], id: string): string[] {
  if (prev.includes(id)) return prev;
  return [id, ...prev].slice(0, RECENT_PROJECT_LIMIT);
}

function mergeProjectPatch(
  p: SizzleProject,
  patch: Partial<Omit<SizzleProject, "id" | "createdAt">>
): SizzleProject {
  return {
    ...p,
    ...patch,
    scenes: patch.scenes ?? p.scenes,
    modifiedAt: new Date().toISOString()
  };
}

/** The project a freshly-opened composer window should focus, passed by
 *  `sizzle:open` via the URL hash (`#stage=sizzle&projectId=…`). Null when
 *  opened without a target. */
function readInitialProjectId(): string | null {
  const hash = window.location.hash.replace(/^#/, "");
  return new URLSearchParams(hash).get("projectId");
}

function fallbackSequenceBeats(scene: SizzleScene): SizzleSequencePreviewBeat[] {
  const beats = normalizeSizzleSequenceBeatContinuity(scene.beats ?? []);
  const durationSec = Math.max(1, scene.durationOverrideSec ?? beats.length);
  // Idle (pre-preview) placement: no speech timing here, so only `offset`
  // beats are anchors; `phrase` and `auto` are placed by the SAME shared
  // even-division distributor the main planner uses, so the editor strip and
  // the resolved preview/render never diverge.
  const anchors = beats.map((beat): number | null =>
    beat.timing.kind === "offset" ? clampTime(beat.timing.startSec, durationSec) : null
  );
  const starts = distributeSequenceBeatStarts(anchors, durationSec);
  return beats.map((beat, index) => {
    const startSec = starts[index] ?? 0;
    const configuredEnd =
      beat.timing.kind === "offset" && beat.timing.endSec !== null
        ? beat.timing.endSec
        : null;
    const endSec = configuredEnd ?? starts[index + 1] ?? durationSec;
    return {
      beatId: beat.id,
      captureId: beat.captureId,
      startSec,
      endSec: Math.min(durationSec, Math.max(startSec + 0.1, clampTime(endSec, durationSec))),
      timing: beat.timing,
      transition: index === 0 ? scene.transition : beat.transition,
      videoFit: beat.videoFit
    };
  });
}

function sequencePreviewPlanKey(scene: SizzleScene): string {
  return JSON.stringify({
    scriptLine: scene.scriptLine,
    durationOverrideSec: scene.durationOverrideSec,
    transition: scene.transition,
    beats: normalizeSizzleSequenceBeatContinuity(scene.beats ?? []).map((beat) => ({
      id: beat.id,
      captureId: beat.captureId,
      timing: beat.timing,
      mediaTrim: beat.mediaTrim,
      transition: beat.transition,
      videoFit: beat.videoFit
    }))
  });
}

function sequenceTranscriptKey(scene: SizzleScene): string {
  return JSON.stringify({
    scriptLine: scene.scriptLine
  });
}

type CachedSequencePreviewPlan = {
  key: string;
  transcriptKey: string;
  plan: SizzleSequencePreviewPlan;
};

type SequencePreviewVideoState = {
  beatId: string;
  sourceTimeSec: number;
  playbackRate: number;
  shouldPlay: boolean;
};

type CachedSequenceTranscriptPhrases = {
  key: string;
  phrases: SizzleSequenceTranscriptPhrase[];
};

/** Bar count for the idle (pre-preview) waveform placeholder. */
const SEQUENCE_WAVE_BARS = 52;

/** How many cached narration audios to fetch+decode at once when
 *  populating sequence waveforms in the background on reel open. Bounds
 *  the burst of IPC payloads + wavesurfer decodes so a many-scene reel
 *  doesn't jank the editor on load. */
const WAVEFORM_LOAD_CONCURRENCY = 3;

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

function sequencePreviewVideoState(args: {
  beat: SizzleSequencePreviewBeat;
  sceneBeat: SizzleSequenceBeat;
  capture: CaptureRecord;
  timelineTimeSec: number;
}): SequencePreviewVideoState | null {
  const { beat, sceneBeat, capture, timelineTimeSec } = args;
  if (capture.kind !== "video" || capture.video === undefined || capture.video === null) {
    return null;
  }
  const trim = beat.mediaTrim ?? sceneBeat.mediaTrim ?? {
    startSec: capture.video.defaultRange.start,
    endSec: capture.video.defaultRange.end
  };
  const sourceDurationSec = Math.max(0.05, trim.endSec - trim.startSec);
  const targetDurationSec = Math.max(0.05, beat.endSec - beat.startSec);
  const fit = beat.fit ?? resolveSizzleVideoFit({
    policy: sceneBeat.videoFit,
    sourceDurationSec,
    targetDurationSec
  });
  const elapsedSec = Math.max(0, timelineTimeSec - beat.startSec);
  const inputDurationSec = Math.max(0.05, fit.inputDurationSec);
  let sourceOffsetSec: number;

  if (fit.renderMode === "speed-to-fit") {
    sourceOffsetSec = Math.min(inputDurationSec, elapsedSec * fit.playbackRate);
  } else if (fit.renderMode === "loop") {
    sourceOffsetSec = elapsedSec % inputDurationSec;
  } else if (fit.renderMode === "ping-pong") {
    const pairDurationSec = inputDurationSec * 2;
    const phaseSec = elapsedSec % pairDurationSec;
    sourceOffsetSec =
      phaseSec <= inputDurationSec ? phaseSec : pairDurationSec - phaseSec;
  } else {
    sourceOffsetSec = Math.min(inputDurationSec, elapsedSec);
  }

  return {
    beatId: beat.beatId,
    sourceTimeSec: trim.startSec + sourceOffsetSec,
    playbackRate: fit.playbackRate,
    shouldPlay: !(fit.renderMode === "freeze-end" && elapsedSec >= inputDurationSec)
  };
}

/**
 * Render the narration's real waveform with wavesurfer.js (BSD-3-Clause)
 * once a preview has decoded the audio. wavesurfer owns the decode →
 * peak extraction → canvas render; we keep it display-only (no clicks,
 * no cursor) and overlay our own beat track + playhead. Loaded by
 * dynamic import so it is code-split out of the initial bundle and so
 * jsdom unit tests (no canvas / ResizeObserver) never touch it.
 */
function SequenceWaveform({ audioBlob }: { audioBlob: Blob }): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    let instance: import("wavesurfer.js").default | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const { default: WaveSurfer } = await import("wavesurfer.js");
        if (cancelled || containerRef.current === null) return;
        // Canvas can't read CSS vars; resolve the accent at runtime so
        // the waveform tracks the theme. The container's own opacity
        // mutes it to match the rest of the timeline chrome.
        const accent =
          getComputedStyle(document.documentElement)
            .getPropertyValue("--accent")
            .trim() || "#ff8a1f";
        instance = WaveSurfer.create({
          container: containerRef.current,
          height: 24,
          barWidth: 2,
          barGap: 2,
          barRadius: 2,
          waveColor: accent,
          progressColor: accent,
          cursorWidth: 0,
          interact: false,
          normalize: true
        });
        await instance.loadBlob(audioBlob);
      } catch {
        // jsdom (no canvas) or a decode failure — the idle baseline
        // stays in place rather than a fabricated waveform.
      }
    })();
    return () => {
      cancelled = true;
      try {
        instance?.destroy();
      } catch {
        // Already torn down; nothing to clean up.
      }
    };
  }, [audioBlob]);
  return <div ref={containerRef} className="szl__sequence-wave-surfer" aria-hidden="true" />;
}

function SequenceTimelinePreview(props: {
  scene: SizzleScene;
  captureMap: Map<string, CaptureRecord>;
  plan: SizzleSequencePreviewPlan | undefined;
  audioBlob: Blob | undefined;
  currentTimeSec: number;
  playing: boolean;
  loading: boolean;
  onPlay: () => void;
  onSeek: (timeSec: number) => void;
}): ReactElement {
  const { scene, captureMap, plan, audioBlob, currentTimeSec, playing, loading, onPlay, onSeek } = props;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fallbackBeats = fallbackSequenceBeats(scene);
  const beats = plan?.beats ?? fallbackBeats;
  const fallbackDuration = Math.max(
    1,
    scene.durationOverrideSec ?? fallbackBeats.at(-1)?.endSec ?? fallbackBeats.length
  );
  const durationSec = Math.max(0.1, plan?.durationSec ?? fallbackDuration);
  const timeSec = clampTime(currentTimeSec, durationSec);
  const activeBeat =
    beats.find((beat) => timeSec >= beat.startSec && timeSec < beat.endSec) ??
    beats.at(-1) ??
    null;
  const activeCapture =
    activeBeat === null ? null : captureMap.get(activeBeat.captureId) ?? null;
  const activeThumb =
    activeCapture?.edits_version !== undefined && activeBeat !== null
      ? cacheUrl(activeBeat.captureId, 800, "webp", activeCapture.edits_version)
      : activeBeat !== null
        ? cacheUrl(activeBeat.captureId, 800, "webp")
        : "";
  const barCount = SEQUENCE_WAVE_BARS;
  const playheadLeft = `${(timeSec / durationSec) * 100}%`;
  const activeSceneBeat =
    activeBeat === null
      ? null
      : (scene.beats ?? []).find((beat) => beat.id === activeBeat.beatId) ?? null;
  const activeVideoState =
    activeBeat !== null && activeCapture !== null && activeSceneBeat !== null
      ? sequencePreviewVideoState({
          beat: activeBeat,
          sceneBeat: activeSceneBeat,
          capture: activeCapture,
          timelineTimeSec: timeSec
        })
      : null;
  const activeVideoBeatId = activeVideoState?.beatId ?? null;
  const shouldPlayActiveVideo = playing && (activeVideoState?.shouldPlay ?? true);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;
    if (!shouldPlayActiveVideo) {
      video.pause();
      return;
    }
    void video.play().catch(() => undefined);
    return () => {
      video.pause();
    };
  }, [shouldPlayActiveVideo, activeVideoBeatId]);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null || activeVideoState === null) return;
    try {
      video.playbackRate = activeVideoState.playbackRate;
      const driftSec = Math.abs(video.currentTime - activeVideoState.sourceTimeSec);
      if (!shouldPlayActiveVideo || driftSec > 0.12) {
        video.currentTime = activeVideoState.sourceTimeSec;
      }
    } catch {
      // Metadata may not be ready yet. The next audio tick / beat change
      // will retry, and the render path remains authoritative.
    }
  }, [
    activeVideoState?.beatId,
    activeVideoState?.playbackRate,
    activeVideoState?.shouldPlay,
    activeVideoState?.sourceTimeSec,
    shouldPlayActiveVideo
  ]);
  const displayWarnings = formatSequencePreviewWarnings(
    plan?.warnings ?? [],
    beats.map((beat) => beat.beatId)
  );

  const seekFromPointer = (clientX: number, target: HTMLElement): void => {
    const rect = target.getBoundingClientRect();
    const ratio = rect.width <= 0 ? 0 : (clientX - rect.left) / rect.width;
    onSeek(clampTime(ratio * durationSec, durationSec));
  };

  return (
    <div className="szl__sequence-preview">
      <div className="szl__sequence-preview-stage">
        {activeBeat === null ? (
          <span className="szl__sequence-preview-empty">No beats</span>
        ) : activeCapture?.kind === "video" ? (
          <video
            ref={videoRef}
            key={activeBeat.beatId}
            src={captureSrcUrl(activeBeat.captureId)}
            muted
            playsInline
          />
        ) : activeCapture !== null ? (
          <img src={activeThumb} alt="" />
        ) : (
          <span className="szl__sequence-preview-empty">Missing capture</span>
        )}
      </div>
      <div className="szl__sequence-preview-controls">
        <button
          className="szl__scene-mini szl__scene-mini--play"
          onClick={onPlay}
          disabled={loading || scene.scriptLine.trim().length === 0}
          type="button"
          title={scene.scriptLine.trim().length === 0 ? "Write narration to preview" : "Preview sequence"}
        >
          {loading ? "…" : playing ? "■" : "▶"}
        </button>
        <button
          className="szl__scene-mini"
          onClick={() => onSeek(0)}
          type="button"
          title="Seek to start"
        >
          ↤
        </button>
        <span className="szl__sequence-preview-time">
          {formatDur(timeSec)} / {formatDur(durationSec)}
        </span>
        <span className="szl__spacer" />
        <span className="szl__sequence-preview-quality">
          {plan === undefined
            ? "unresolved"
            : plan.timingQuality === "precise"
              ? "word timing"
              : "approx timing"}
        </span>
      </div>
      <button
        className="szl__sequence-timeline"
        type="button"
        onClick={(event) => seekFromPointer(event.clientX, event.currentTarget)}
        aria-label="Sequence timeline"
      >
        {audioBlob === undefined ? (
          // No narration decoded yet — a flat dim baseline (no fabricated
          // variation) until a preview runs and wavesurfer takes over.
          <span className="szl__sequence-wave szl__sequence-wave--idle" aria-hidden="true">
            {Array.from({ length: barCount }, (_, index) => (
              <span key={index} style={{ height: "10%" }} />
            ))}
          </span>
        ) : (
          <SequenceWaveform audioBlob={audioBlob} />
        )}
        <span className="szl__sequence-track" aria-hidden="true">
          {beats.map((beat, index) => {
            const left = (beat.startSec / durationSec) * 100;
            const width = Math.max(1, ((beat.endSec - beat.startSec) / durationSec) * 100);
            const capture = captureMap.get(beat.captureId);
            const isActive = activeBeat?.beatId === beat.beatId;
            return (
              <span
                key={beat.beatId}
                className={"szl__sequence-track-beat" + (isActive ? " is-active" : "")}
                style={{ left: `${left}%`, width: `${width}%` }}
              >
                <span>{index + 1}</span>
                <small>{capture?.source_app_name ?? "Capture"}</small>
                {index > 0 ? <em>{transitionLabel(beat.transition)}</em> : null}
              </span>
            );
          })}
        </span>
        <span className="szl__sequence-playhead" style={{ left: playheadLeft }} aria-hidden="true" />
      </button>
      {displayWarnings.length ? (
        <div className="szl__sequence-warnings">
          {displayWarnings.slice(0, 3).map((warning) => (
            <span key={warning.key}>
              <strong>{warning.label}:</strong> {warning.message}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SizzleApp(): ReactElement {
  const [projects, setProjects] = useState<SizzleProject[]>([]);
  // Seed from the hash so a window opened to a specific reel lands on it,
  // not on projects[0]. reloadProjects only defaults to projects[0] when
  // activeId is still null, so this never gets clobbered.
  const [activeId, setActiveId] = useState<string | null>(() => readInitialProjectId());
  const [captures, setCaptures] = useState<CaptureRecord[]>([]);
  const requestedCaptureIdsRef = useRef<Set<string>>(new Set());
  const [picker, setPicker] = useState<PickerTarget | null>(null);
  const [status, setStatus] = useState<RenderStatus>(IDLE_STATUS);
  const [loading, setLoading] = useState(true);
  const [focusTitleForId, setFocusTitleForId] = useState<string | null>(null);
  const [recentProjectIds, setRecentProjectIds] = useState<string[]>(() => {
    const initial = readInitialProjectId();
    return initial === null ? [] : [initial];
  });
  // Chat lives in a right sidebar alongside the editor (not a full-pane
  // swap) so the scene list stays visible + updates live as the agent
  // edits. Shown by default — chat is the primary way to compose a reel.
  const [showChat, setShowChat] = useState(true);
  const [projectContextMenu, setProjectContextMenu] =
    useState<ProjectContextMenuState | null>(null);

  const active = useMemo(
    () => projects.find((p) => p.id === activeId) ?? null,
    [projects, activeId]
  );

  const projectRail = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p]));
    const recents = recentProjectIds
      .map((id) => byId.get(id) ?? null)
      .filter((p): p is SizzleProject => p !== null)
      .slice(0, RECENT_PROJECT_LIMIT);
    const recentSet = new Set(recents.map((p) => p.id));
    const list = projects
      .filter((p) => !recentSet.has(p.id))
      .slice(0, PROJECT_LIST_LIMIT);
    return { recents, list, totalProjectCount: projects.length };
  }, [activeId, projects, recentProjectIds]);

  const selectProject = useCallback((id: string): void => {
    setActiveId(id);
    setRecentProjectIds((prev) => admitRecentProject(prev, id));
  }, []);

  const closeProjectContextMenu = useCallback((): void => {
    setProjectContextMenu(null);
  }, []);

  const openProjectContextMenu = useCallback(
    (project: SizzleProject, event: ReactMouseEvent<HTMLElement>): void => {
      event.preventDefault();
      event.stopPropagation();
      const position = clampContextMenuPosition(
        event.clientX,
        event.clientY,
        PROJECT_CONTEXT_MENU_WIDTH,
        PROJECT_CONTEXT_MENU_HEIGHT
      );
      setProjectContextMenu({
        projectId: project.id,
        projectName: project.name,
        ...position
      });
    },
    []
  );

  const reloadProjects = useCallback(async () => {
    const r = await dispatch("sizzle:list", {});
    if (r.ok) {
      setProjects(r.value.projects);
      setLoading(false);
      if (activeId === null && r.value.projects.length > 0) {
        selectProject(r.value.projects[0]!.id);
      }
    }
  }, [activeId, selectProject]);

  useEffect(() => {
    void reloadProjects();
  }, [reloadProjects]);

  useEffect(() => {
    void dispatch("library:list", { limit: 200 }).then((r) => {
      if (r.ok) setCaptures(r.value.rows);
    });
  }, []);

  useEffect(() => {
    if (active === null) return;
    const loadedIds = new Set(captures.map((capture) => capture.id));
    const missing = referencedCaptureIdsForProject(active).filter(
      (id) => !loadedIds.has(id) && !requestedCaptureIdsRef.current.has(id)
    );
    if (missing.length === 0) return;
    for (const id of missing) requestedCaptureIdsRef.current.add(id);
    let cancelled = false;
    void dispatch("library:listByIds", { ids: missing }).then((r) => {
      if (cancelled || !r.ok || r.value.rows.length === 0) return;
      setCaptures((prev) => {
        const byId = new Map(prev.map((capture) => [capture.id, capture]));
        for (const capture of r.value.rows) byId.set(capture.id, capture);
        return [...byId.values()];
      });
    });
    return () => {
      cancelled = true;
    };
  }, [active, captures]);

  useEffect(() => {
    return subscribe(EVENT_CHANNELS.sizzleRenderProgress, (payload) => {
      const evt = payload as SizzleRenderProgressEvent;
      if (evt.projectId !== activeId) return;
      setStatus({
        phase: evt.phase,
        message: evt.message,
        ratio: evt.ratio,
        error: evt.error?.message ?? null
      });
      if (evt.phase === "done") {
        void reloadProjects();
      }
    });
  }, [activeId, reloadProjects]);

  const onCreate = useCallback(async () => {
    // Electron deliberately doesn't implement window.prompt — it
    // silently returns null. Skip the dialog: create with a default
    // name and auto-focus the editor's title input so the user can
    // rename in one keystroke.
    const r = await dispatch("sizzle:create", { name: "Untitled Sizzle" });
    if (r.ok) {
      setProjects((prev) => [r.value, ...prev]);
      selectProject(r.value.id);
      setFocusTitleForId(r.value.id);
    }
  }, [selectProject]);

  // Per-project debounce timers + pending-patch coalescing. Multiple
  // edits to the same project within DEBOUNCE_MS get merged into one
  // disk write. Critical for fast-typed text fields — the previous
  // dispatch-per-keystroke pattern raced: each in-flight dispatch
  // carried a snapshot built from STALE local state (since setProjects
  // only ran after the dispatch returned), so only the last typed
  // character survived a sustained burst of typing.
  const DEBOUNCE_MS = 350;
  const pendingPatches = useRef<
    Map<string, Partial<Omit<SizzleProject, "id" | "createdAt">>>
  >(new Map());
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map()
  );

  // ── Undo / redo (per active project) ────────────────────────────────
  // Every local scene mutation funnels through onUpdate({ scenes }); we
  // snapshot the PRE-edit scenes so ⌘Z can restore them. Keyed by project
  // id, so each reel keeps its own history for the session. External chat
  // broadcasts arrive OUTSIDE onUpdate and are intentionally not recorded.
  // Rapid edits (typing) coalesce into one entry within the debounce
  // window. `applyingHistoryRef` suppresses recording while an undo/redo
  // is being applied (so it doesn't re-record or clear the redo stack).
  const HISTORY_COALESCE_MS = DEBOUNCE_MS;
  const HISTORY_MAX = 50;
  const projectsRef = useRef<SizzleProject[]>(projects);
  projectsRef.current = projects;
  const undoStacks = useRef<Map<string, SizzleScene[][]>>(new Map());
  const redoStacks = useRef<Map<string, SizzleScene[][]>>(new Map());
  const lastHistoryAtRef = useRef<Map<string, number>>(new Map());
  const applyingHistoryRef = useRef(false);

  const flushPatch = useCallback(async (id: string): Promise<void> => {
    const pending = pendingPatches.current.get(id);
    pendingPatches.current.delete(id);
    const timer = debounceTimers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      debounceTimers.current.delete(id);
    }
    if (pending === undefined) return;
    const r = await dispatch("sizzle:update", { id, patch: pending });
    if (!r.ok) {
      // Surface persistence failures so the user knows their edit
      // didn't land. Local state already reflects the optimistic
      // value, but disk is out of sync.
      // eslint-disable-next-line no-console
      console.warn("[sizzle] update failed", r.error);
      return;
    }
    // After a successful flush, reconcile the server's modifiedAt back
    // into local state — but ONLY if there's no further pending patch
    // for this id (otherwise we'd overwrite text the user typed during
    // the flush). The scenes field is intentionally NOT echoed back:
    // local state is the source of truth for in-flight edits.
    if (pendingPatches.current.has(id)) return;
    setProjects((prev) =>
      prev.map((p) =>
        p.id === id ? { ...p, modifiedAt: r.value.modifiedAt } : p
      )
    );
  }, []);

  const onDuplicate = useCallback(
    async (id: string) => {
      await flushPatch(id);
      const r = await dispatch("sizzle:duplicate", { id });
      if (r.ok) {
        setProjects((prev) => [r.value, ...prev.filter((p) => p.id !== r.value.id)]);
        selectProject(r.value.id);
        setFocusTitleForId(r.value.id);
      }
    },
    [flushPatch, selectProject]
  );

  const onUpdate = useCallback(
    (id: string, patch: Partial<Omit<SizzleProject, "id" | "createdAt">>) => {
      // 0. Record undo history for scene edits (not name/voice patches, and
      //    not while applying an undo/redo). Rapid edits coalesce: only the
      //    pre-burst snapshot is kept.
      if (patch.scenes !== undefined && !applyingHistoryRef.current) {
        const prevScenes = projectsRef.current.find((p) => p.id === id)?.scenes;
        if (prevScenes !== undefined) {
          const now = Date.now();
          const stack = undoStacks.current.get(id) ?? [];
          const lastAt = lastHistoryAtRef.current.get(id) ?? 0;
          if (stack.length === 0 || now - lastAt > HISTORY_COALESCE_MS) {
            stack.push(prevScenes);
            while (stack.length > HISTORY_MAX) stack.shift();
            undoStacks.current.set(id, stack);
          }
          lastHistoryAtRef.current.set(id, now);
          redoStacks.current.set(id, []); // a fresh edit invalidates redo
        }
      }
      // 1. Optimistic local update — text fields reflect immediately,
      //    next keystroke sees the latest value.
      setProjects((prev) =>
        prev.map((p) => (p.id === id ? mergeProjectPatch(p, patch) : p))
      );
      // 2. Coalesce into the pending patch bag (later writes win
      //    per-field; scenes patches replace wholesale).
      const prev = pendingPatches.current.get(id) ?? {};
      pendingPatches.current.set(id, { ...prev, ...patch });
      // 3. Reset the debounce timer.
      const existing = debounceTimers.current.get(id);
      if (existing !== undefined) clearTimeout(existing);
      debounceTimers.current.set(
        id,
        setTimeout(() => {
          void flushPatch(id);
        }, DEBOUNCE_MS)
      );
    },
    [flushPatch]
  );

  const applyHistoryScenes = useCallback(
    (id: string, scenes: SizzleScene[]): void => {
      applyingHistoryRef.current = true;
      onUpdate(id, { scenes });
      applyingHistoryRef.current = false;
    },
    [onUpdate]
  );
  const undoSceneEdit = useCallback((): void => {
    const id = activeId;
    if (id === null) return;
    const stack = undoStacks.current.get(id);
    if (stack === undefined || stack.length === 0) return;
    const prevScenes = stack.pop();
    if (prevScenes === undefined) return;
    const current = projectsRef.current.find((p) => p.id === id)?.scenes;
    if (current !== undefined) {
      const redo = redoStacks.current.get(id) ?? [];
      redo.push(current);
      redoStacks.current.set(id, redo);
    }
    lastHistoryAtRef.current.set(id, 0); // next user edit starts a fresh entry
    applyHistoryScenes(id, prevScenes);
  }, [activeId, applyHistoryScenes]);
  const redoSceneEdit = useCallback((): void => {
    const id = activeId;
    if (id === null) return;
    const stack = redoStacks.current.get(id);
    if (stack === undefined || stack.length === 0) return;
    const nextScenes = stack.pop();
    if (nextScenes === undefined) return;
    const current = projectsRef.current.find((p) => p.id === id)?.scenes;
    if (current !== undefined) {
      const undo = undoStacks.current.get(id) ?? [];
      undo.push(current);
      undoStacks.current.set(id, undo);
    }
    lastHistoryAtRef.current.set(id, 0);
    applyHistoryScenes(id, nextScenes);
  }, [activeId, applyHistoryScenes]);

  // ⌘Z / ⌘⇧Z (⌘Y) for scene-list edits. Text fields keep their own native
  // per-character undo, so we only intercept when focus is NOT in one.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      const isUndo = key === "z" && !e.shiftKey;
      const isRedo = (key === "z" && e.shiftKey) || key === "y";
      if (!isUndo && !isRedo) return;
      const ae = document.activeElement as HTMLElement | null;
      const tag = ae?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || ae?.isContentEditable === true) return;
      e.preventDefault();
      if (isRedo) redoSceneEdit();
      else undoSceneEdit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undoSceneEdit, redoSceneEdit]);

  // Flush any pending edits on unmount so the on-disk state catches up
  // when the window closes mid-debounce.
  useEffect(() => {
    return () => {
      for (const id of pendingPatches.current.keys()) {
        void flushPatch(id);
      }
    };
  }, [flushPatch]);

  // Live-sync external project mutations (e.g. a chat agent's scene
  // edits, or another window). Without this, an external write lands in
  // the store + broadcasts, but the open editor never sees it.
  //
  // Merge, don't replace: any project with a pending DEBOUNCED local
  // patch is kept as-is so a broadcast (including the echo of our OWN
  // write, which round-trips ~350ms after the last keystroke) can't
  // clobber text the user is still typing. Projects with no in-flight
  // edit take the authoritative broadcast value.
  useEffect(() => {
    return subscribe(EVENT_CHANNELS.sizzleProjectsChanged, (payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const incoming = (payload as { projects?: unknown }).projects;
      if (!Array.isArray(incoming)) return;
      const incomingProjects = incoming as SizzleProject[];
      // An external actor (the chat agent, another window) changed a
      // project's scenes out from under us — our local undo history would
      // clobber that change on ⌘Z, so drop it. Skip projects with a
      // pending local patch (we keep our copy) and the echo of our own
      // writes (scenes unchanged → not cleared).
      for (const inc of incomingProjects) {
        if (pendingPatches.current.has(inc.id)) continue;
        const local = projectsRef.current.find((lp) => lp.id === inc.id);
        if (
          local !== undefined &&
          JSON.stringify(local.scenes) !== JSON.stringify(inc.scenes)
        ) {
          undoStacks.current.delete(inc.id);
          redoStacks.current.delete(inc.id);
          lastHistoryAtRef.current.delete(inc.id);
        }
      }
      setProjects((prev) =>
        incomingProjects.map((p) =>
          pendingPatches.current.has(p.id)
            ? (prev.find((lp) => lp.id === p.id) ?? p)
            : p
        )
      );
    });
  }, []);

  // Navigate when the user clicks a Sizzle Reel in the Library while this
  // composer window is already open (a new window instead gets the target
  // via the hash — see readInitialProjectId). Without this the click
  // focuses the window but the reel selection never changes.
  useEffect(() => {
    return subscribe(EVENT_CHANNELS.sizzleNav, (payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const projectId = (payload as { projectId?: unknown }).projectId;
      if (typeof projectId === "string" && projectId.length > 0) {
        selectProject(projectId);
      }
    });
  }, [selectProject]);

  const onDelete = useCallback(
    async (id: string) => {
      if (!window.confirm("Delete this sizzle reel?")) return;
      const r = await dispatch("sizzle:delete", { id });
      if (r.ok) {
        const fallbackId = projects.find((p) => p.id !== id)?.id ?? null;
        setProjects((prev) => prev.filter((p) => p.id !== id));
        setRecentProjectIds((prev) => prev.filter((recentId) => recentId !== id));
        if (activeId === id) {
          setActiveId(fallbackId);
          if (fallbackId !== null) {
            setRecentProjectIds((prev) => admitRecentProject(prev, fallbackId));
          }
        }
      }
    },
    [activeId, projects]
  );

  const onRender = useCallback(async () => {
    if (active === null) return;
    // Critical: drain any pending debounced edits before the render
    // reads the project off disk. Otherwise typed-but-not-yet-saved
    // script lines would be missing — the render would either fail on
    // "empty script" or synthesize stale text.
    await flushPatch(active.id);
    setStatus({ phase: "tts", message: "Starting…", ratio: 0, error: null });
    const r = await dispatch("sizzle:render", { id: active.id });
    if (!r.ok) {
      setStatus({
        phase: "failed",
        message: r.error.message,
        ratio: 0,
        error: r.error.message
      });
    }
  }, [active, flushPatch]);

  const onReveal = useCallback(async () => {
    if (active === null) return;
    await dispatch("sizzle:revealOutput", { id: active.id });
  }, [active]);

  const onAddScene = useCallback(
    async (captureId: string) => {
      if (active === null) return;
      // Pre-fill the script line from the capture's existing Codex
      // enrichment (accepted description first, then suggested). Every
      // image capture gets a Codex-generated description at capture
      // time — this means new scenes ship with real narratable content
      // out of the box instead of an empty box that synthesizes to
      // a "." click on render.
      let scriptLine = "";
      const enr = await dispatch("codex:enrichment", { captureId });
      if (enr.ok && enr.value !== null) {
        scriptLine =
          enr.value.acceptedDescription ??
          enr.value.suggestedDescription ??
          enr.value.acceptedTitle ??
          enr.value.suggestedTitle ??
          "";
        scriptLine = scriptLine.trim();
      }
      // Seed video scenes with a trim range from the capture's
      // `video.defaultRange` so the editor's trim control opens to
      // sensible bounds instead of [0, 0].
      const captureRecord = captures.find((c) => c.id === captureId) ?? null;
      const captureVideo =
        captureRecord?.kind === "video" ? captureRecord.video ?? null : null;
      const mediaTrim =
        captureVideo !== null
          ? {
              startSec: captureVideo.defaultRange.start,
              endSec: captureVideo.defaultRange.end
            }
          : null;
      const scene: SizzleScene = {
        id: `sc_${Date.now().toString(36)}`,
        captureId,
        scriptLine,
        durationOverrideSec: null,
        mediaTrim,
        audioSource: "auto",
        transition: "crossfade"
      };
      await onUpdate(active.id, { scenes: [...active.scenes, scene] });
      setPicker(null);
    },
    [active, captures, onUpdate]
  );

  const onAddSequenceBeat = useCallback(
    async (sceneId: string, captureId: string) => {
      if (active === null) return;
      const captureRecord = captures.find((c) => c.id === captureId) ?? null;
      const captureVideo =
        captureRecord?.kind === "video" ? captureRecord.video ?? null : null;
      const mediaTrim =
        captureVideo !== null
          ? {
              startSec: captureVideo.defaultRange.start,
              endSec: captureVideo.defaultRange.end
            }
          : null;
      const nextScenes = active.scenes.map((scene) => {
        if (scene.id !== sceneId || scene.kind !== "sequence") return scene;
        const beats = scene.beats ?? [];
        // New beats default to `auto` — they slot in evenly between the
        // anchored beats and need no manual timing (R4).
        const beat: SizzleSequenceBeat = {
          id: `bt_${Date.now().toString(36)}`,
          captureId,
          timing: { kind: "auto" },
          mediaTrim,
          transition: "cut",
          videoFit: "smart-fit"
        };
        return { ...scene, beats: normalizeSizzleSequenceBeatContinuity([...beats, beat]) };
      });
      await onUpdate(active.id, { scenes: nextScenes });
      setPicker(null);
    },
    [active, captures, onUpdate]
  );

  return (
    <div className="szl">
      <header className="szl__titlebar">
        <div className="szl__title-brand">
          <span className="szl__title-mark">
            <PwrSnapMark size={18} />
          </span>
          <PwrSnapWordmark />
        </div>
        <span className="szl__title-crumb">
          Sizzle Reels
          {active !== null ? (
            <>
              <span className="szl__title-sep">›</span>
              <span className="szl__title-here">{active.name}</span>
            </>
          ) : null}
        </span>
        {active !== null ? (
          <>
            <span className="szl__spacer" />
            <button
              type="button"
              className={"szl__chat-toggle" + (showChat ? " is-active" : "")}
              aria-pressed={showChat}
              onClick={() => setShowChat((v) => !v)}
              title={showChat ? "Hide agent chat" : "Show agent chat"}
            >
              {showChat ? "Hide chat" : "Chat with agent"}
            </button>
          </>
        ) : null}
      </header>
      <aside className="szl__rail">
        <button className="szl__new" onClick={onCreate} type="button">
          + New Sizzle Reel
        </button>
        <section className="szl__section" aria-label="Recent projects">
          <div className="szl__section-head">
            <span>Recents</span>
          </div>
          <ul className="szl__list szl__list--recents" data-testid="sizzle-recents-list">
            {loading ? (
              <li className="szl__empty">Loading...</li>
            ) : projectRail.recents.length === 0 ? (
              <li className="szl__empty">No recent projects.</li>
            ) : (
              projectRail.recents.map((p) => (
                <ProjectRow
                  key={p.id}
                  project={p}
                  active={activeId === p.id}
                  onSelect={() => selectProject(p.id)}
                  onOpenMenu={(event) => openProjectContextMenu(p, event)}
                  onDuplicate={() => void onDuplicate(p.id)}
                />
              ))
            )}
          </ul>
        </section>
        <section className="szl__section szl__section--projects" aria-label="Projects">
          <div className="szl__section-head">
            <span>Projects</span>
            {projectRail.totalProjectCount > projectRail.recents.length ? (
              <span className="szl__section-count">
                {projectRail.list.length} of{" "}
                {projectRail.totalProjectCount - projectRail.recents.length}
              </span>
            ) : null}
          </div>
          <ul className="szl__list szl__list--projects" data-testid="sizzle-projects-list">
            {loading ? null : projects.length === 0 ? (
              <li className="szl__empty">No projects yet. Create one above.</li>
            ) : projectRail.list.length === 0 ? (
              <li className="szl__empty">All visible projects are in Recents.</li>
            ) : (
              projectRail.list.map((p) => (
                <ProjectRow
                  key={p.id}
                  project={p}
                  active={activeId === p.id}
                  onSelect={() => selectProject(p.id)}
                  onOpenMenu={(event) => openProjectContextMenu(p, event)}
                  onDuplicate={() => void onDuplicate(p.id)}
                />
              ))
            )}
          </ul>
        </section>
      </aside>

      <main className="szl__main">
        {active === null ? (
          <EmptyState />
        ) : (
          <div className="szl__workspace">
            <Editor
              project={active}
              captures={captures}
              autoFocusTitle={focusTitleForId === active.id}
              onTitleFocused={() => setFocusTitleForId(null)}
              onRename={(name) => onUpdate(active.id, { name })}
              onVoice={(voice) => onUpdate(active.id, { voice })}
              onProvider={(ttsProvider) => onUpdate(active.id, { ttsProvider })}
              onResolution={(resolution) =>
                onUpdate(active.id, { resolution })
              }
              onScenes={(scenes) => onUpdate(active.id, { scenes })}
              onFlushPending={() => flushPatch(active.id)}
              onPickCapture={() => setPicker({ kind: "scene" })}
              onPickSequenceBeat={(sceneId) => setPicker({ kind: "sequenceBeat", sceneId })}
              onRender={onRender}
              onReveal={onReveal}
              onDuplicate={() => void onDuplicate(active.id)}
              onDelete={() => onDelete(active.id)}
              status={status}
            />
            {showChat ? (
              <aside className="szl__chat">
                <SizzleChatPanel key={active.id} projectId={active.id} />
              </aside>
            ) : null}
          </div>
        )}
      </main>

      {picker !== null && active !== null ? (
        <CapturePicker
          captures={captures}
          onPick={(captureId) =>
            picker.kind === "scene"
              ? void onAddScene(captureId)
              : void onAddSequenceBeat(picker.sceneId, captureId)
          }
          onClose={() => setPicker(null)}
          existing={
            new Set(
              picker.kind === "scene"
                ? active.scenes.map((s) => s.captureId)
                : active.scenes
                    .find((s) => s.id === picker.sceneId)
                    ?.beats?.map((beat) => beat.captureId) ?? []
            )
          }
        />
      ) : null}
      {projectContextMenu !== null ? (
        <SizzleProjectContextMenu
          menu={projectContextMenu}
          onClose={closeProjectContextMenu}
          onOpenProject={(projectId) => {
            closeProjectContextMenu();
            selectProject(projectId);
          }}
          onDuplicateProject={(projectId) => {
            closeProjectContextMenu();
            void onDuplicate(projectId);
          }}
        />
      ) : null}
    </div>
  );
}

function ProjectRow({
  project,
  active,
  onSelect,
  onOpenMenu,
  onDuplicate
}: {
  project: SizzleProject;
  active: boolean;
  onSelect: () => void;
  onOpenMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  onDuplicate: () => void;
}): ReactElement {
  const clipLabel = `${project.scenes.length} clip${project.scenes.length === 1 ? "" : "s"}`;
  const updatedLabel = isDifferentProjectDate(project.createdAt, project.modifiedAt)
    ? `Updated ${formatProjectDate(project.modifiedAt)}`
    : null;
  return (
    <li
      className="szl__row-wrap"
      onContextMenu={onOpenMenu}
    >
      <button
        className={"szl__row" + (active ? " is-active" : "")}
        onClick={onSelect}
        type="button"
      >
        <span className="szl__row-name">{project.name}</span>
        <span className="szl__row-meta">
          Created {formatProjectDate(project.createdAt)} · {clipLabel}
        </span>
        {updatedLabel !== null ? (
          <span className="szl__row-meta szl__row-meta--sub">{updatedLabel}</span>
        ) : null}
      </button>
      <button
        type="button"
        className="szl__row-duplicate"
        title="Duplicate Sizzle Reel"
        aria-label={`Duplicate ${project.name}`}
        onClick={(event) => {
          event.stopPropagation();
          onDuplicate();
        }}
      >
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="8" y="8" width="11" height="11" rx="2" />
          <path d="M5 15H4a1 1 0 0 1-1-1V5a2 2 0 0 1 2-2h9a1 1 0 0 1 1 1v1" />
        </svg>
      </button>
    </li>
  );
}

function SizzleProjectContextMenu({
  menu,
  onClose,
  onOpenProject,
  onDuplicateProject
}: {
  menu: ProjectContextMenuState;
  onClose: () => void;
  onOpenProject: (projectId: string) => void;
  onDuplicateProject: (projectId: string) => void;
}): ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onMouseDown(event: MouseEvent): void {
      const root = rootRef.current;
      if (root === null) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      onClose();
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [onClose]);

  useEffect(() => {
    requestAnimationFrame(() => rootRef.current?.focus());
  }, []);

  return (
    <div
      ref={rootRef}
      className="szl__context-menu"
      role="menu"
      tabIndex={-1}
      style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
      onContextMenu={(event) => event.preventDefault()}
      aria-label={`${menu.projectName} actions`}
    >
      <button
        type="button"
        role="menuitem"
        className="szl__context-menu-row"
        onClick={() => onOpenProject(menu.projectId)}
      >
        Open
      </button>
      <button
        type="button"
        role="menuitem"
        className="szl__context-menu-row"
        onClick={() => onDuplicateProject(menu.projectId)}
      >
        Duplicate
      </button>
    </div>
  );
}

function EmptyState(): ReactElement {
  return (
    <div className="szl__empty-pane">
      <div className="szl__empty-mark">▶</div>
      <h2>Sizzle Reels</h2>
      <p>
        Pick a project on the left or create a new one to start composing a
        narrated reel from your captures.
      </p>
      <p className="szl__hint">
        Tip: Add your OpenAI API key in Settings → AI Providers to enable text-to-speech voiceover.
      </p>
    </div>
  );
}

type EditorProps = {
  project: SizzleProject;
  captures: CaptureRecord[];
  status: RenderStatus;
  autoFocusTitle: boolean;
  onTitleFocused: () => void;
  onRename: (name: string) => void;
  onVoice: (voice: SizzleVoice) => void;
  onProvider: (provider: "openai") => void;
  onResolution: (resolution: "1080p" | "720p") => void;
  onScenes: (scenes: SizzleScene[]) => void;
  onFlushPending: () => Promise<void>;
  onPickCapture: () => void;
  onPickSequenceBeat: (sceneId: string) => void;
  onRender: () => void;
  onReveal: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
};

function Editor(props: EditorProps): ReactElement {
  const {
    project,
    captures,
    status,
    autoFocusTitle,
    onTitleFocused,
    onRename,
    onVoice,
    onProvider,
    onResolution,
    onScenes,
    onFlushPending,
    onPickCapture,
    onPickSequenceBeat,
    onRender,
    onReveal,
    onDuplicate,
    onDelete
  } = props;

  const titleRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!autoFocusTitle) return;
    const el = titleRef.current;
    if (el === null) return;
    el.focus();
    el.select();
    onTitleFocused();
  }, [autoFocusTitle, onTitleFocused]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Cache of (sceneId → measured voiceover audio duration in seconds)
  // populated as the user clicks ▶ to preview each scene. Used to
  // surface a "voiceover is longer than trim — last frame will hold"
  // hint on video scenes so the user understands the render math
  // before hitting Render.
  const [previewDurations, setPreviewDurations] = useState<
    Record<string, number>
  >({});
  // Hold the currently-mounted object URL so we can revoke it before
  // assigning a new src. A data: URL would leak ~33% memory per
  // preview AND keep the prior buffer pinned in memory; object URLs
  // can be revoked deterministically. Without revoke, repeated
  // previews would steadily grow the renderer's heap.
  const audioObjectUrlRef = useRef<string | null>(null);
  const revokeAudioObjectUrl = (): void => {
    const url = audioObjectUrlRef.current;
    if (url !== null) {
      URL.revokeObjectURL(url);
      audioObjectUrlRef.current = null;
    }
  };
  useEffect(() => {
    return () => revokeAudioObjectUrl();
  }, []);
  const [previewingSceneId, setPreviewingSceneId] = useState<string | null>(null);
  const [previewLoadedSceneId, setPreviewLoadedSceneId] = useState<string | null>(null);
  const [previewLoadingSceneId, setPreviewLoadingSceneId] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewTimeSec, setPreviewTimeSec] = useState(0);
  const [sequencePreviewPlans, setSequencePreviewPlans] = useState<
    Record<string, CachedSequencePreviewPlan>
  >({});
  const [sequenceTranscriptPhrases, setSequenceTranscriptPhrases] = useState<
    Record<string, CachedSequenceTranscriptPhrases>
  >({});
  // Per-sequence-scene narration audio, captured when a preview decodes
  // it, and handed to wavesurfer to draw the real waveform. Cleared when
  // the narration text changes (the audio is then stale).
  const [sequenceAudioBlobs, setSequenceAudioBlobs] = useState<
    Record<string, Blob>
  >({});

  // Per-scene preview-request generation counter. Each click of ▶
  // bumps it; the response only applies if it's still current.
  // Editing a scene's script also bumps it so an in-flight response
  // for the OLD text can't auto-play after the user moved on.
  //
  // Key safety properties:
  //   • Only one preview play-back per scene can be "current" at a
  //     time. Older in-flight responses are silently discarded.
  //   • TTS audio files are content-addressed (sha256 of provider +
  //     model + voice + text), so a late-arriving response for the
  //     OLD text writes to its OWN file. It can never overwrite the
  //     cache file for the NEW text. The discard prevents stale
  //     PLAYBACK; the file system layout prevents stale OVERWRITES.
  const previewGenerationRef = useRef<Map<string, number>>(new Map());
  const bumpPreviewGeneration = (sceneId: string): number => {
    const next = (previewGenerationRef.current.get(sceneId) ?? 0) + 1;
    previewGenerationRef.current.set(sceneId, next);
    return next;
  };
  const isPreviewCurrent = (sceneId: string, gen: number): boolean => {
    return previewGenerationRef.current.get(sceneId) === gen;
  };

  const onPreviewScene = async (sceneId: string): Promise<void> => {
    // Toggle: if this scene is already playing, stop it. Bump the
    // generation so any in-flight load gets discarded.
    if (previewingSceneId === sceneId && audioRef.current !== null) {
      audioRef.current.pause();
      bumpPreviewGeneration(sceneId);
      setPreviewingSceneId(null);
      setPreviewLoadingSceneId(null);
      return;
    }
    const scene = project.scenes.find((candidate) => candidate.id === sceneId);
    const cachedSequencePlan =
      scene?.kind === "sequence"
        ? sequencePreviewPlans[sceneId]?.key === sequencePreviewPlanKey(scene)
          ? sequencePreviewPlans[sceneId]?.plan
          : undefined
        : undefined;
    if (
      previewLoadedSceneId === sceneId &&
      (scene?.kind !== "sequence" || cachedSequencePlan !== undefined) &&
      audioRef.current !== null &&
      audioRef.current.src.length > 0
    ) {
      const el = audioRef.current;
      const durationSec = cachedSequencePlan?.durationSec ?? previewDurations[sceneId] ?? el.duration;
      if (Number.isFinite(durationSec) && el.currentTime >= durationSec - 0.05) {
        el.currentTime = 0;
        setPreviewTimeSec(0);
      }
      setPreviewError(null);
      setPreviewingSceneId(sceneId);
      try {
        await el.play();
      } catch (cause) {
        setPreviewError(cause instanceof Error ? cause.message : String(cause));
        setPreviewingSceneId(null);
      }
      return;
    }
    const gen = bumpPreviewGeneration(sceneId);
    setPreviewError(null);
    setPreviewLoadingSceneId(sceneId);
    // Flush pending text edits so the preview synthesizes what's on
    // screen, not what was last flushed to disk.
    await onFlushPending();
    if (!isPreviewCurrent(sceneId, gen)) return;
    let previewAudio: {
      audioBase64: string;
      mimeType: "audio/mpeg" | "audio/mp4";
      durationSec: number;
    };
    if (scene?.kind === "sequence") {
      const planResult = await dispatch("sizzle:previewSequenceScenePlan", {
        projectId: project.id,
        sceneId
      });
      if (!isPreviewCurrent(sceneId, gen)) return;
      if (!planResult.ok) {
        setPreviewLoadingSceneId(null);
        setPreviewError(planResult.error.message);
        return;
      }
      setSequencePreviewPlans((prev) => ({
        ...prev,
        [sceneId]: {
          key: sequencePreviewPlanKey(scene),
          transcriptKey: sequenceTranscriptKey(scene),
          plan: planResult.value
        }
      }));
      setSequenceTranscriptPhrases((prev) => ({
        ...prev,
        [sceneId]: {
          key: sequenceTranscriptKey(scene),
          phrases: planResult.value.transcriptPhrases
        }
      }));
      previewAudio = planResult.value;
    } else {
      const result = await dispatch("sizzle:previewSceneAudio", {
        projectId: project.id,
        sceneId
      });
      if (!isPreviewCurrent(sceneId, gen)) return;
      if (!result.ok) {
        setPreviewLoadingSceneId(null);
        setPreviewError(result.error.message);
        return;
      }
      previewAudio = result.value;
    }
    // Cache the measured audio duration so the editor can surface
    // an inline "voiceover is X.Xs vs Y.Ys trim" hint on the video
    // scene's row without forcing the user to render to find out.
    setPreviewDurations((prev) => ({
      ...prev,
      [sceneId]: previewAudio.durationSec
    }));
    const el = audioRef.current;
    if (el === null) {
      setPreviewLoadingSceneId(null);
      return;
    }
    // Decode the base64 into a Blob, hand the audio element an
    // object URL, and revoke the previous one. This keeps a single
    // buffer alive at a time instead of accumulating data URLs.
    const blob = base64ToBlob(previewAudio.audioBase64, previewAudio.mimeType);
    // Hand the decoded narration to wavesurfer so the sequence preview
    // can draw the real waveform. Independent Blob from the playback
    // object URL, so revoking that URL never disturbs the waveform.
    if (scene?.kind === "sequence") {
      setSequenceAudioBlobs((prev) => ({ ...prev, [sceneId]: blob }));
    }
    revokeAudioObjectUrl();
    const objectUrl = URL.createObjectURL(blob);
    audioObjectUrlRef.current = objectUrl;
    el.src = objectUrl;
    el.currentTime = 0;
    setPreviewTimeSec(0);
    setPreviewLoadingSceneId(null);
    setPreviewLoadedSceneId(sceneId);
    setPreviewingSceneId(sceneId);
    try {
      await el.play();
    } catch (cause) {
      setPreviewError(cause instanceof Error ? cause.message : String(cause));
      setPreviewingSceneId(null);
    }
  };

  // Watch the local copy of every scene's scriptLine. When any of
  // them changes, bump that scene's preview generation so a still-
  // in-flight response for the old text gets discarded instead of
  // playing audio that doesn't match the textbox.
  const lastScriptByScene = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    for (const scene of project.scenes) {
      const prev = lastScriptByScene.current.get(scene.id);
      if (prev !== undefined && prev !== scene.scriptLine) {
        bumpPreviewGeneration(scene.id);
        // If this scene was actively playing stale audio, stop it.
        if (previewingSceneId === scene.id && audioRef.current !== null) {
          audioRef.current.pause();
          setPreviewingSceneId(null);
        }
        if (previewLoadedSceneId === scene.id) setPreviewLoadedSceneId(null);
        setSequencePreviewPlans((prev) => {
          if (prev[scene.id] === undefined) return prev;
          const next = { ...prev };
          delete next[scene.id];
          return next;
        });
        setSequenceTranscriptPhrases((prev) => {
          if (prev[scene.id] === undefined) return prev;
          const next = { ...prev };
          delete next[scene.id];
          return next;
        });
        // The narration audio (and thus its waveform) is now stale.
        setSequenceAudioBlobs((prev) => {
          if (prev[scene.id] === undefined) return prev;
          const next = { ...prev };
          delete next[scene.id];
          return next;
        });
      }
      lastScriptByScene.current.set(scene.id, scene.scriptLine);
    }
  }, [project.scenes, previewingSceneId, previewLoadedSceneId]);

  // Proactively fill in sequence waveforms when a reel opens (or a new
  // sequence scene appears) using audio that is ALREADY cached from a
  // prior preview/render — so a rendered reel shows its waveforms
  // without making the user click ▶ first. This is cache-only on the
  // main side (never synthesizes), and runs through a bounded-
  // concurrency queue so a many-scene reel doesn't fire a burst of IPC
  // payloads + wavesurfer decodes at once. Keyed on the set of sequence
  // scene ids (not their text) so it doesn't re-run on every keystroke;
  // the attempt-set guards against duplicate fetches, and a text edit
  // clears the stale blob via the effect above (the user re-previews to
  // regenerate, which isn't cached yet anyway).
  const sequenceSceneIdsKey = useMemo(
    () =>
      project.scenes
        .filter((s) => s.kind === "sequence")
        .map((s) => `${s.id}:${project.ttsProvider}:${project.ttsModel}:${project.voice}:${sequenceTranscriptKey(s)}`)
        .join(","),
    [project.scenes, project.ttsModel, project.ttsProvider, project.voice]
  );
  const waveformAttemptRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const cacheAttemptKey = (scene: SizzleScene): string =>
      `${scene.id}:${project.ttsProvider}:${project.ttsModel}:${project.voice}:${sequenceTranscriptKey(scene)}`;
    const pending = project.scenes.filter(
      (s) =>
        s.kind === "sequence" &&
        (s.narration ?? s.scriptLine).trim().length > 0 &&
        sequenceAudioBlobs[s.id] === undefined &&
        !waveformAttemptRef.current.has(cacheAttemptKey(s))
    );
    if (pending.length === 0) return undefined;
    let cancelled = false;
    const queue = new IterableQueueMapperSimple<SizzleScene>(
      async (scene) => {
        waveformAttemptRef.current.add(cacheAttemptKey(scene));
        try {
          const res = await dispatch("sizzle:loadSequenceSceneAudio", {
            projectId: project.id,
            sceneId: scene.id
          });
          if (cancelled || !res.ok || res.value.cached !== true) return;
          const blob = base64ToBlob(res.value.audioBase64, res.value.mimeType);
          const transcriptPhrases = res.value.transcriptPhrases;
          if (cancelled) return;
          setSequenceAudioBlobs((prev) =>
            prev[scene.id] !== undefined ? prev : { ...prev, [scene.id]: blob }
          );
          if (transcriptPhrases.length > 0) {
            setSequenceTranscriptPhrases((prev) => ({
              ...prev,
              [scene.id]: {
                key: sequenceTranscriptKey(scene),
                phrases: transcriptPhrases
              }
            }));
          }
        } catch {
          // A failed background load just leaves the idle baseline.
        }
      },
      { concurrency: WAVEFORM_LOAD_CONCURRENCY }
    );
    void (async () => {
      for (const scene of pending) {
        if (cancelled) break;
        await queue.enqueue(scene);
      }
      await queue.onIdle();
    })();
    return () => {
      cancelled = true;
    };
    // `sequenceAudioBlobs` is intentionally not a dependency: it changes
    // as blobs are populated, and the attempt-set already prevents
    // re-fetching. Re-running here would just churn.
  }, [project.id, sequenceSceneIdsKey]);

  const seekPreview = (sceneId: string, timeSec: number): void => {
    const scene = project.scenes.find((candidate) => candidate.id === sceneId);
    const cachedPlan =
      scene?.kind === "sequence" &&
      sequencePreviewPlans[sceneId]?.key === sequencePreviewPlanKey(scene)
        ? sequencePreviewPlans[sceneId]?.plan
        : undefined;
    const durationSec =
      cachedPlan?.durationSec ??
      previewDurations[sceneId] ??
      0;
    const clamped = clampTime(timeSec, durationSec);
    setPreviewTimeSec(clamped);
    if (
      (previewingSceneId === sceneId || previewLoadedSceneId === sceneId) &&
      audioRef.current !== null
    ) {
      audioRef.current.currentTime = clamped;
    }
  };

  const captureMap = useMemo(() => {
    const m = new Map<string, CaptureRecord>();
    for (const c of captures) m.set(c.id, c);
    return m;
  }, [captures]);

  const removeScene = (id: string): void => {
    onScenes(project.scenes.filter((s) => s.id !== id));
  };

  const moveScene = (idx: number, delta: number): void => {
    const next = [...project.scenes];
    const target = idx + delta;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target]!, next[idx]!];
    onScenes(next);
  };

  const editScene = (id: string, patch: Partial<SizzleScene>): void => {
    onScenes(
      project.scenes.map((s) => (s.id === id ? { ...s, ...patch } : s))
    );
  };

  const editSequenceBeat = (
    sceneId: string,
    beatId: string,
    patch: Partial<SizzleSequenceBeat>
  ): void => {
    onScenes(
      project.scenes.map((s) => {
        if (s.id !== sceneId || s.kind !== "sequence" || s.beats === undefined) return s;
        return {
          ...s,
          beats: normalizeSizzleSequenceBeatContinuity(s.beats.map((beat) =>
            beat.id === beatId ? { ...beat, ...patch } : beat
          ))
        };
      })
    );
  };

  const beatFromScene = (scene: SizzleScene): SizzleSequenceBeat => ({
    id: `bt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    captureId: scene.captureId,
    timing: { kind: "auto" },
    mediaTrim: scene.mediaTrim,
    transition: "cut",
    videoFit: "smart-fit"
  });

  const convertToSequence = (sceneId: string): void => {
    onScenes(
      project.scenes.map((scene) => {
        if (scene.id !== sceneId || scene.kind === "sequence") return scene;
        return {
          ...scene,
          kind: "sequence",
          narration: scene.scriptLine,
          scriptLine: scene.scriptLine,
          audioSource: "voiceover",
          beats: normalizeSizzleSequenceBeatContinuity([beatFromScene(scene)])
        };
      })
    );
  };

  // Move a beat from one index to another (drag-drop or the ↑/↓ arrows). A
  // splice-and-insert, not a pairwise swap, so dragging across several beats
  // shifts the rest sensibly. `auto` beats need no timing fixup;
  // normalizeSizzleSequenceBeatContinuity re-applies the non-final-end rule
  // after the move. A reorder changes the beat windows, so any in-flight
  // preview for this scene is discarded (generation bump) and a now-stale
  // playback is stopped.
  const reorderSequenceBeat = (sceneId: string, from: number, to: number): void => {
    if (from === to) return; // self-drop / no-op — don't churn or invalidate
    let changed = false;
    onScenes(
      project.scenes.map((scene) => {
        if (scene.id !== sceneId || scene.kind !== "sequence" || scene.beats === undefined) return scene;
        if (from < 0 || from >= scene.beats.length || to < 0 || to >= scene.beats.length) return scene;
        const beats = [...scene.beats];
        const [moved] = beats.splice(from, 1);
        if (moved === undefined) return scene;
        beats.splice(to, 0, moved);
        changed = true;
        return { ...scene, beats: normalizeSizzleSequenceBeatContinuity(beats) };
      })
    );
    if (!changed) return;
    bumpPreviewGeneration(sceneId);
    if (previewingSceneId === sceneId && audioRef.current !== null) {
      audioRef.current.pause();
      setPreviewingSceneId(null);
    }
  };

  const removeSequenceBeat = (sceneId: string, beatId: string): void => {
    onScenes(
      project.scenes.map((scene) => {
        if (scene.id !== sceneId || scene.kind !== "sequence" || scene.beats === undefined) return scene;
        if (scene.beats.length <= 1) return scene;
        return {
          ...scene,
          beats: normalizeSizzleSequenceBeatContinuity(
            scene.beats.filter((beat) => beat.id !== beatId)
          )
        };
      })
    );
  };

  const totalScenes = project.scenes.length;
  const rendering =
    status.phase !== "idle" &&
    status.phase !== "done" &&
    status.phase !== "failed";

  return (
    <div className="szl__editor">
      <header className="szl__editor-head">
        <input
          ref={titleRef}
          className="szl__editor-title"
          value={project.name}
          onChange={(e) => onRename(e.target.value)}
        />
        <div className="szl__editor-meta">
          {totalScenes} scene{totalScenes === 1 ? "" : "s"}
          {project.lastRenderedAt
            ? ` · rendered ${new Date(project.lastRenderedAt).toLocaleString()}`
            : ""}
        </div>
        <span className="szl__spacer" />
        <button className="szl__btn" onClick={onDuplicate} type="button">
          Duplicate
        </button>
        <button className="szl__btn-danger" onClick={onDelete} type="button">
          Delete
        </button>
      </header>

      <div className="szl__controls">
        <label className="szl__field">
          <span>Voice</span>
          <select
            value={project.voice}
            onChange={(e) => onVoice(e.target.value as SizzleVoice)}
          >
            {SIZZLE_VOICES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="szl__field">
          <span>Provider</span>
          <select
            value={project.ttsProvider}
            onChange={(e) => onProvider(e.target.value as "openai")}
          >
            <option value="openai">OpenAI</option>
          </select>
        </label>
        <label className="szl__field">
          <span>Resolution</span>
          <select
            value={project.resolution}
            onChange={(e) =>
              onResolution(e.target.value as "1080p" | "720p")
            }
          >
            <option value="1080p">1920 × 1080</option>
            <option value="720p">1280 × 720</option>
          </select>
        </label>
        <span className="szl__spacer" />
        <button className="szl__btn" onClick={onPickCapture} type="button">
          + Add scene
        </button>
      </div>

      <ul className="szl__scenes">
        {project.scenes.length === 0 ? (
          <li className="szl__scene-empty">
            No scenes yet. Click <strong>Add scene</strong> to pick captures
            from your Library.
          </li>
        ) : (
          project.scenes.flatMap((scene, idx) => {
            const capture = captureMap.get(scene.captureId) ?? null;
            const isVideo = capture?.kind === "video";
            const thumb =
              capture?.edits_version !== undefined
                ? cacheUrl(scene.captureId, 320, "webp", capture.edits_version)
                : cacheUrl(scene.captureId, 320, "webp");
            // Compute the effective audio source for UI gating via
            // the SAME `resolveSizzleAudioSource` the main-process
            // render handler uses. Default to image-kind for the
            // (transient) case where the capture record isn't loaded
            // yet — that's the most permissive direction (image
            // scenes fall through to "voiceover" without needing a
            // video stream, so the preview button stays clickable).
            const effectiveAudio = resolveSizzleAudioSource(
              scene.audioSource,
              capture?.kind ?? "image",
              scene.scriptLine
            );
            const previewDisabled =
              previewLoadingSceneId === scene.id ||
              effectiveAudio === "muted" ||
              (effectiveAudio === "voiceover" && scene.scriptLine.trim().length === 0);
            const previewTitle = previewDisabled
              ? effectiveAudio === "muted"
                ? "This scene is muted"
                : "Write a script line to preview"
              : previewingSceneId === scene.id
                ? "Stop preview"
                : effectiveAudio === "native"
                  ? "Preview native video audio"
                  : "Preview voiceover";
            const sequencePreviewEntry =
              scene.kind === "sequence" ? sequencePreviewPlans[scene.id] : undefined;
            const sequencePreviewPlan =
              scene.kind === "sequence" &&
              sequencePreviewEntry?.key === sequencePreviewPlanKey(scene)
                ? sequencePreviewEntry.plan
                : undefined;
            const sequenceTranscriptEntry =
              scene.kind === "sequence" &&
              sequenceTranscriptPhrases[scene.id]?.key === sequenceTranscriptKey(scene)
                ? sequenceTranscriptPhrases[scene.id]
                : undefined;
            const transcriptPhrases =
              scene.kind === "sequence" ? sequenceTranscriptEntry?.phrases ?? [] : [];

            const elements: ReactElement[] = [];

            // Transition chip between scenes (skip before the first).
            if (idx > 0) {
              elements.push(
                <li
                  key={`tr-${scene.id}`}
                  className={
                    "szl__transition" +
                    (transitionType(scene.transition) === "crossfade"
                      ? " szl__transition--crossfade"
                      : " szl__transition--cut")
                  }
                >
                  <button
                    type="button"
                    className="szl__transition-chip"
                    onClick={() =>
                      editScene(scene.id, {
                        transition:
                          transitionType(scene.transition) === "crossfade" ? "cut" : "crossfade"
                      })
                    }
                    title="Toggle between Cut and Crossfade"
                  >
                    {transitionType(scene.transition) === "crossfade" ? "⌒ Crossfade ⌒" : "─ Cut ─"}
                  </button>
                </li>
              );
            }

            elements.push(
              <li
                key={scene.id}
                className={
                  "szl__scene" +
                  (scene.kind === "sequence" ? " szl__scene--sequence" : "")
                }
              >
                <span className="szl__scene-num">{idx + 1}</span>
                {scene.kind !== "sequence" ? (
                  <div className="szl__scene-thumb">
                    {capture ? (
                      <>
                        {isVideo ? (
                          <video
                            src={captureSrcUrl(scene.captureId)}
                            preload="metadata"
                            muted
                            playsInline
                          />
                        ) : (
                          <img src={thumb} alt="" />
                        )}
                        {isVideo ? (
                          <>
                            <span className="szl__scene-thumb-play" aria-hidden="true">▶</span>
                            <span className="szl__scene-thumb-duration">
                              {formatDur(capture.video?.durationSec ?? 0)}
                            </span>
                          </>
                        ) : null}
                      </>
                    ) : (
                      <span className="szl__scene-missing">missing</span>
                    )}
                  </div>
                ) : null}
                <div className="szl__scene-body">
                  {scene.kind === "sequence" ? (
                    <>
                      <textarea
                        className="szl__scene-script"
                        placeholder="Narration for this sequence"
                        value={scene.narration ?? scene.scriptLine}
                        onChange={(e) =>
                          editScene(scene.id, {
                            scriptLine: e.target.value,
                            narration: e.target.value
                          })
                        }
                      />
                      <div className="szl__scene-row">
                        <span className="szl__scene-app">
                          Sequence · one narration block
                        </span>
                        <span className="szl__spacer" />
                        <button
                          className="szl__scene-action"
                          onClick={() => onPickSequenceBeat(scene.id)}
                          type="button"
                        >
                          + Beat
                        </button>
                      </div>
                      <div className="szl__sequence-beats">
                        {(scene.beats ?? []).map((beat, beatIdx) => {
                          const beatCapture = captureMap.get(beat.captureId) ?? null;
                          const beatThumb =
                            beatCapture?.edits_version !== undefined
                              ? cacheUrl(beat.captureId, 320, "webp", beatCapture.edits_version)
                              : cacheUrl(beat.captureId, 320, "webp");
                          const timingKind = beat.timing.kind;
                          const phraseText = beat.timing.kind === "phrase" ? beat.timing.phrase : "";
                          const isFirstBeat = beatIdx === 0;
                          const isFinalBeat = beatIdx === (scene.beats?.length ?? 0) - 1;
                          return (
                            <div
                              className="szl__sequence-beat"
                              key={beat.id}
                              onDragOver={(e) => {
                                e.preventDefault();
                                e.dataTransfer.dropEffect = "move";
                              }}
                              onDrop={(e) => {
                                e.preventDefault();
                                const from = Number.parseInt(
                                  e.dataTransfer.getData("text/plain"),
                                  10
                                );
                                if (Number.isInteger(from)) {
                                  reorderSequenceBeat(scene.id, from, beatIdx);
                                }
                              }}
                            >
                              <span
                                className="szl__sequence-beat-grip"
                                draggable
                                onDragStart={(e) => {
                                  e.dataTransfer.setData("text/plain", String(beatIdx));
                                  e.dataTransfer.effectAllowed = "move";
                                }}
                                title="Drag to reorder (or use the ↑/↓ buttons)"
                                aria-hidden="true"
                              >
                                ⠿
                              </span>
                              <span className="szl__sequence-beat-num">{beatIdx + 1}</span>
                              <span className="szl__sequence-beat-thumb">
                                {beatCapture !== null ? (
                                  beatCapture.kind === "video" ? (
                                    <video src={captureSrcUrl(beat.captureId)} muted playsInline preload="metadata" />
                                  ) : (
                                    <img src={beatThumb} alt="" />
                                  )
                                ) : (
                                  <span>missing</span>
                                )}
                              </span>
                              <span className="szl__sequence-beat-title">
                                {beatCapture?.source_app_name ?? beat.captureId}
                              </span>
                              <select
                                value={timingKind}
                                disabled={isFirstBeat}
                                onChange={(e) => {
                                  const kind = e.target.value as SizzleBeatTiming["kind"];
                                  editSequenceBeat(scene.id, beat.id, {
                                    timing:
                                      kind === "offset"
                                        ? { kind: "offset", startSec: 0, endSec: null }
                                        : kind === "phrase"
                                          ? { kind: "phrase", phrase: "", occurrence: null, offsetSec: 0, durationSec: null }
                                          : { kind: "auto" }
                                  });
                                }}
                                title={
                                  isFirstBeat
                                    ? "The first beat always starts at 0"
                                    : "When this beat appears: Auto (evenly spaced between anchors), a timed transcript Phrase, or an explicit Offset"
                                }
                              >
                                <option value="auto">Auto</option>
                                <option value="offset">Offset</option>
                                <option value="phrase">Phrase</option>
                              </select>
                              {isFirstBeat ? (
                                // The first beat is always pinned to 0 by the
                                // planner; show that instead of its (inert)
                                // anchor inputs — its stored kind is parked.
                                <span className="szl__sequence-beat-pinned">starts at 0</span>
                              ) : beat.timing.kind === "offset" ? (
                                <>
                                  <label className="szl__sequence-time-field">
                                    <span>Start</span>
                                    <input
                                      className="szl__sequence-time"
                                      type="number"
                                      min={0}
                                      step={0.1}
                                      value={beat.timing.startSec}
                                      disabled={isFirstBeat}
                                      onChange={(e) => {
                                        const v = Number(e.target.value);
                                        if (!Number.isFinite(v)) return;
                                        editSequenceBeat(scene.id, beat.id, {
                                          timing: {
                                            kind: "offset",
                                            startSec: Math.max(0, v),
                                            endSec: beat.timing.kind === "offset" ? beat.timing.endSec : null
                                          }
                                        });
                                      }}
                                      title={isFirstBeat ? "The first beat always starts at 0" : "Beat start seconds"}
                                    />
                                  </label>
                                  <label className="szl__sequence-time-field">
                                    <span>End</span>
                                    <input
                                      className="szl__sequence-time"
                                      type="number"
                                      min={0}
                                      step={0.1}
                                      placeholder="auto"
                                      value={isFinalBeat ? beat.timing.endSec ?? "" : ""}
                                      disabled={!isFinalBeat}
                                      onChange={(e) => {
                                        if (!isFinalBeat) return;
                                        const raw = e.target.value.trim();
                                        const v = raw === "" ? null : Number(raw);
                                        if (v !== null && !Number.isFinite(v)) return;
                                        editSequenceBeat(scene.id, beat.id, {
                                          timing: {
                                            kind: "offset",
                                            startSec: beat.timing.kind === "offset" ? beat.timing.startSec : 0,
                                            endSec: v
                                          }
                                        });
                                      }}
                                      title={isFinalBeat ? "Optional final beat end seconds" : "Non-final beats end automatically at the next beat anchor"}
                                    />
                                  </label>
                                </>
                              ) : beat.timing.kind === "phrase" ? (
                                <>
                                  <TranscriptPhrasePicker
                                    currentPhrase={phraseText}
                                    phrases={transcriptPhrases}
                                    onSelect={(phrase) =>
                                      editSequenceBeat(scene.id, beat.id, {
                                        timing: {
                                          kind: "phrase",
                                          phrase: phrase.text,
                                          occurrence: occurrenceForTranscriptPhrase(phrase, transcriptPhrases),
                                          offsetSec: beat.timing.kind === "phrase" ? beat.timing.offsetSec : 0,
                                          durationSec: beat.timing.kind === "phrase" ? beat.timing.durationSec : null
                                        }
                                      })
                                    }
                                  />
                                  <label className="szl__sequence-time-field">
                                    <span>Offset</span>
                                    <input
                                      className="szl__sequence-time"
                                      type="number"
                                      step={0.1}
                                      value={beat.timing.offsetSec}
                                      onChange={(e) => {
                                        const v = Number(e.target.value);
                                        if (!Number.isFinite(v)) return;
                                        editSequenceBeat(scene.id, beat.id, {
                                          timing: {
                                            kind: "phrase",
                                            phrase: beat.timing.kind === "phrase" ? beat.timing.phrase : "",
                                            occurrence: beat.timing.kind === "phrase" ? beat.timing.occurrence : null,
                                            offsetSec: v,
                                            durationSec: beat.timing.kind === "phrase" ? beat.timing.durationSec : null
                                          }
                                        });
                                      }}
                                      title="Seconds to shift from the matched phrase start. Negative starts before the phrase; positive starts after it."
                                    />
                                  </label>
                                </>
                              ) : null}
                              <select
                                value={beat.videoFit}
                                onChange={(e) =>
                                  editSequenceBeat(scene.id, beat.id, {
                                    videoFit: e.target.value as SizzleVideoFitPolicy
                                  })
                                }
                              >
                                <option value="smart-fit">Smart</option>
                                <option value="loop">Loop</option>
                                <option value="ping-pong">Ping-pong</option>
                                <option value="speed-to-fit">Speed</option>
                                <option value="freeze-end">Freeze</option>
                                <option value="trim">Trim</option>
                              </select>
                              <select
                                value={transitionType(beat.transition)}
                                onChange={(e) =>
                                  editSequenceBeat(scene.id, beat.id, {
                                    transition: transitionFromType(e.target.value as SizzleTransitionType)
                                  })
                                }
                              >
                                <option value="cut">Cut</option>
                                <option value="crossfade">Fade</option>
                                <option value="dip-black">Dip black</option>
                                <option value="dip-white">Dip white</option>
                                <option value="push-left">Push left</option>
                                <option value="slide-left">Slide left</option>
                                <option value="zoom-cut">Zoom</option>
                              </select>
                              <button
                                className="szl__scene-mini"
                                onClick={() => reorderSequenceBeat(scene.id, beatIdx, beatIdx - 1)}
                                disabled={beatIdx === 0}
                                type="button"
                                title="Move beat up"
                              >
                                ↑
                              </button>
                              <button
                                className="szl__scene-mini"
                                onClick={() => reorderSequenceBeat(scene.id, beatIdx, beatIdx + 1)}
                                disabled={beatIdx === (scene.beats?.length ?? 0) - 1}
                                type="button"
                                title="Move beat down"
                              >
                                ↓
                              </button>
                              <button
                                className="szl__scene-mini szl__scene-mini--danger"
                                onClick={() => removeSequenceBeat(scene.id, beat.id)}
                                disabled={(scene.beats?.length ?? 0) <= 1}
                                type="button"
                                title="Remove beat"
                              >
                                ✕
                              </button>
                            </div>
                          );
                        })}
                      </div>
                      <div className="szl__scene-hint">
                        Sequence scene: one script across {scene.beats?.length ?? 0} asset beat{(scene.beats?.length ?? 0) === 1 ? "" : "s"}. Phrase anchors use timed transcript words from preview; the transcript can differ from the written script.
                      </div>
                      <SequenceTimelinePreview
                        scene={scene}
                        captureMap={captureMap}
                        plan={sequencePreviewPlan}
                        audioBlob={sequenceAudioBlobs[scene.id]}
                        currentTimeSec={
                          previewingSceneId === scene.id || previewLoadedSceneId === scene.id
                            ? previewTimeSec
                            : 0
                        }
                        playing={previewingSceneId === scene.id}
                        loading={previewLoadingSceneId === scene.id}
                        onPlay={() => void onPreviewScene(scene.id)}
                        onSeek={(timeSec) => seekPreview(scene.id, timeSec)}
                      />
                      <div className="szl__scene-row">
                        <span className="szl__scene-app">sequence</span>
                        <span className="szl__spacer" />
                        <button className="szl__scene-mini" onClick={() => moveScene(idx, -1)} disabled={idx === 0} type="button" title="Move up">↑</button>
                        <button className="szl__scene-mini" onClick={() => moveScene(idx, 1)} disabled={idx === project.scenes.length - 1} type="button" title="Move down">↓</button>
                        <button className="szl__scene-mini szl__scene-mini--danger" onClick={() => removeScene(scene.id)} type="button" title="Remove scene">✕</button>
                      </div>
                    </>
                  ) : (
                    <>
                  <textarea
                    className="szl__scene-script"
                    placeholder={
                      isVideo
                        ? "Optional — leave blank to play the video's native audio"
                        : "What does the narrator say over this scene?"
                    }
                    value={scene.scriptLine}
                    onChange={(e) =>
                      editScene(scene.id, { scriptLine: e.target.value })
                    }
                  />

                  {isVideo && capture?.video !== null && capture?.video !== undefined ? (
                    <div className="szl__scene-row">
                      <label className="szl__scene-dur">
                        <span>Trim start</span>
                        <input
                          type="number"
                          min={0}
                          max={capture.video.durationSec}
                          step={0.1}
                          value={
                            scene.mediaTrim?.startSec ??
                            capture.video.defaultRange.start
                          }
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            if (!Number.isFinite(v) || v < 0) return;
                            const currentEnd =
                              scene.mediaTrim?.endSec ??
                              capture.video?.defaultRange.end ??
                              capture.video?.durationSec ??
                              v + 1;
                            editScene(scene.id, {
                              mediaTrim: {
                                startSec: v,
                                endSec: Math.max(v + 0.1, currentEnd)
                              }
                            });
                          }}
                        />
                        <span className="szl__scene-dur-unit">s</span>
                      </label>
                      <label className="szl__scene-dur">
                        <span>Trim end</span>
                        <input
                          type="number"
                          min={0}
                          max={capture.video.durationSec}
                          step={0.1}
                          value={
                            scene.mediaTrim?.endSec ??
                            capture.video.defaultRange.end
                          }
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            if (!Number.isFinite(v)) return;
                            const currentStart =
                              scene.mediaTrim?.startSec ??
                              capture.video?.defaultRange.start ??
                              0;
                            editScene(scene.id, {
                              mediaTrim: {
                                startSec: Math.min(currentStart, v - 0.1),
                                endSec: v
                              }
                            });
                          }}
                        />
                        <span className="szl__scene-dur-unit">s</span>
                      </label>
                      <label className="szl__scene-dur">
                        <span>Audio</span>
                        <select
                          value={scene.audioSource}
                          onChange={(e) =>
                            editScene(scene.id, {
                              audioSource: e.target.value as
                                | "auto"
                                | "native"
                                | "voiceover"
                                | "muted"
                            })
                          }
                        >
                          <option value="auto">Auto ({effectiveAudio})</option>
                          <option value="native">Native</option>
                          <option value="voiceover">Voiceover</option>
                          <option value="muted">Muted</option>
                        </select>
                      </label>
                    </div>
                  ) : null}

                  {(() => {
                    // Inline mismatch hint for video scenes whose
                    // voiceover overruns the clip — surfaces the
                    // composer's "last frame holds while voiceover
                    // finishes" behavior so the user understands
                    // what'll happen before clicking Render. Only
                    // shows once the user has previewed (so we have
                    // a measured TTS duration to compare against).
                    if (!isVideo || effectiveAudio !== "voiceover") return null;
                    const audioDur = previewDurations[scene.id];
                    if (audioDur === undefined) return null;
                    const trimDur =
                      (scene.mediaTrim?.endSec ??
                        capture?.video?.defaultRange.end ??
                        0) -
                      (scene.mediaTrim?.startSec ??
                        capture?.video?.defaultRange.start ??
                        0);
                    if (audioDur + 0.35 <= trimDur + 0.1) return null;
                    const padSec = audioDur + 0.35 - trimDur;
                    return (
                      <div className="szl__scene-hint">
                        Voiceover is {audioDur.toFixed(1)}s — longer than the {trimDur.toFixed(1)}s trim.
                        Render will hold the last frame for {padSec.toFixed(1)}s.
                      </div>
                    );
                  })()}

                  <div className="szl__scene-row">
                    {!isVideo ? (
                      <label className="szl__scene-dur">
                        <span>Duration</span>
                        <input
                          type="number"
                          min={1}
                          max={30}
                          step={0.5}
                          placeholder="auto"
                          value={scene.durationOverrideSec ?? ""}
                          onChange={(e) => {
                            const v = e.target.value.trim();
                            editScene(scene.id, {
                              durationOverrideSec:
                                v === "" ? null : Number(v)
                            });
                          }}
                        />
                        <span className="szl__scene-dur-unit">s</span>
                      </label>
                    ) : null}
                    <span className="szl__scene-app">
                      {capture?.source_app_name ?? "unknown app"}
                    </span>
                    <span className="szl__spacer" />
                    <button
                      className="szl__scene-action"
                      onClick={() => convertToSequence(scene.id)}
                      type="button"
                    >
                      Sequence
                    </button>
                    <button
                      className="szl__scene-mini szl__scene-mini--play"
                      onClick={() => void onPreviewScene(scene.id)}
                      disabled={previewDisabled}
                      type="button"
                      title={previewTitle}
                    >
                      {previewLoadingSceneId === scene.id
                        ? "…"
                        : previewingSceneId === scene.id
                          ? "■"
                          : "▶"}
                    </button>
                    <button
                      className="szl__scene-mini"
                      onClick={() => moveScene(idx, -1)}
                      disabled={idx === 0}
                      type="button"
                      title="Move up"
                    >
                      ↑
                    </button>
                    <button
                      className="szl__scene-mini"
                      onClick={() => moveScene(idx, 1)}
                      disabled={idx === project.scenes.length - 1}
                      type="button"
                      title="Move down"
                    >
                      ↓
                    </button>
                    <button
                      className="szl__scene-mini szl__scene-mini--danger"
                      onClick={() => removeScene(scene.id)}
                      type="button"
                      title="Remove scene"
                    >
                      ✕
                    </button>
                  </div>
                    </>
                  )}
                </div>
              </li>
            );
            return elements;
          })
        )}
      </ul>

      {previewError !== null ? (
        <div className="szl__preview-error">{previewError}</div>
      ) : null}
      <audio
        ref={audioRef}
        onTimeUpdate={(event) => setPreviewTimeSec(event.currentTarget.currentTime)}
        onEnded={() => {
          setPreviewingSceneId(null);
          setPreviewTimeSec(0);
        }}
        onPause={() => {
          // Treat any pause (including end-of-track) as "no longer playing"
          // so the button flips back to ▶.
          setPreviewingSceneId(null);
        }}
        style={{ display: "none" }}
      />

      <footer className="szl__footer">
        <RenderStatusBar status={status} />
        <span className="szl__spacer" />
        {project.outputPath !== null ? (
          <button
            className="szl__btn"
            type="button"
            onClick={onReveal}
            title={project.outputPath}
          >
            Reveal in Finder
          </button>
        ) : null}
        <button
          className="szl__btn-primary"
          onClick={onRender}
          type="button"
          disabled={rendering || project.scenes.length === 0}
        >
          {rendering ? `Rendering… ${Math.round(status.ratio * 100)}%` : "Render"}
        </button>
      </footer>
    </div>
  );
}

function RenderStatusBar({ status }: { status: RenderStatus }): ReactElement {
  if (status.phase === "idle") {
    return (
      <span className="szl__status szl__status--idle">
        Add a scene, write a script line, then render.
      </span>
    );
  }
  if (status.phase === "failed") {
    return (
      <span className="szl__status szl__status--err">
        Render failed: {status.error ?? status.message}
      </span>
    );
  }
  if (status.phase === "done") {
    return (
      <span className="szl__status szl__status--ok">Render complete.</span>
    );
  }
  return (
    <span className="szl__status">
      <span className="szl__status-bar">
        <span
          className="szl__status-bar-fill"
          style={{ width: `${Math.round(status.ratio * 100)}%` }}
        />
      </span>
      <span>{status.message}</span>
    </span>
  );
}

type CapturePickerProps = {
  captures: CaptureRecord[];
  existing: Set<string>;
  onPick: (captureId: string) => void;
  onClose: () => void;
};

function CapturePicker({
  captures,
  existing,
  onPick,
  onClose
}: CapturePickerProps): ReactElement {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  return (
    <div
      ref={overlayRef}
      className="szl__modal-overlay"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div className="szl__modal">
        <header>
          <h3>Add scene from Library</h3>
          <button
            className="szl__scene-mini"
            type="button"
            onClick={onClose}
            title="Close"
          >
            ✕
          </button>
        </header>
        {captures.length === 0 ? (
          <p className="szl__hint">No captures available.</p>
        ) : (
          <div className="szl__picker-grid">
            {captures
              .filter((c) => c.deleted_at === null)
              .map((c) => {
                const isVideo = c.kind === "video";
                const durSec = isVideo ? c.video?.durationSec ?? 0 : 0;
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={
                      "szl__picker-cell" + (existing.has(c.id) ? " is-used" : "")
                    }
                    onClick={() => onPick(c.id)}
                    title={c.source_app_name ?? ""}
                  >
                    <span className="szl__picker-thumb-wrap">
                      {isVideo ? (
                        // `pwrsnap-cache://` doesn't render image
                        // thumbnails for video captures — it's an
                        // image-render pipeline. Use the source video
                        // directly with `preload="metadata"` so we get
                        // just the first frame as a poster without
                        // decoding the whole clip. Same pattern as
                        // VideoCellThumb in Library.tsx.
                        <video
                          src={captureSrcUrl(c.id)}
                          preload="metadata"
                          muted
                          playsInline
                        />
                      ) : (
                        <img
                          src={cacheUrl(c.id, 240, "webp", c.edits_version)}
                          alt=""
                          // loading=lazy + decoding=async + the cell's
                          // content-visibility:auto skip the cache-protocol
                          // fetch for offscreen cells.
                          loading="lazy"
                          decoding="async"
                        />
                      )}
                      {isVideo ? (
                        <>
                          <span className="szl__picker-play" aria-hidden="true">▶</span>
                          <span className="szl__picker-duration">
                            {formatDur(durSec)}
                          </span>
                        </>
                      ) : null}
                    </span>
                    <span className="szl__picker-label">
                      {c.source_app_name ?? "—"}
                    </span>
                  </button>
                );
              })}
          </div>
        )}
      </div>
    </div>
  );
}
