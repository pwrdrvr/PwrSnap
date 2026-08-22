// The reel editor: title + meta head, reel settings, the scene list,
// the hidden narration <audio>, and the render footer. Owns the scene
// edit wrappers (pure ops in scene-ops.ts → `onScenes`) and the preview
// plumbing (useSequencePlan). The shell (SizzleApp) owns project state.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  estimateSizzleReelDurationSec,
  formatSizzleDuration,
  resolveSizzleAudioSource,
  type CaptureRecord,
  type SizzleProject,
  type SizzleScene,
  type SizzleSceneDurationContext,
  type SizzleSequenceBeat,
  type SizzleVoice
} from "@pwrsnap/shared";
import { ReelSettings } from "./ReelSettings";
import { SizzleTimeline } from "./timeline/SizzleTimeline";
import { anchorTimingForWord } from "./timeline/anchor";
import { applyClipStartDrag, applyFinalEndDrag, type TimelineDragCommit } from "./timeline/retime";
import {
  buildTimelineModel,
  clipAt,
  sceneAt,
  type TimelineClip,
  type TimelineSceneRegion,
  type TimelineWord
} from "./timeline/timeline-model";
import { RenderStatusBar, isRendering, type RenderStatus } from "./RenderStatusBar";
import { createPortal } from "react-dom";
import { ClipInspector } from "./ClipInspector";
import { SceneInspector } from "./SceneInspector";
import { isTypingTarget } from "./sizzle-helpers";
import { SceneTransitionChip, SequenceSceneCard, SimpleSceneCard } from "./SceneCard";
import {
  convertSceneToSequence,
  mergeSceneIntoPrevious,
  moveSceneBy,
  patchScene,
  patchSequenceBeat,
  refitSceneOffsets,
  removeSceneById,
  removeSequenceBeatFrom,
  reorderSequenceBeatIn,
  splitSceneAtSec,
  splitSceneIntoScenes
} from "./scene-ops";
import { useSequencePlan } from "./useSequencePlan";

export type EditorProps = {
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
  /** The selected clip (owned by the shell: the right rail shows the
   *  inspector for it). */
  selectedClipId: string | null;
  onSelectClipId: (beatId: string | null) => void;
  /** The selected scene (a region / transition pill on the timeline);
   *  mutually exclusive with the clip selection. */
  selectedSceneId: string | null;
  onSelectSceneId: (sceneId: string | null) => void;
  /** Where the clip inspector renders (a slot in the right rail); null
   *  while the rail is not mounted. */
  inspectorHost: HTMLElement | null;
};

export function Editor(props: EditorProps): ReactElement {
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
    onDelete,
    selectedClipId,
    onSelectClipId,
    selectedSceneId,
    onSelectSceneId,
    inspectorHost
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

  const plan = useSequencePlan({ project, onFlushPending });

  const captureMap = useMemo(() => {
    const m = new Map<string, CaptureRecord>();
    for (const c of captures) m.set(c.id, c);
    return m;
  }, [captures]);

  // ── Scene edits: pure ops wrapped with onScenes ──────────────────────
  const removeScene = (id: string): void => {
    onScenes(removeSceneById(project.scenes, id));
  };
  const moveScene = (idx: number, delta: number): void => {
    const next = moveSceneBy(project.scenes, idx, delta);
    if (next !== project.scenes) onScenes(next);
  };
  const editScene = (id: string, patch: Partial<SizzleScene>): void => {
    onScenes(patchScene(project.scenes, id, patch));
  };
  const editSequenceBeat = (
    sceneId: string,
    beatId: string,
    patch: Partial<SizzleSequenceBeat>
  ): void => {
    onScenes(patchSequenceBeat(project.scenes, sceneId, beatId, patch));
  };
  const convertToSequence = (sceneId: string): void => {
    onScenes(convertSceneToSequence(project.scenes, sceneId));
  };
  const splitIntoScenes = (sceneId: string): void => {
    onScenes(splitSceneIntoScenes(project.scenes, sceneId));
  };
  // A reorder changes the beat windows, so any in-flight preview for this
  // scene is discarded and a now-stale playback is stopped.
  const reorderSequenceBeat = (sceneId: string, from: number, to: number): void => {
    const result = reorderSequenceBeatIn(project.scenes, sceneId, from, to);
    if (!result.changed) return; // self-drop / no-op — don't churn or invalidate
    onScenes(result.scenes);
    plan.invalidateScenePreview(sceneId);
  };
  const removeSequenceBeat = (sceneId: string, beatId: string): void => {
    onScenes(removeSequenceBeatFrom(project.scenes, sceneId, beatId));
  };

  // The render path rejects an empty script only when the scene's audio
  // actually resolves to VOICEOVER, so mirror that condition rather than
  // "any empty scriptLine". A sequence scene is always voiceover, but a
  // legacy simple scene over a video with `auto` audio resolves to
  // `native` and renders fine with the clip's own sound — disabling
  // Render for those would strand every reel built before the one-scene
  // default. An unknown capture is not blocked: the render path reports
  // that case with a better message than a disabled button can.
  const unscriptedSceneIdx = project.scenes.findIndex((scene) => {
    if (scene.scriptLine.trim().length !== 0) return false;
    if (scene.kind === "sequence") return true;
    const capture = captureMap.get(scene.captureId) ?? null;
    if (capture === null) return false;
    return (
      resolveSizzleAudioSource(scene.audioSource, capture.kind, scene.scriptLine) ===
      "voiceover"
    );
  });
  const unscriptedSceneNumber =
    unscriptedSceneIdx === -1 ? null : unscriptedSceneIdx + 1;
  const totalScenes = project.scenes.length;
  const totalClips = project.scenes.reduce(
    (n, scene) => n + (scene.kind === "sequence" ? scene.beats?.length ?? 0 : 1),
    0
  );
  const rendering = isRendering(status);
  // What the shared duration estimator knows about a scene: exact for
  // scenes previewed this session (their cached plan carries the real
  // narration timeline) or whose narration length is in the TTS cache;
  // estimated for the rest, because a voiceover scene runs as long as
  // its synthesized narration and nothing measures that short of doing
  // the TTS. The Render label AND the timeline read this one function,
  // so they can never claim different lengths for a scene.
  const durationContextFor = useCallback(
    (scene: SizzleScene): SizzleSceneDurationContext => {
      const capture = captureMap.get(scene.captureId) ?? null;
      const planDurationSec = plan.planForScene(scene)?.durationSec;
      // Narration length survives edits a PLAN doesn't: reordering or
      // retrimming clips invalidates the plan key while the narration
      // text — and so its measured length — is untouched.
      const narrationDurationSec =
        plan.cachedNarrationDurationSec(scene) ?? plan.measuredVoiceoverDurationSec(scene);
      return {
        capture: capture === null ? null : { kind: capture.kind, video: capture.video },
        sequencePlanDurationSec: planDurationSec,
        narrationDurationSec,
        voiceoverDurationSec: plan.measuredVoiceoverDurationSec(scene)
      };
    },
    // The TTS tuple is part of every measurement's cache key, so a
    // voice / model / provider switch has to re-run this — otherwise
    // the label keeps a measurement the new settings invalidated.
    [
      project.ttsProvider,
      project.ttsModel,
      project.voice,
      captureMap,
      ...plan.durationDeps
    ]
  );
  // Reel length for the Render button. `exact` drives the leading `~`.
  const reelDuration = useMemo(
    () => estimateSizzleReelDurationSec(project.scenes, durationContextFor),
    [project.scenes, durationContextFor]
  );
  // The timeline's view model: every scene a region on one project axis,
  // every clip a window on it. Resolved scenes draw the planner's windows
  // (a plan from this session, or the shared planner over cached words);
  // estimated scenes draw the idle placement on the word-count estimate.
  const timelineModel = useMemo(
    () =>
      buildTimelineModel({
        scenes: project.scenes,
        sourceFor: (scene) => ({
          plan: plan.planForScene(scene),
          words: plan.wordsForScene(scene),
          context: durationContextFor(scene)
        })
      }),
    [project.scenes, durationContextFor, ...plan.durationDeps]
  );
  // Playhead on the project axis, as (scene, seconds into that scene).
  // Follows playback while a scene previews; a scrub sets it and seeks
  // the preview of the scene under the pointer.
  const [playhead, setPlayhead] = useState<{ sceneId: string; localSec: number } | null>(null);
  // Selection is the shell's (the rail shows the inspector for it); the
  // editor's word-click / drag / select paths all go through these
  // setters. A clip and a scene are never selected together.
  const setSelectedClipId = (beatId: string | null): void => {
    onSelectClipId(beatId);
    if (beatId !== null) onSelectSceneId(null);
  };
  const selectScene = (sceneId: string | null): void => {
    onSelectSceneId(sceneId);
    if (sceneId !== null) onSelectClipId(null);
  };
  // Esc closes the inspector (deselects) — never stolen from a text field.
  useEffect(() => {
    if (selectedClipId === null && selectedSceneId === null) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || isTypingTarget(event.target)) return;
      onSelectClipId(null);
      onSelectSceneId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedClipId, selectedSceneId, onSelectClipId, onSelectSceneId]);
  const playingSceneId = plan.previewingSceneId;
  const playingTimeSec = plan.previewTimeSec;
  useEffect(() => {
    if (playingSceneId === null) return;
    setPlayhead({ sceneId: playingSceneId, localSec: playingTimeSec });
  }, [playingSceneId, playingTimeSec]);
  const playheadRegion =
    playhead === null ? null : timelineModel.scenes.find((s) => s.sceneId === playhead.sceneId) ?? null;
  const playheadSec =
    playheadRegion === null || playhead === null
      ? 0
      : Math.min(playheadRegion.endSec, playheadRegion.startSec + playhead.localSec);
  const onScrub = (sec: number): void => {
    const region = sceneAt(timelineModel, sec);
    if (region === null) return;
    const localSec = Math.max(0, Math.min(region.durationSec, sec - region.startSec));
    setPlayhead({ sceneId: region.sceneId, localSec });
    plan.seekPreview(region.sceneId, localSec);
  };
  const onSelectClip = (clip: TimelineClip | null): void => {
    if (clip === null) {
      // Bare track: nothing is selected — clip or scene.
      onSelectClipId(null);
      onSelectSceneId(null);
      return;
    }
    setSelectedClipId(clip.beatId);
  };
  // Click a word → the SELECTED clip (if it is in this scene) anchors there;
  // with nothing selected, the clip covering that moment does. Clip 0 is
  // pinned to 0 by the planner, so it is never the target. Clicking the
  // word a clip is already anchored to un-anchors it (back to auto) —
  // "pin only what you touch", and its neighbours re-flow either way.
  const onClickWord = (scene: TimelineSceneRegion, word: TimelineWord): void => {
    if (scene.kind !== "sequence") return;
    const selected = scene.clips.find((c) => c.beatId === selectedClipId) ?? null;
    const target = selected ?? clipAt(scene, word.absStartSec);
    if (target === null || target.index === 0) return;
    const timing = anchorTimingForWord(scene.words, word.index);
    const current = target.timing;
    const alreadyHere =
      current.kind === "phrase" &&
      current.phrase === timing.phrase &&
      (current.occurrence ?? 1) === (timing.occurrence ?? 1) &&
      Math.abs(current.offsetSec) < 0.0005;
    editSequenceBeat(scene.sceneId, target.beatId, {
      timing: alreadyHere ? { kind: "auto" } : timing
    });
    setSelectedClipId(target.beatId);
  };
  // The estimated region's affordance: synthesizing IS previewing the
  // scene (cache-only loads never synthesize; this is the one explicit
  // path that spends TTS credits).
  const onSynthesize = (sceneId: string): void => {
    void plan.onPreviewScene(sceneId);
  };
  // A finished clip drag: ONE scenes patch, built by the pure retime math
  // ("pin only what you touch", nearest word + residual, offset only when
  // there is no transcript). One patch per gesture is what keeps the undo
  // stack clean — the drag itself never wrote.
  const onDragCommit = (commit: TimelineDragCommit): void => {
    const scene = project.scenes.find((s) => s.id === commit.sceneId);
    const region = timelineModel.scenes.find((s) => s.sceneId === commit.sceneId);
    if (scene === undefined || region === undefined || scene.kind !== "sequence" || scene.beats === undefined) {
      return;
    }
    const next =
      commit.kind === "start"
        ? applyClipStartDrag(scene.beats, commit.index, commit.sec, {
            words: region.words,
            clipEndSec: commit.clipEndSec
          })
        : applyFinalEndDrag(scene.beats, commit.sec, {
            words: region.words,
            clipStartSec: commit.clipStartSec,
            durationSec: region.durationSec
          });
    if (next === scene.beats) return;
    editScene(scene.id, { beats: next });
    setSelectedClipId(commit.beatId);
  };
  // ── Scene operations from the scene inspector (plan PR 8) ──
  // Split at the playhead needs the scene's RESOLVED words (nothing is
  // fabricated); the region carries them along with the clips' starts.
  const onSplitAtPlayhead = (region: TimelineSceneRegion): void => {
    if (playhead === null || playhead.sceneId !== region.sceneId) return;
    const next = splitSceneAtSec(project.scenes, region.sceneId, playhead.localSec, {
      words: region.words,
      clipStartsSec: region.clips.map((c) => c.localStartSec)
    });
    if (next === project.scenes) return;
    onScenes(next);
  };
  const onMergeWithPrevious = (region: TimelineSceneRegion): void => {
    const prevRegion = timelineModel.scenes[region.index - 1];
    if (prevRegion === undefined) return;
    const next = mergeSceneIntoPrevious(project.scenes, region.sceneId, {
      prevDurationSec: prevRegion.durationSec
    });
    if (next === project.scenes) return;
    onScenes(next);
    selectScene(prevRegion.sceneId);
  };
  // Re-fit anchors (plan §4.2): explicit, scales offsets by new/old.
  const onRefit = (sceneId: string): void => {
    const scene = project.scenes.find((s) => s.id === sceneId);
    const offer = scene === undefined ? null : plan.refitOfferForScene(scene);
    if (scene === undefined || offer === null) return;
    const next = refitSceneOffsets(project.scenes, sceneId, offer.fromSec, offer.toSec);
    if (next !== project.scenes) onScenes(next);
    plan.dismissRefitOffer(sceneId);
  };
  /** What a scene's own preview stage should show: its playback time while
   *  it plays / is loaded, else the project playhead if it sits in this
   *  scene (a scrub drives the stage even before the audio is loaded). */
  const sceneCurrentTimeSec = (sceneId: string): number => {
    if (plan.previewingSceneId === sceneId || plan.previewLoadedSceneId === sceneId) {
      return plan.previewTimeSec;
    }
    return playhead !== null && playhead.sceneId === sceneId ? playhead.localSec : 0;
  };
  // Guard on the FORMATTED value, not the raw seconds: a sub-half-second
  // reel (a short trim, a small duration override) is > 0 but rounds to
  // "0:00", and `Render · 0:00` reads as broken.
  const reelDurationText = formatSizzleDuration(reelDuration.totalSec);
  const reelDurationLabel =
    reelDuration.sceneCount === 0 || reelDurationText === "0:00"
      ? null
      : `${reelDuration.exact ? "" : "~"}${reelDurationText}`;
  const [reelSettingsOpen, setReelSettingsOpen] = useState(false);

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
          {totalClips !== totalScenes ? ` · ${totalClips} clip${totalClips === 1 ? "" : "s"}` : ""}
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

      <div className={"szl__controls" + (reelSettingsOpen ? " is-open" : "")}>
        <ReelSettings
          project={project}
          open={reelSettingsOpen}
          onToggle={() => setReelSettingsOpen((v) => !v)}
          onVoice={onVoice}
          onProvider={onProvider}
          onResolution={onResolution}
        />
        <span className="szl__spacer" />
        <button className="szl__btn" onClick={onPickCapture} type="button">
          + Add scene
        </button>
      </div>

      {project.scenes.length > 0 ? (
        <SizzleTimeline
          model={timelineModel}
          captureMap={captureMap}
          audioBlobs={plan.sequenceAudioBlobs}
          playheadSec={playheadSec}
          onScrub={onScrub}
          selectedClipId={selectedClipId}
          onSelectClip={onSelectClip}
          selectedSceneId={selectedSceneId}
          onSelectScene={(sceneId) => selectScene(sceneId)}
          onClickWord={onClickWord}
          onSynthesize={onSynthesize}
          onDragCommit={onDragCommit}
        />
      ) : null}

      {/* The clip inspector, portaled into the right rail's slot (plan
          §4.6: beside the chat). Its state + handlers are the timeline's
          own — selection, model, the same edit ops — only its DOM lives
          over there. */}
      {inspectorHost !== null && selectedClipId !== null
        ? (() => {
            const region = timelineModel.scenes.find((s) => s.clips.some((c) => c.beatId === selectedClipId));
            const clip = region?.clips.find((c) => c.beatId === selectedClipId);
            const sceneRecord = region === undefined ? undefined : project.scenes.find((s) => s.id === region.sceneId);
            const beat =
              sceneRecord?.kind === "sequence" ? sceneRecord.beats?.find((b) => b.id === selectedClipId) : undefined;
            if (region === undefined || clip === undefined || sceneRecord === undefined || beat === undefined) {
              return null;
            }
            return createPortal(
              <ClipInspector
                clip={clip}
                scene={region}
                beat={beat}
                capture={captureMap.get(clip.captureId) ?? null}
                transcriptPhrases={plan.transcriptPhrasesForScene(sceneRecord)}
                onEditBeat={(patch) => editSequenceBeat(region.sceneId, clip.beatId, patch)}
                onReorder={(delta) => reorderSequenceBeat(region.sceneId, clip.index, clip.index + delta)}
                onRemove={() => {
                  removeSequenceBeat(region.sceneId, clip.beatId);
                  onSelectClipId(null);
                }}
                onClose={() => onSelectClipId(null)}
              />,
              inspectorHost
            );
          })()
        : null}
      {inspectorHost !== null && selectedSceneId !== null
        ? (() => {
            const region = timelineModel.scenes.find((s) => s.sceneId === selectedSceneId);
            const sceneRecord = project.scenes.find((s) => s.id === selectedSceneId);
            if (region === undefined || sceneRecord === undefined) return null;
            const prev = region.index > 0 ? project.scenes[region.index - 1] : undefined;
            return createPortal(
              <SceneInspector
                scene={sceneRecord}
                region={region}
                sceneCount={project.scenes.length}
                playheadLocalSec={
                  playhead !== null && playhead.sceneId === region.sceneId ? playhead.localSec : null
                }
                canMergeWithPrevious={
                  prev !== undefined && prev.kind === "sequence" && sceneRecord.kind === "sequence"
                }
                refit={plan.refitOfferForScene(sceneRecord)}
                onEditScene={(patch) => editScene(sceneRecord.id, patch)}
                onMoveScene={(delta) => moveScene(region.index, delta)}
                onSplitAtPlayhead={() => onSplitAtPlayhead(region)}
                onMergeWithPrevious={() => onMergeWithPrevious(region)}
                onSplitIntoScenes={() => splitIntoScenes(sceneRecord.id)}
                onRefit={() => onRefit(sceneRecord.id)}
                onDismissRefit={() => plan.dismissRefitOffer(sceneRecord.id)}
                onSynthesize={() => void plan.onPreviewScene(sceneRecord.id)}
                onRemoveScene={() => {
                  removeScene(sceneRecord.id);
                  onSelectSceneId(null);
                }}
                onClose={() => onSelectSceneId(null)}
              />,
              inspectorHost
            );
          })()
        : null}

      <ul className="szl__scenes">
        {project.scenes.length === 0 ? (
          <li className="szl__scene-empty">
            No scenes yet. Click <strong>Add scene</strong> to pick captures
            from your Library.
          </li>
        ) : (
          project.scenes.flatMap((scene, idx) => {
            const elements: ReactElement[] = [];
            // Transition chip between scenes (skip before the first).
            if (idx > 0) {
              elements.push(
                <SceneTransitionChip
                  key={`tr-${scene.id}`}
                  scene={scene}
                  idx={idx}
                  onEditScene={(patch) => editScene(scene.id, patch)}
                />
              );
            }
            if (scene.kind === "sequence") {
              elements.push(
                <SequenceSceneCard
                  key={scene.id}
                  scene={scene}
                  idx={idx}
                  sceneCount={project.scenes.length}
                  captureMap={captureMap}
                  plan={plan.planForScene(scene)}
                  audioBlob={plan.sequenceAudioBlobs[scene.id]}
                  currentTimeSec={sceneCurrentTimeSec(scene.id)}
                  playing={plan.previewingSceneId === scene.id}
                  loading={plan.previewLoadingSceneId === scene.id}
                  onEditScene={(patch) => editScene(scene.id, patch)}
                  onPickSequenceBeat={() => onPickSequenceBeat(scene.id)}
                  onSplitIntoScenes={() => splitIntoScenes(scene.id)}
                  onMoveScene={(delta) => moveScene(idx, delta)}
                  onRemoveScene={() => removeScene(scene.id)}
                  onPreviewScene={() => void plan.onPreviewScene(scene.id)}
                  onSeekPreview={(timeSec) => plan.seekPreview(scene.id, timeSec)}
                />
              );
              return elements;
            }
            const capture = captureMap.get(scene.captureId) ?? null;
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
              plan.previewLoadingSceneId === scene.id ||
              effectiveAudio === "muted" ||
              (effectiveAudio === "voiceover" && scene.scriptLine.trim().length === 0);
            const previewTitle = previewDisabled
              ? effectiveAudio === "muted"
                ? "This scene is muted"
                : "Write a script line to preview"
              : plan.previewingSceneId === scene.id
                ? "Stop preview"
                : effectiveAudio === "native"
                  ? "Preview native video audio"
                  : "Preview voiceover";
            elements.push(
              <SimpleSceneCard
                key={scene.id}
                scene={scene}
                idx={idx}
                sceneCount={project.scenes.length}
                capture={capture}
                effectiveAudio={effectiveAudio}
                previewDisabled={previewDisabled}
                previewTitle={previewTitle}
                previewLoading={plan.previewLoadingSceneId === scene.id}
                previewing={plan.previewingSceneId === scene.id}
                measuredVoiceoverDurationSec={plan.measuredVoiceoverDurationSec(scene)}
                onEditScene={(patch) => editScene(scene.id, patch)}
                onConvertToSequence={() => convertToSequence(scene.id)}
                onPreviewScene={() => void plan.onPreviewScene(scene.id)}
                onMoveScene={(delta) => moveScene(idx, delta)}
                onRemoveScene={() => removeScene(scene.id)}
              />
            );
            return elements;
          })
        )}
      </ul>

      {plan.previewError !== null ? (
        <div className="szl__preview-error">{plan.previewError}</div>
      ) : null}
      <audio ref={plan.audioRef} {...plan.audioElementProps} style={{ display: "none" }} />

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
          disabled={rendering || project.scenes.length === 0 || unscriptedSceneNumber !== null}
          title={
            unscriptedSceneNumber !== null
              ? `Scene ${unscriptedSceneNumber} has no narration — a scene is one voiceover over its clips, so it needs a script before the reel can render.`
              : reelDurationLabel !== null && !reelDuration.exact
                ? "Approximate length. A scene runs as long as its narration, and narration length isn't known until it's synthesized — so scenes with no synthesized narration yet are estimated from their word count."
                : undefined
          }
          data-testid="sizzle-render"
        >
          {rendering
            ? `Rendering… ${Math.round(status.ratio * 100)}%`
            : reelDurationLabel === null
              ? "Render"
              : `Render · ${reelDurationLabel}`}
        </button>
      </footer>
    </div>
  );
}
