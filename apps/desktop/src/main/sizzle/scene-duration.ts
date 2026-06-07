const VOICEOVER_TAIL_PAD_SEC = 0.35;

export function resolveVoiceoverSceneDurationSec(args: {
  durationOverrideSec: number | null;
  voiceoverDurationSec: number;
  defaultVisualDurationSec: number;
}): number {
  const minNarrationDurationSec = args.voiceoverDurationSec + VOICEOVER_TAIL_PAD_SEC;
  if (args.durationOverrideSec !== null && args.durationOverrideSec > 0) {
    return Math.max(args.durationOverrideSec, minNarrationDurationSec);
  }
  return Math.max(args.defaultVisualDurationSec, minNarrationDurationSec);
}
