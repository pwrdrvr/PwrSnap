// The sticky "which audio tracks go into an MP4" choice behind the MP4
// row's Mic / System toggles on every video export grid (float-over,
// tray, Library grid palette, inspector rail).
//
// The choice lives in Settings (`recording.mp4IncludeMicrophone` /
// `mp4IncludeSystemAudio`), not in component state, for two reasons:
// it has to survive the toast — a user who left the mic on by accident
// turns it off once, not once per recording — and main reads the same
// fields to fill in any MP4 export that names no audio, so a keyboard
// shortcut can never ship a track the grid shows as off.
//
// Until the first `settings:read` lands the preference is `null`: the
// grid shows no toggles and exports send no `audio`, which main resolves
// from the same persisted preference. (A take with no audio skips the
// wait and sends silent.)

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import type { Settings, SettingsChangedEvent, VideoExportAudio } from "@pwrsnap/shared";
import { dispatch, subscribe } from "../../lib/pwrsnap";

export type Mp4AudioTrack = "microphone" | "systemAudio";

/** Per-track flags. As a preference: which tracks the user keeps. As
 *  `RecordedAudioTracks`: which tracks the take actually has. */
export type Mp4AudioTracks = {
  readonly microphone: boolean;
  readonly systemAudio: boolean;
};

export type RecordedAudioTracks = Mp4AudioTracks;

/** Everything the MP4 row needs to draw and flip the toggles. */
export type Mp4AudioControl = {
  readonly recorded: RecordedAudioTracks;
  /** `null` while the preference is still loading. */
  readonly kept: Mp4AudioTracks | null;
  readonly onToggle: (track: Mp4AudioTrack, keep: boolean) => void;
};

/** The export choice: tracks the take has, narrowed to the ones kept.
 *  Never names a track the take lacks, so it always passes main's
 *  `audio_track_missing` check. */
export function mp4ExportAudio(
  recorded: RecordedAudioTracks,
  kept: Mp4AudioTracks
): VideoExportAudio {
  return {
    includeMicrophone: recorded.microphone && kept.microphone,
    includeSystemAudio: recorded.systemAudio && kept.systemAudio
  };
}

/** Recorded tracks off a capture's video metadata. */
export function recordedAudioTracks(
  video: { readonly hasMicrophoneAudio: boolean; readonly hasSystemAudio: boolean } | null | undefined
): RecordedAudioTracks {
  return {
    microphone: video?.hasMicrophoneAudio === true,
    systemAudio: video?.hasSystemAudio === true
  };
}

const SILENT_MP4_AUDIO: VideoExportAudio = Object.freeze({
  includeMicrophone: false,
  includeSystemAudio: false
});

function keptFromSettings(settings: Settings | undefined): Mp4AudioTracks | null {
  const recording = settings?.recording;
  if (recording === undefined) return null;
  return {
    microphone: recording.mp4IncludeMicrophone,
    systemAudio: recording.mp4IncludeSystemAudio
  };
}

function sameTracks(a: Mp4AudioTracks, b: Mp4AudioTracks): boolean {
  return a.microphone === b.microphone && a.systemAudio === b.systemAudio;
}

type PendingWrite = { seq: number; value: Mp4AudioTracks } | null;

export function useMp4AudioPreference(): {
  readonly kept: Mp4AudioTracks | null;
  readonly setKept: (track: Mp4AudioTrack, keep: boolean) => void;
} {
  const [kept, setKeptState] = useState<Mp4AudioTracks | null>(null);
  // Mirrors `kept` for the write path, which must compose a toggle onto
  // the latest value even when two land inside one render.
  const keptRef = useRef<Mp4AudioTracks | null>(null);
  // Last value settings:read or settings:changed confirmed. A failed
  // write rolls back to it instead of leaving a session-only choice
  // that main — which exports from the persisted one — does not share.
  const confirmedRef = useRef<Mp4AudioTracks | null>(null);
  const writeSeq = useRef(0);
  const pending = useRef<PendingWrite>(null);

  const show = useCallback((next: Mp4AudioTracks | null): void => {
    keptRef.current = next;
    setKeptState(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Set by the first broadcast. A broadcast is always at least as new
    // as the read, which may have been served before that write landed.
    let broadcastSeen = false;
    const seqAtRead = writeSeq.current;
    void dispatch("settings:read", {}).then((result) => {
      if (cancelled || !result.ok || broadcastSeen) return;
      // A toggle between dispatch and resolve wins.
      if (writeSeq.current !== seqAtRead) return;
      const next = keptFromSettings(result.value as Settings | undefined);
      confirmedRef.current = next;
      show(next);
    });
    const off = subscribe(EVENT_CHANNELS.settingsChanged, (payload) => {
      const next = keptFromSettings((payload as SettingsChangedEvent).settings);
      if (next === null) return;
      broadcastSeen = true;
      // Persisted either way, so a failed write later rolls back to it
      // rather than to a value an earlier successful write replaced.
      confirmedRef.current = next;
      // A broadcast from an unrelated write queued ahead of ours carries
      // the pre-toggle value; hold the optimistic one until our own echo
      // arrives. Writes from another window apply unconditionally.
      const inFlight = pending.current;
      if (inFlight !== null) {
        if (!sameTracks(inFlight.value, next)) return;
        pending.current = null;
      }
      show(next);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [show]);

  const setKept = useCallback(
    (track: Mp4AudioTrack, keep: boolean): void => {
      const current = keptRef.current;
      if (current === null) return;
      const next: Mp4AudioTracks = { ...current, [track]: keep };
      writeSeq.current += 1;
      const seq = writeSeq.current;
      pending.current = { seq, value: next };
      show(next);
      const rollback = (): void => {
        if (pending.current?.seq !== seq) return;
        pending.current = null;
        show(confirmedRef.current);
      };
      void dispatch("settings:write", {
        recording:
          track === "microphone"
            ? { mp4IncludeMicrophone: keep }
            : { mp4IncludeSystemAudio: keep }
      }).then((result) => {
        if (!result.ok) rollback();
      }, rollback);
    },
    [show]
  );

  return { kept, setKept };
}

/**
 * The MP4 row's toggles plus the `audio` an export from that row sends,
 * for a take with `recorded` tracks. `audio` is `undefined` until the
 * preference loads (main then resolves the same persisted value).
 */
export function useMp4ExportAudio(recorded: RecordedAudioTracks): {
  readonly audio: VideoExportAudio | undefined;
  readonly control: Mp4AudioControl;
} {
  const { kept, setKept } = useMp4AudioPreference();
  const recordedMic = recorded.microphone;
  const recordedSystem = recorded.systemAudio;
  const keptMic = kept?.microphone;
  const keptSystem = kept?.systemAudio;
  const audio = useMemo<VideoExportAudio | undefined>(
    () =>
      // A take with no audio exports silent whatever the preference
      // says, so it need not wait for the read (nor re-key the grid
      // when the read lands).
      !recordedMic && !recordedSystem
        ? SILENT_MP4_AUDIO
        : keptMic === undefined || keptSystem === undefined
        ? undefined
        : mp4ExportAudio(
            { microphone: recordedMic, systemAudio: recordedSystem },
            { microphone: keptMic, systemAudio: keptSystem }
          ),
    [keptMic, keptSystem, recordedMic, recordedSystem]
  );
  const control = useMemo<Mp4AudioControl>(
    () => ({
      recorded: { microphone: recordedMic, systemAudio: recordedSystem },
      kept:
        keptMic === undefined || keptSystem === undefined
          ? null
          : { microphone: keptMic, systemAudio: keptSystem },
      onToggle: setKept
    }),
    [keptMic, keptSystem, recordedMic, recordedSystem, setKept]
  );
  return { audio, control };
}
