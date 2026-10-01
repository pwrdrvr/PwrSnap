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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EVENT_CHANNELS,
  acceleratorToDisplayText,
  summarizeVideoEdits,
  type CaptureEditSummary,
  type CaptureFamilySummary,
  type CaptureRecord,
  type LibraryDuplicateWithEditsSettings,
  type Settings,
  type SettingsChangedEvent
} from "@pwrsnap/shared";

import { dispatch, subscribe } from "../../lib/pwrsnap";
import { rendererShortcutPlatform } from "../../lib/shortcut-platform";

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

  const duplicate = useCallback(
    async (
      record: CaptureRecord,
      options: { withEdits: boolean; mode: DuplicateMode; remember?: boolean }
    ): Promise<CaptureRecord | null> => {
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
      const copy = result.value.record;
      if (options.mode === "edit-copy") {
        const opened = await dispatch("editor:open", { captureId: copy.id });
        if (!opened.ok) {
          onErrorRef.current(`Made a copy, but couldn’t open it — ${opened.error.message}`);
        }
      }
      return copy;
    },
    []
  );

  return { prefs, duplicate };
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
