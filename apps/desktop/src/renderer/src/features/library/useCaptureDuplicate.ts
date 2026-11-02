// Duplicate / Edit a Copy, and duplicate families, for the Library.
//
// Two hooks, so Library.tsx only wires them:
//
//   useCaptureDuplicate   what a snap's edits are (so the menus only ask
//                         "With Edits or Base Image Only?" when there is a
//                         choice), the remembered choice per kind, and the
//                         action itself.
//   useCaptureFamilies    every family's live size (the ⧉ N glyph) and the
//                         list behind the Family tab, kept fresh from
//                         `events:families:changed`.
//
// Neither hook listens to `events:captures:changed`. That fires on every
// annotation edit, and an edit never changes a family; main raises the
// families event only when a copy is made or a member is trashed,
// restored or purged.
//
// A plain Duplicate never moves the user: no selection change, no scroll.
// The copy lands at the top of the grid (captured_at = now) and the glyph
// on the original tells them it worked. Edit a Copy is the exception — it
// opens the copy, because opening it is the point.
//
// A video that main could not clone comes back as a background JOB, not a
// record (see `capture:duplicate`). `useCaptureDuplicate` also tracks those:
// it subscribes to `events:capture-duplicate:job`, then asks
// `capture:duplicateJobs` for any that started before this window mounted
// (subscribe first, so nothing ends in the gap). A job's source is busy
// until it ends — the Duplicate button and ⇧⌘D refuse a second copy — and
// Edit a Copy opens the copy when the job reaches `done`.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DUPLICATE_IN_PROGRESS_MESSAGE,
  EVENT_CHANNELS,
  acceleratorToDisplayText,
  isTerminalDuplicateJob,
  summarizeVideoEdits,
  type CaptureDuplicateJob,
  type CaptureEditSummary,
  type CaptureFamilySummary,
  type CaptureRecord,
  type LibraryDuplicateWithEditsSettings,
  type Settings,
  type SettingsChangedEvent
} from "@pwrsnap/shared";

import { dispatch, subscribe } from "../../lib/pwrsnap";
import { rendererShortcutPlatform } from "../../lib/shortcut-platform";
import { createDuplicateJobStore, type DuplicateJobStore } from "./duplicate-job-store";

export type DuplicateMode = "duplicate" | "edit-copy";

/** File ▸ Duplicate Snap's accelerator (main/index.ts), for labels. */
const DUPLICATE_ACCELERATOR = "CommandOrControl+Shift+D";

/** "⇧⌘D" on macOS, "Ctrl+Shift+D" elsewhere. */
export function duplicateShortcutLabel(): string {
  return acceleratorToDisplayText(DUPLICATE_ACCELERATOR, rendererShortcutPlatform());
}

const DEFAULT_PREFS: LibraryDuplicateWithEditsSettings = { image: true, video: true };

/** What a "with edits" copy of `record` would carry. Videos answer from
 *  the record; images ask main, which owns the layer tree. `null` when the
 *  question could not be answered — callers then offer the choice. */
export async function captureEditSummaryFor(
  record: CaptureRecord
): Promise<CaptureEditSummary | null> {
  if (record.kind === "video") {
    if (record.video === null || record.video === undefined) return null;
    return summarizeVideoEdits(record.video);
  }
  const result = await dispatch("capture:editSummary", { captureId: record.id });
  return result.ok ? result.value ?? null : null;
}

/** Words for the two choices, by kind. */
export function duplicateChoiceLabels(kind: CaptureRecord["kind"]): {
  withEdits: string;
  baseOnly: string;
} {
  return kind === "video"
    ? { withEdits: "With Trim and Cuts", baseOnly: "Full Recording" }
    : { withEdits: "With Edits", baseOnly: "Base Image Only" };
}

/** Terminal jobs remembered so a late `capture:duplicate` answer or
 *  `capture:duplicateJobs` read cannot bring an ended job back. */
const ENDED_JOBS_KEPT = 64;

export function useCaptureDuplicate({
  onError
}: {
  onError: (message: string) => void;
}): {
  prefs: LibraryDuplicateWithEditsSettings;
  duplicate: (
    record: CaptureRecord,
    options: { withEdits: boolean; mode: DuplicateMode; remember?: boolean }
  ) => Promise<CaptureRecord | null>;
  /** Background video copies still running, by SOURCE capture id.
   *  Stable identity; read it with `useSyncExternalStore`, never into
   *  Library state (see duplicate-job-store.ts). */
  jobStore: DuplicateJobStore;
  cancelJob: (jobId: string) => void;
} {
  const [prefs, setPrefs] = useState<LibraryDuplicateWithEditsSettings>(DEFAULT_PREFS);
  useEffect(() => {
    let cancelled = false;
    void dispatch("settings:read", {}).then((result) => {
      if (cancelled || !result.ok) return;
      setPrefs((result.value as Settings).library.duplicateWithEdits ?? DEFAULT_PREFS);
    });
    const unsubscribe = subscribe(EVENT_CHANNELS.settingsChanged, (payload) => {
      const next = (payload as SettingsChangedEvent).settings.library.duplicateWithEdits;
      if (next !== undefined) setPrefs(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // ---- background jobs ----
  const [jobStore] = useState(createDuplicateJobStore);
  const endedRef = useRef(new Map<string, CaptureDuplicateJob>());
  /** Jobs started here as Edit a Copy: open the copy when they finish. */
  const openOnDoneRef = useRef(new Set<string>());

  /** Edit a Copy's second half, wherever the copy finished. */
  const openCopy = useCallback(async (captureId: string): Promise<void> => {
    const opened = await dispatch("editor:open", { captureId });
    if (!opened.ok) {
      onErrorRef.current(`Made a copy, but couldn’t open it — ${opened.error.message}`);
    }
  }, []);

  const settle = useCallback(
    (job: CaptureDuplicateJob): void => {
      const ended = endedRef.current;
      if (ended.has(job.jobId)) return;
      ended.set(job.jobId, job);
      if (ended.size > ENDED_JOBS_KEPT) ended.delete(ended.keys().next().value as string);
      jobStore.remove(job);
      const wantsOpen = openOnDoneRef.current.delete(job.jobId);
      if (job.state === "failed") {
        onErrorRef.current(`Couldn’t duplicate the recording — ${job.error ?? "the copy failed."}`);
      } else if (job.state === "done" && wantsOpen) {
        void openCopy(job.captureId);
      }
    },
    [jobStore, openCopy]
  );

  /** Apply one job report, from the event, the command, or the list read. */
  const track = useCallback(
    (job: CaptureDuplicateJob): void => {
      if (isTerminalDuplicateJob(job)) {
        settle(job);
        return;
      }
      if (endedRef.current.has(job.jobId)) return;
      jobStore.upsert(job);
    },
    [jobStore, settle]
  );

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = subscribe(EVENT_CHANNELS.captureDuplicateJob, (payload) => {
      const job = (payload as { job?: CaptureDuplicateJob } | null)?.job;
      if (job !== undefined && typeof job.jobId === "string") track(job);
    });
    void dispatch("capture:duplicateJobs", {}).then((result) => {
      if (cancelled || !result.ok) return;
      for (const job of result.value?.jobs ?? []) track(job);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [track]);

  const cancelJob = useCallback((jobId: string): void => {
    void dispatch("capture:cancelDuplicate", { jobId }).then((result) => {
      if (!result.ok) onErrorRef.current(`Couldn’t cancel the copy — ${result.error.message}`);
    });
  }, []);

  const duplicate = useCallback(
    async (
      record: CaptureRecord,
      options: { withEdits: boolean; mode: DuplicateMode; remember?: boolean }
    ): Promise<CaptureRecord | null> => {
      // Main refuses this too; asking first spares the round trip and
      // says it the same way.
      if (jobStore.getSnapshot().has(record.id)) {
        onErrorRef.current(DUPLICATE_IN_PROGRESS_MESSAGE);
        return null;
      }
      if (options.remember === true) {
        const kind = record.kind === "video" ? "video" : "image";
        setPrefs((current) => ({ ...current, [kind]: options.withEdits }));
        void dispatch("settings:write", {
          library: { duplicateWithEdits: { [kind]: options.withEdits } }
        });
      }
      const result = await dispatch("capture:duplicate", {
        captureId: record.id,
        withEdits: options.withEdits
      });
      if (!result.ok) {
        onErrorRef.current(`Couldn’t duplicate the snap — ${result.error.message}`);
        return null;
      }
      const { record: copy, job } = result.value;
      if (copy === null) {
        // Copying in the background. The row appears when it is whole.
        if (options.mode === "edit-copy") {
          const ended = endedRef.current.get(job.jobId);
          if (ended === undefined) openOnDoneRef.current.add(job.jobId);
          else if (ended.state === "done") void openCopy(ended.captureId);
        }
        track(job);
        return null;
      }
      if (options.mode === "edit-copy") await openCopy(copy.id);
      return copy;
    },
    [jobStore, openCopy, track]
  );

  return { prefs, duplicate, jobStore, cancelJob };
}

export function useCaptureFamilies(): {
  families: CaptureFamilySummary[];
  /** familyId → live member count, for the tile glyph. */
  liveCountByFamily: ReadonlyMap<string, number>;
} {
  const [families, setFamilies] = useState<CaptureFamilySummary[]>([]);
  useEffect(() => {
    let seq = 0;
    const refresh = (): void => {
      const mine = ++seq;
      void dispatch("library:families", {}).then((result) => {
        if (mine !== seq || !result.ok) return;
        // An ok Result with no body reads as "no families". This runs from a
        // broadcast handler, where a throw is an unhandled rejection.
        setFamilies(result.value?.families ?? []);
      });
    };
    refresh();
    const unsubscribe = subscribe(EVENT_CHANNELS.familiesChanged, refresh);
    return () => {
      seq += 1;
      unsubscribe();
    };
  }, []);
  const liveCountByFamily = useMemo(
    () => new Map(families.map((family) => [family.familyId, family.liveCount])),
    [families]
  );
  return { families, liveCountByFamily };
}

/** A family's members, refreshed when main says THIS family changed.
 *  Trashed members are included; callers decide how to show them. The
 *  records are as of that read: an edit to a member does not refetch
 *  them, so callers that draw a thumbnail prefer a live record they
 *  already hold. `null` until the first
 *  read for this family lands — a grid filtered to it must not read
 *  "loading" as "empty" and drop the selection. */
export function useFamilyMembers(familyId: string | null): CaptureRecord[] | null {
  const [members, setMembers] = useState<{ familyId: string; rows: CaptureRecord[] } | null>(
    null
  );
  useEffect(() => {
    if (familyId === null) return;
    let seq = 0;
    const refresh = (): void => {
      const mine = ++seq;
      void dispatch("library:family", { familyId }).then((result) => {
        if (mine !== seq || !result.ok) return;
        setMembers({ familyId, rows: result.value?.members ?? [] });
      });
    };
    refresh();
    const unsubscribe = subscribe(EVENT_CHANNELS.familiesChanged, (payload) => {
      const changed = (payload as { familyIds?: unknown } | null)?.familyIds;
      if (Array.isArray(changed) && !changed.includes(familyId)) return;
      refresh();
    });
    return () => {
      seq += 1;
      unsubscribe();
    };
  }, [familyId]);
  return familyId !== null && members?.familyId === familyId ? members.rows : null;
}
