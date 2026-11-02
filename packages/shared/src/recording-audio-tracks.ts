/**
 * Which recorded audio tracks a consumer should use, and whether a player
 * can hear them without help.
 *
 * Lives in shared because BOTH sides need the same answer for different
 * reasons: main uses it to decide what to map into an export or a prepared
 * rendition, and every renderer that mounts a `<video>` uses it to decide
 * whether asking `video:playback` is worth a round trip at all. That verb
 * can spawn a source-sized remux, so a surface that cannot possibly need
 * one must be able to tell without dispatching.
 *
 * Pure over the four booleans already carried on `VideoCaptureMetadata`,
 * so the renderer answers from the record it already has.
 */

import type { VideoExportAudio } from "./protocol";

/**
 * The recorded-source facts these functions read. Structurally the subset
 * of `RecordingAudioSource` (main) and `VideoCaptureMetadata` (shared)
 * that describes tracks, so either satisfies it without adaptation.
 */
export type RecordedAudioTrackFacts = {
  /** Samples actually landed for the source. Decides whether to USE a track. */
  hasSystemAudio: boolean;
  hasMicrophoneAudio: boolean;
  /**
   * A writer input was ADDED for the source. Decides which INDEX a track has.
   *
   * Optional because recordings written before migration 0033 have no such
   * column; for those, `hasX` is the only evidence a track exists and is used
   * as the fallback (see `selectedRecordingAudioStreams`).
   */
  requestedSystemAudio?: boolean | undefined;
  requestedMicrophone?: boolean | undefined;
};

/**
 * Recorder order is system first, mic second; mic-only uses audio index 0.
 *
 * Track POSITION and track USE are two different questions and must be read
 * from two different facts. The recorder adds a writer input when a source is
 * ARMED (main.swift `writer.add(ai)` / `writer.add(mi)`), so that is what
 * decides the index; `hasX` only records whether samples later landed, and a
 * source that was armed and stayed silent still occupies its slot. Reading the
 * index off `hasX` shifted the microphone to 0 whenever system audio was armed
 * but quiet, so the export mapped the empty system track and dropped the voice.
 *
 * `requestedX` is absent on recordings older than migration 0033; there `hasX`
 * is the only evidence a track exists, which is exactly the pre-0033 behavior.
 */
export function selectedRecordingAudioStreams(
  source: RecordedAudioTrackFacts,
  audio: VideoExportAudio = { includeSystemAudio: true, includeMicrophone: true },
  availableTracks?: number
): number[] {
  const systemArmed = source.requestedSystemAudio === true || source.hasSystemAudio;
  const micArmed = source.requestedMicrophone === true || source.hasMicrophoneAudio;
  const claimedTracks = (systemArmed ? 1 : 0) + (micArmed ? 1 : 0);
  // Stale metadata: the file holds fewer audio tracks than the arm record
  // claims, so the recorder that wrote it did not add an input per armed
  // source (a pre-0033 recording, or one whose setup failed after the flag
  // was persisted). Position by which source actually carried samples
  // instead — the pre-0033 rule, and the only evidence left. Out-of-range
  // indices are still dropped by the caller's `index < available` filter;
  // this decides the index BEFORE that, so a stale claim relocates the
  // microphone rather than deleting it.
  const trustArmedLayout = availableTracks === undefined || availableTracks >= claimedTracks;
  const systemOccupiesFirstSlot = trustArmedLayout ? systemArmed : source.hasSystemAudio;
  const streams: number[] = [];
  if (source.hasSystemAudio && audio.includeSystemAudio) streams.push(0);
  if (source.hasMicrophoneAudio && audio.includeMicrophone) {
    streams.push(systemOccupiesFirstSlot ? 1 : 0);
  }
  return streams;
}

/**
 * Whether a player needs a prepared rendition to hear this recording.
 *
 * `<video>` plays exactly ONE audio track and ignores the rest, so the
 * original file is fine in exactly two cases: the audible audio already
 * occupies the slot the player will take, or there is no audible audio at
 * all. Everything else needs a rendition, and that covers two distinct
 * shapes:
 *
 *   both sources audible  → they must be MIXED, or one is lost
 *   only track 1 audible  → it must be SELECTED, or the player takes the
 *                           silent track 0 and the recording seems mute
 *
 * That second shape is the common one — system audio armed with nothing
 * playing through it, so a silent track sits in front of a good microphone.
 *
 * Which slot the player takes is measured, not assumed: Chromium picks the
 * track carrying the MP4 `track_enabled` flag (ffmpeg's
 * `disposition:default`), falling back to the first when several carry it —
 * and AVAssetWriter marks every track it writes enabled, so in practice
 * that is track 0. See `docs/solutions/2026-09-12-video-playback-audio-track-selection.md`.
 */
export function videoPlaybackNeedsPreparation(
  source: RecordedAudioTrackFacts,
  availableTracks?: number
): boolean {
  // Drop indices the file does not actually have BEFORE deciding. Metadata
  // claiming two sources over a single-track file resolves to "track 0 is
  // all there is", which needs no rendition — deciding first and filtering
  // afterwards would remux a file in order to produce what it already was.
  const streams = selectedRecordingAudioStreams(source, undefined, availableTracks).filter(
    (index) => availableTracks === undefined || index < availableTracks
  );
  if (streams.length === 0) return false;
  return !(streams.length === 1 && streams[0] === 0);
}
