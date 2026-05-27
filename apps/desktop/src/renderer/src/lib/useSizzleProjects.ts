import { useEffect, useState } from "react";
import { EVENT_CHANNELS, type SizzleProject } from "@pwrsnap/shared";
import { dispatch, subscribe } from "./pwrsnap";

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
      // Defensive against tests that don't stub `sizzle:list` —
      // a missing `value` should leave us at `[]`, not crash. Same
      // shape-check on the broadcast handler below.
      if (
        r.ok &&
        typeof r.value === "object" &&
        r.value !== null &&
        Array.isArray((r.value as { projects?: unknown }).projects)
      ) {
        setProjects((r.value as { projects: SizzleProject[] }).projects);
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
          setProjects((payload as { projects: SizzleProject[] }).projects);
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
