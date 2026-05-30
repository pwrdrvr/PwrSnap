import type { SizzleVideoFitPolicy } from "@pwrsnap/shared";

export type VideoFitRenderMode = "trim" | "freeze-end" | "loop" | "speed-to-fit";

export type VideoFitDecision = {
  requested: SizzleVideoFitPolicy;
  selected: SizzleVideoFitPolicy;
  renderMode: VideoFitRenderMode;
  sourceDurationSec: number;
  targetDurationSec: number;
  inputDurationSec: number;
  playbackRate: number;
  warnings: string[];
};

const MIN_RATE = 0.5;
const MAX_RATE = 2.0;
const SMART_MIN_RATE = 0.75;
const SMART_MAX_RATE = 1.35;
const MAX_LOOP_REPEATS = 8;

export function resolveVideoFit(args: {
  policy: SizzleVideoFitPolicy;
  sourceDurationSec: number;
  targetDurationSec: number;
}): VideoFitDecision {
  const source = Math.max(0, args.sourceDurationSec);
  const target = Math.max(0.05, args.targetDurationSec);
  const warnings: string[] = [];
  if (source <= 0.05) {
    return {
      requested: args.policy,
      selected: "freeze-end",
      renderMode: "freeze-end",
      sourceDurationSec: source,
      targetDurationSec: target,
      inputDurationSec: 0.05,
      playbackRate: 1,
      warnings: ["Video source duration is too short; using freeze-end"]
    };
  }

  if (args.policy === "smart-fit") {
    const rate = source / target;
    if (rate >= SMART_MIN_RATE && rate <= SMART_MAX_RATE) {
      return speedDecision(args.policy, "speed-to-fit", source, target, rate, warnings);
    }
    if (source < target && Math.ceil(target / source) - 1 <= MAX_LOOP_REPEATS) {
      return loopDecision(args.policy, "loop", source, target, warnings);
    }
    warnings.push("Smart fit fell back to freeze-end");
    return freezeDecision(args.policy, "freeze-end", source, target, warnings);
  }

  if (args.policy === "speed-to-fit") {
    const rate = source / target;
    if (rate < MIN_RATE || rate > MAX_RATE) {
      warnings.push("Requested speed-to-fit would exceed rate limits; using freeze-end");
      return freezeDecision(args.policy, "freeze-end", source, target, warnings);
    }
    return speedDecision(args.policy, "speed-to-fit", source, target, rate, warnings);
  }

  if (args.policy === "loop" || args.policy === "ping-pong") {
    if (source >= target) {
      warnings.push("Loop requested but source is already long enough; trimming instead");
      return trimDecision(args.policy, "trim", source, target, warnings);
    }
    const repeats = Math.ceil(target / source) - 1;
    if (repeats > MAX_LOOP_REPEATS) {
      warnings.push("Requested loop would repeat too many times; using freeze-end");
      return freezeDecision(args.policy, "freeze-end", source, target, warnings);
    }
    return loopDecision(args.policy, args.policy, source, target, warnings);
  }

  if (args.policy === "trim") {
    if (source < target) {
      warnings.push("Trim requested but source is shorter than target; using freeze-end");
      return freezeDecision(args.policy, "freeze-end", source, target, warnings);
    }
    return trimDecision(args.policy, "trim", source, target, warnings);
  }

  return freezeDecision(args.policy, "freeze-end", source, target, warnings);
}

function trimDecision(
  requested: SizzleVideoFitPolicy,
  selected: SizzleVideoFitPolicy,
  source: number,
  target: number,
  warnings: string[]
): VideoFitDecision {
  return {
    requested,
    selected,
    renderMode: "trim",
    sourceDurationSec: source,
    targetDurationSec: target,
    inputDurationSec: Math.min(source, target),
    playbackRate: 1,
    warnings
  };
}

function freezeDecision(
  requested: SizzleVideoFitPolicy,
  selected: SizzleVideoFitPolicy,
  source: number,
  target: number,
  warnings: string[]
): VideoFitDecision {
  return {
    requested,
    selected,
    renderMode: "freeze-end",
    sourceDurationSec: source,
    targetDurationSec: target,
    inputDurationSec: Math.min(source, target),
    playbackRate: 1,
    warnings
  };
}

function loopDecision(
  requested: SizzleVideoFitPolicy,
  selected: SizzleVideoFitPolicy,
  source: number,
  target: number,
  warnings: string[]
): VideoFitDecision {
  return {
    requested,
    selected,
    renderMode: "loop",
    sourceDurationSec: source,
    targetDurationSec: target,
    inputDurationSec: source,
    playbackRate: 1,
    warnings
  };
}

function speedDecision(
  requested: SizzleVideoFitPolicy,
  selected: SizzleVideoFitPolicy,
  source: number,
  target: number,
  playbackRate: number,
  warnings: string[]
): VideoFitDecision {
  return {
    requested,
    selected,
    renderMode: "speed-to-fit",
    sourceDurationSec: source,
    targetDurationSec: target,
    inputDurationSec: source,
    playbackRate,
    warnings
  };
}
