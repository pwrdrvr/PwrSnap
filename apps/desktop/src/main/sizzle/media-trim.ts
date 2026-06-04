import type { SizzleMediaTrim } from "@pwrsnap/shared";

export function normalizeVideoMediaTrim(args: {
  trim: SizzleMediaTrim | null;
  defaultRange: { start: number; end: number };
  sourceDurationSec: number;
}): SizzleMediaTrim {
  const sourceDurationSec = Math.max(0.05, args.sourceDurationSec);
  const raw = args.trim ?? {
    startSec: args.defaultRange.start,
    endSec: args.defaultRange.end
  };
  const rawStart = Number.isFinite(raw.startSec) ? raw.startSec : args.defaultRange.start;
  const rawEnd = Number.isFinite(raw.endSec) ? raw.endSec : args.defaultRange.end;
  const latestStart = Math.max(0, sourceDurationSec - 0.05);
  const startSec = clamp(rawStart, 0, latestStart);
  const endSec = clamp(rawEnd, startSec + 0.05, sourceDurationSec);
  return {
    startSec: roundSec(startSec),
    endSec: roundSec(endSec)
  };
}

export function mediaTrimWasClamped(
  requested: SizzleMediaTrim | null,
  normalized: SizzleMediaTrim
): boolean {
  return (
    requested !== null &&
    (normalized.startSec !== requested.startSec || normalized.endSec !== requested.endSec)
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundSec(value: number): number {
  return Math.round(value * 1000) / 1000;
}
