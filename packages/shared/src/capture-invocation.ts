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

export function createCaptureInvocation(args: {
  id: string;
  origin: CaptureInvocationOrigin;
  monotonicNow: () => number;
  wallNow?: () => string;
}): CaptureInvocation {
  const monotonicNow = args.monotonicNow;
  const triggerMonotonicMs = monotonicNow();
  const triggerWallTime = (args.wallNow ?? (() => new Date().toISOString()))();
  const dispatchMonotonicMs = Math.max(triggerMonotonicMs, monotonicNow());
  return {
    id: args.id,
    origin: args.origin,
    triggerMonotonicMs,
    dispatchMonotonicMs,
    triggerWallTime
  };
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
