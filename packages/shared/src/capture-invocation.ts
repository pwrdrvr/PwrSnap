import type { CaptureInvocation, CaptureInvocationOrigin } from "./protocol";

export const CAPTURE_INVOCATION_ORIGINS = [
  "global_hotkey.quick_capture",
  "global_hotkey.region",
  "global_hotkey.window",
  "global_hotkey.timed",
  "library.quick_capture",
  "tray.quick_capture",
  "tray.region",
  "tray.window",
  "tray.timed",
  "native_tray_menu.quick_capture"
] as const satisfies readonly CaptureInvocationOrigin[];

const originSet = new Set<string>(CAPTURE_INVOCATION_ORIGINS);

export type CaptureInvocationTrigger = Omit<CaptureInvocation, "dispatchMonotonicMs">;

type CreateCaptureInvocationArgs = {
  id: string;
  origin: CaptureInvocationOrigin;
  monotonicNow: () => number;
  wallNow?: () => string;
};

export function createCaptureInvocationTrigger(
  args: CreateCaptureInvocationArgs
): CaptureInvocationTrigger {
  const triggerMonotonicMs = args.monotonicNow();
  const triggerWallTime = (args.wallNow ?? (() => new Date().toISOString()))();
  return {
    id: args.id,
    origin: args.origin,
    triggerMonotonicMs,
    triggerWallTime
  };
}

export function finalizeCaptureInvocation(
  trigger: CaptureInvocationTrigger,
  monotonicNow: () => number
): CaptureInvocation {
  return {
    ...trigger,
    dispatchMonotonicMs: Math.max(trigger.triggerMonotonicMs, monotonicNow())
  };
}

export function createCaptureInvocation(
  args: CreateCaptureInvocationArgs
): CaptureInvocation {
  return finalizeCaptureInvocation(
    createCaptureInvocationTrigger(args),
    args.monotonicNow
  );
}

export function isCaptureInvocation(value: unknown): value is CaptureInvocation {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CaptureInvocation>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length >= 8 &&
    candidate.id.length <= 128 &&
    typeof candidate.origin === "string" &&
    originSet.has(candidate.origin) &&
    typeof candidate.triggerMonotonicMs === "number" &&
    Number.isFinite(candidate.triggerMonotonicMs) &&
    candidate.triggerMonotonicMs >= 0 &&
    typeof candidate.dispatchMonotonicMs === "number" &&
    Number.isFinite(candidate.dispatchMonotonicMs) &&
    candidate.dispatchMonotonicMs >= candidate.triggerMonotonicMs &&
    typeof candidate.triggerWallTime === "string" &&
    Number.isFinite(Date.parse(candidate.triggerWallTime))
  );
}
