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
      if (r.ok) setProjects(r.value.projects);
      setLoading(false);
    });
    const unsubscribe = subscribe(
      EVENT_CHANNELS.sizzleProjectsChanged,
      (payload) => {
        // Payload shape is `{ projects: SizzleProject[] }`.
        const next = (payload as { projects: SizzleProject[] }).projects;
        if (Array.isArray(next)) setProjects(next);
      }
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return { projects, loading };
}
