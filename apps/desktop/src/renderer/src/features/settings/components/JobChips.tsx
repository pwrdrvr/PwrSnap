import type { ReactElement } from "react";
import { AI_SURFACE_SHORT_LABELS, type JobRunner } from "../ai-provider-status";

/** The jobs one provider runs, as chips on its AI Providers row — so an
 *  installed provider that nothing uses reads as idle without a trip to AI
 *  Features. Nothing renders for a provider with no jobs. */
export function JobChips({
  runners,
  sub
}: {
  runners: readonly JobRunner[];
  sub: string;
}): ReactElement | null {
  const mine = runners.filter((runner) => runner.sub === sub);
  if (mine.length === 0) return null;
  return (
    <span className="pss__job-chips">
      {mine.map((runner) => (
        <span
          key={`${runner.surface}:${runner.role}`}
          className={"pss__job-chip" + (runner.role === "fallback" ? " is-fallback" : "")}
        >
          {runner.role === "fallback" ? "Caption fallback" : AI_SURFACE_SHORT_LABELS[runner.surface]}
        </span>
      ))}
    </span>
  );
}
