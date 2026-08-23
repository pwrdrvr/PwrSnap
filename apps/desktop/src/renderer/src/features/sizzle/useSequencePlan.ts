// Preview plumbing for the editor: per-scene narration playback, the
// cached sequence preview plan / transcript phrases / decoded audio, the
// measured narration durations (this session's previews + the on-open
// cache read), the script-change invalidation, and the bounded-concurrency
// waveform loader. Everything that used to be `useState` spaghetti at the
// top of `Editor` lives here so the editor and the timeline read one model.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type SyntheticEvent
} from "react";
import type {
  SizzleProject,
  SizzleScene,
  SizzleSequencePreviewPlan,
  SizzleSequenceTranscriptPhrase,
  SizzleWordTiming
} from "@pwrsnap/shared";
import { IterableQueueMapperSimple } from "@shutterstock/p-map-iterable";
import { dispatch } from "../../lib/pwrsnap";
import {
  sceneVoiceoverKey,
  sequencePreviewPlanKey,
  sequenceTranscriptKey,
  WAVEFORM_LOAD_CONCURRENCY,
  type CachedSequencePreviewPlan,
  type CachedSequenceTranscriptPhrases
} from "./sequence-plan";
import { base64ToBlob, clampTime } from "./sizzle-helpers";

export type MeasuredDuration = { key: string; durationSec: number };

export type SequencePlanState = {
  /** The single hidden `<audio>` that plays every scene's narration. */
  audioRef: RefObject<HTMLAudioElement | null>;
  /** Handlers to spread onto that `<audio>` element. */
  audioElementProps: {
    onTimeUpdate: (event: SyntheticEvent<HTMLAudioElement>) => void;
    onEnded: () => void;
    onPause: () => void;
  };
  previewingSceneId: string | null;
  previewLoadedSceneId: string | null;
  previewLoadingSceneId: string | null;
  previewError: string | null;
  previewTimeSec: number;
  sequenceAudioBlobs: Record<string, Blob>;
  /** The cached plan for `scene`, or undefined when none matches its key. */
  planForScene: (scene: SizzleScene) => SizzleSequencePreviewPlan | undefined;
  transcriptPhrasesForScene: (scene: SizzleScene) => SizzleSequenceTranscriptPhrase[];
  /** The transcript's words at their spoken times, from a preview run
   *  this session or the speech-timing cache on open; null until the
   *  narration has been synthesized (the timeline's ESTIMATED state —
   *  there is no transcript to position, so nothing is fabricated). */
  wordsForScene: (scene: SizzleScene) => SizzleWordTiming[] | null;
  /** The measured voiceover duration for `scene`, or undefined when none
   *  was measured or the script has changed since it was. */
  measuredVoiceoverDurationSec: (scene: SizzleScene) => number | undefined;
  /** Narration length read from the TTS cache on open, keyed like
   *  `measuredVoiceoverDurationSec`; survives plan-invalidating edits. */
  cachedNarrationDurationSec: (scene: SizzleScene) => number | undefined;
  /** Inputs the reel-length memo must re-run on. */
  durationDeps: readonly unknown[];
  onPreviewScene: (sceneId: string) => Promise<void>;
  seekPreview: (sceneId: string, timeSec: number) => void;
  /** A structural edit (reorder) changed the beat windows: discard any
   *  in-flight preview and stop a now-stale playback. */
  invalidateScenePreview: (sceneId: string) => void;
};

export function useSequencePlan(args: {
  project: SizzleProject;
  onFlushPending: () => Promise<void>;
}): SequencePlanState {
  const { project, onFlushPending } = args;

  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Cache of (sceneId → measured voiceover audio duration in seconds)
  // populated as the user clicks ▶ to preview each scene. Used to
  // surface a "voiceover is longer than trim — last frame will hold"
  // hint on video scenes so the user understands the render math
  // before hitting Render.
  const [previewDurations, setPreviewDurations] = useState<Record<string, MeasuredDuration>>({});
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
  // Per-scene word timings, keyed like the transcript phrases (the
  // narration text) so a rewritten script drops the stale words.
  const [sequenceWords, setSequenceWords] = useState<
    Record<string, { key: string; words: SizzleWordTiming[] }>
  >({});
  // Per-sequence-scene narration audio, captured when a preview decodes
  // it, and handed to wavesurfer to draw the real waveform. Cleared when
  // the narration text changes (the audio is then stale).
  const [sequenceAudioBlobs, setSequenceAudioBlobs] = useState<Record<string, Blob>>({});
  // Narration lengths read from the content-addressed TTS cache when the
  // reel opened. A reel previewed or rendered in ANY past session lands
  // here without synthesizing anything, which is what lets the Render
  // button show an exact length before the user previews this session.
  // Keyed by narration text so a rewritten script drops the stale value.
  const [cachedNarrationDurations, setCachedNarrationDurations] = useState<
    Record<string, MeasuredDuration>
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

  const measuredVoiceoverDurationSec = (scene: SizzleScene): number | undefined => {
    const entry = previewDurations[scene.id];
    return entry?.key === sceneVoiceoverKey(scene, project) ? entry.durationSec : undefined;
  };

  const cachedNarrationDurationSec = (scene: SizzleScene): number | undefined => {
    const entry = cachedNarrationDurations[scene.id];
    return entry?.key === sceneVoiceoverKey(scene, project) ? entry.durationSec : undefined;
  };

  const planForScene = (scene: SizzleScene): SizzleSequencePreviewPlan | undefined => {
    if (scene.kind !== "sequence") return undefined;
    const entry = sequencePreviewPlans[scene.id];
    return entry?.key === sequencePreviewPlanKey(scene) ? entry.plan : undefined;
  };

  const transcriptPhrasesForScene = (scene: SizzleScene): SizzleSequenceTranscriptPhrase[] => {
    if (scene.kind !== "sequence") return [];
    const entry = sequenceTranscriptPhrases[scene.id];
    return entry?.key === sequenceTranscriptKey(scene) ? entry.phrases : [];
  };

  const wordsForScene = (scene: SizzleScene): SizzleWordTiming[] | null => {
    if (scene.kind !== "sequence") return null;
    const entry = sequenceWords[scene.id];
    return entry?.key === sequenceTranscriptKey(scene) ? entry.words : null;
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
      const durationSec =
        cachedSequencePlan?.durationSec ??
        previewDurations[sceneId]?.durationSec ??
        el.duration;
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
      setSequenceWords((prev) => ({
        ...prev,
        [sceneId]: {
          key: sequenceTranscriptKey(scene),
          words: planResult.value.words
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
      [sceneId]: {
        key: scene === undefined ? "" : sceneVoiceoverKey(scene, project),
        durationSec: previewAudio.durationSec
      }
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
        setSequenceWords((prev) => {
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
          // Words arrive with the cached timing (null = no sidecar, which
          // leaves the scene in the estimated state with an empty ribbon).
          const cachedWords = res.value.words;
          if (cachedWords !== null) {
            setSequenceWords((prev) => ({
              ...prev,
              [scene.id]: { key: sequenceTranscriptKey(scene), words: cachedWords }
            }));
          }
          // Positive-finite, not just non-null: the timing sidecar is
          // read back without validating `durationSec`, and a failed
          // probe writes 0. Trusting that would put an EXACT zero-second
          // scene in the reel total.
          const cachedDurationSec = res.value.durationSec;
          if (typeof cachedDurationSec === "number" && cachedDurationSec > 0) {
            setCachedNarrationDurations((prev) => ({
              ...prev,
              [scene.id]: {
                key: sceneVoiceoverKey(scene, project),
                durationSec: cachedDurationSec
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
      previewDurations[sceneId]?.durationSec ??
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

  const invalidateScenePreview = (sceneId: string): void => {
    bumpPreviewGeneration(sceneId);
    if (previewingSceneId === sceneId && audioRef.current !== null) {
      audioRef.current.pause();
      setPreviewingSceneId(null);
    }
  };

  return {
    audioRef,
    audioElementProps: {
      onTimeUpdate: (event) => setPreviewTimeSec(event.currentTarget.currentTime),
      onEnded: () => {
        setPreviewingSceneId(null);
        setPreviewTimeSec(0);
      },
      onPause: () => {
        // Treat any pause (including end-of-track) as "no longer playing"
        // so the button flips back to ▶.
        setPreviewingSceneId(null);
      }
    },
    previewingSceneId,
    previewLoadedSceneId,
    previewLoadingSceneId,
    previewError,
    previewTimeSec,
    sequenceAudioBlobs,
    planForScene,
    transcriptPhrasesForScene,
    wordsForScene,
    measuredVoiceoverDurationSec,
    cachedNarrationDurationSec,
    durationDeps: [sequencePreviewPlans, previewDurations, cachedNarrationDurations],
    onPreviewScene,
    seekPreview,
    invalidateScenePreview
  };
}
