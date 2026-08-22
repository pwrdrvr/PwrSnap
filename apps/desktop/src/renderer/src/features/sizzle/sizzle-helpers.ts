// Pure helpers for the Sizzle composer — formatting, transition
// shapes, small project utilities. No React, no DOM, no IPC, so every
// surface (shell, editor, timeline) can share them and unit tests can
// pin them in isolation.

import {
  SIZZLE_CROSSFADE_SEC,
  type SizzleProject,
  type SizzleSequencePreviewWarning,
  type SizzleSequenceTranscriptPhrase,
  type SizzleTransition,
  type SizzleTransitionType
} from "@pwrsnap/shared";

/** True when a keystroke belongs to a text field rather than the app. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * `M:SS` for durations ≥ 1 minute, else `NNs`. Mirrors
 * `formatDurationLabel` in Library.tsx (not exported there); kept
 * inline so the sizzle feature doesn't reach across feature
 * boundaries for a 6-line helper.
 */
export function formatDur(seconds: number): string {
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

function labelForSequenceWarning(
  warning: SizzleSequencePreviewWarning,
  beatNumberById: Map<string, number>
): string {
  if (warning.beatId === undefined) return "Scene warning";
  const beatNumber = beatNumberById.get(warning.beatId);
  return beatNumber === undefined ? "Clip warning" : `Clip ${beatNumber}`;
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

export function searchKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function transcriptPhraseMatches(
  phrase: SizzleSequenceTranscriptPhrase,
  query: string
): boolean {
  const q = searchKey(query);
  if (q.length === 0) return true;
  return searchKey(phrase.text).includes(q);
}

export function occurrenceForTranscriptPhrase(
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

export function referencedCaptureIdsForProject(project: SizzleProject | null): string[] {
  if (project === null) return [];
  const ids = new Set<string>();
  for (const scene of project.scenes) {
    ids.add(scene.captureId);
    if (scene.kind !== "sequence" || scene.beats === undefined) continue;
    for (const beat of scene.beats) ids.add(beat.captureId);
  }
  return [...ids];
}

// ── Transitions ────────────────────────────────────────────────────────

export function transitionType(transition: SizzleTransition): SizzleTransitionType {
  return typeof transition === "string" ? transition : transition.type;
}

export function transitionFromType(type: SizzleTransitionType): SizzleTransition {
  if (type === "cut" || type === "crossfade") return type;
  return { type, durationSec: type === "none" ? 0 : 0.18 };
}

/** Change a transition's TYPE while keeping a duration the user already
 *  set: a fade-like → fade-like switch carries the current `durationSec`
 *  over (object form), a switch to cut / none drops it, and a switch from
 *  cut / none starts from the type's default (`transitionFromType`). The
 *  inspector edits type and duration as two fields; this keeps them from
 *  fighting. */
export function transitionWithType(current: SizzleTransition, type: SizzleTransitionType): SizzleTransition {
  if (type === "cut" || type === "none") return transitionFromType(type);
  const currentType = transitionType(current);
  const currentHard = currentType === "cut" || currentType === "none";
  const currentSec = typeof current === "string" ? (current === "crossfade" ? SIZZLE_CROSSFADE_SEC : 0) : current.durationSec;
  if (currentHard || !(currentSec > 0)) return transitionFromType(type);
  return { type, durationSec: currentSec };
}

/** Scene→scene transitions default to the crossfade length (0.4 s): a
 *  scene boundary is a bigger beat than a clip cut, and 0.18 s at scene
 *  level reads as a cut even in the export (plan §4.7). The per-boundary
 *  duration becomes editable with the inspector. */
export function sceneTransitionFromType(type: SizzleTransitionType): SizzleTransition {
  if (type === "cut" || type === "crossfade") return type;
  return { type, durationSec: type === "none" ? 0 : SIZZLE_CROSSFADE_SEC };
}

export const TRANSITION_TYPE_LABELS: Record<SizzleTransitionType, string> = {
  none: "None",
  cut: "Cut",
  crossfade: "Crossfade",
  "dip-black": "Dip to black",
  "dip-white": "Dip to white",
  "push-left": "Push left",
  "slide-left": "Slide left",
  "zoom-cut": "Zoom cut"
};

export function transitionLabel(transition: SizzleTransition): string {
  return transitionType(transition)
    .replace(/-/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

// ── Misc ───────────────────────────────────────────────────────────────

export function clampTime(value: number, durationSec: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), Math.max(0, durationSec));
}

export function formatProjectDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "Unknown date";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

export function isDifferentProjectDate(a: string, b: string): boolean {
  const left = new Date(a);
  const right = new Date(b);
  if (!Number.isFinite(left.getTime()) || !Number.isFinite(right.getTime())) {
    return a !== b;
  }
  return Math.abs(right.getTime() - left.getTime()) > 1000;
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
export function mergeProjectPatch(
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
export function readInitialProjectId(): string | null {
  const hash = window.location.hash.replace(/^#/, "");
  return new URLSearchParams(hash).get("projectId");
}

export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}
