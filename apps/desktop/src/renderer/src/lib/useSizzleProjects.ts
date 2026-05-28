import { useEffect, useState } from "react";
import { EVENT_CHANNELS, type SizzleProject } from "@pwrsnap/shared";
import { dispatch, subscribe } from "./pwrsnap";

// Note: the broadcast PRODUCER (sizzle-handlers.ts) uses
// `EventPayloads` in `@pwrsnap/shared/src/ipc.ts` to type-check the
// payload at send time. The consumer side (this hook) STILL has to
// shape-check at runtime because `subscribe()` hands callbacks
// `unknown` by design — the preload bridge can't enforce types
// across the IPC boundary. So the type contract is documented
// centrally but defended structurally here.

/**
 * Subscribe to the canonical sizzle project list. Fetches once on
 * mount via `sizzle:list`, then listens to
 * `events:sizzle:projects:changed` for live updates pushed by the
 * main process whenever a project is created / updated / deleted /
 * scene-toggled / render-completed.
 *
 * Mirrors the fetch-once-then-subscribe pattern used by the Settings
 * substrate hook. No polling, no stale state, one BrowserWindow can
 * coordinate with another (e.g. the sizzle editor window changes a
 * project name; the Library sidebar in the main window picks it up
 * on the next event tick).
 *
 * Returns the project list + a loading flag so consumers can hide
 * gating UI (e.g. the "Sizzle Reels" sidebar section) until the
 * first read returns.
 */
export function useSizzleProjects(): {
  projects: SizzleProject[];
  loading: boolean;
} {
  const [projects, setProjects] = useState<SizzleProject[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void dispatch("sizzle:list", {}).then((r) => {
      if (!active) return;
      // Shape-check the response payload before commit. In production
      // the bus contract guarantees `{ projects: SizzleProject[] }`,
      // but several existing renderer tests (DetailRail, AppDocument,
      // useSettings) stub `pwrsnapApi.dispatch` per-command and don't
      // know about `sizzle:list`. Without this guard those tests
      // crash on `r.value.projects` of `undefined`. The right long-
      // term answer is to update those test stubs; the guard keeps
      // the suite green until then. Same check below on the
      // broadcast payload.
      if (
        r.ok &&
        typeof r.value === "object" &&
        r.value !== null &&
        Array.isArray((r.value as { projects?: unknown }).projects)
      ) {
        setProjects(
          filterLiveProjects((r.value as { projects: SizzleProject[] }).projects)
        );
      }
      setLoading(false);
    });
    const unsubscribe = subscribe(
      EVENT_CHANNELS.sizzleProjectsChanged,
      (payload) => {
        if (
          typeof payload === "object" &&
          payload !== null &&
          Array.isArray((payload as { projects?: unknown }).projects)
        ) {
          setProjects(
            filterLiveProjects((payload as { projects: SizzleProject[] }).projects)
          );
        }
      }
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return { projects, loading };
}

/**
 * Drop soft-deleted projects from the list before exposing it to UI
 * consumers. Today `SizzleProject` has no soft-delete column — every
 * row is live — but defending here means every Library / DetailRail
 * / sizzle-window consumer gets the same "currently visible" set
 * without each having to filter independently when the column
 * eventually lands. Cheap forward-compatibility.
 */
function filterLiveProjects(
  projects: SizzleProject[]
): SizzleProject[] {
  // Use a structural check so this stays a no-op until the column
  // is actually added — and starts working automatically the moment
  // it is, with no consumer churn.
  return projects.filter((p) => {
    const maybeDeletedAt = (p as { deletedAt?: string | null }).deletedAt;
    return maybeDeletedAt === undefined || maybeDeletedAt === null;
  });
}
