// Inspector ▸ Family: where duplicates are found again.
//
// Top: the selected snap's own family, oldest first, each copy indented
// under the snap it was copied from (`duplicated_from`), the selected one
// marked, trashed ones dimmed. Clicking a member selects it.
//
// Below: every family in the library, newest activity first. Clicking one
// filters the grid to that family.

import { useEffect, useMemo, useState, type ReactElement } from "react";
import type { CaptureEnrichment, CaptureFamilySummary, CaptureRecord } from "@pwrsnap/shared";

import { cacheUrl, captureSrcUrl, dispatch } from "../../lib/pwrsnap";
import { duplicateShortcutLabel, useFamilyMembers } from "./useCaptureDuplicate";

type Meta = { record: CaptureRecord; enrichment: CaptureEnrichment | null };

const NO_MEMBERS: readonly CaptureRecord[] = [];

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit"
});

function titleOf(record: CaptureRecord | null, enrichment: CaptureEnrichment | null): string {
  const candidates = [enrichment?.acceptedTitle, enrichment?.suggestedTitle];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  const app = record?.source_app_name;
  return typeof app === "string" && app.length > 0 ? app : "Untitled snap";
}

/** Depth of each member under the family root, following duplicated_from. */
function depthsOf(members: readonly CaptureRecord[]): Map<string, number> {
  const byId = new Map(members.map((m) => [m.id, m]));
  const depths = new Map<string, number>();
  const depthOf = (record: CaptureRecord, seen: Set<string>): number => {
    const known = depths.get(record.id);
    if (known !== undefined) return known;
    const parentId = record.duplicated_from ?? null;
    const parent = parentId === null ? undefined : byId.get(parentId);
    // A purged parent (or a cycle, which lineage cannot form) roots here.
    const depth =
      parent === undefined || seen.has(parent.id) ? 0 : depthOf(parent, seen.add(record.id)) + 1;
    depths.set(record.id, depth);
    return depth;
  };
  for (const member of members) depthOf(member, new Set());
  return depths;
}

/** Titles for a set of ids, fetched once per id set. */
function useMeta(ids: readonly string[]): ReadonlyMap<string, Meta> {
  const key = ids.join(",");
  const [meta, setMeta] = useState<{ key: string; rows: ReadonlyMap<string, Meta> }>({
    key: "",
    rows: new Map()
  });
  useEffect(() => {
    if (key.length === 0) return;
    let cancelled = false;
    void dispatch("library:listByIdsWithMetadata", { ids: key.split(",") }).then((result) => {
      if (cancelled || !result.ok) return;
      setMeta({ key, rows: new Map(result.value.rows.map((row) => [row.record.id, row])) });
    });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return meta.key === key ? meta.rows : new Map();
}

function MemberThumb({ record }: { record: CaptureRecord }): ReactElement {
  return (
    <span className="psl__family-thumb" aria-hidden="true">
      {record.kind === "video" ? (
        <video src={captureSrcUrl(record.id)} preload="metadata" muted playsInline />
      ) : (
        <img
          src={cacheUrl(record.id, 96, "webp", record.edits_version)}
          alt=""
          loading="lazy"
          decoding="async"
        />
      )}
    </span>
  );
}

export function FamilyTab({
  record,
  families,
  onSelectMember,
  onFilterFamily
}: {
  record: CaptureRecord;
  families: readonly CaptureFamilySummary[];
  onSelectMember: (captureId: string) => void;
  onFilterFamily: (familyId: string) => void;
}): ReactElement {
  const familyId = record.family_id ?? null;
  const loadedMembers = useFamilyMembers(familyId);
  const members = loadedMembers ?? NO_MEMBERS;
  // Still reading this snap's family: say nothing rather than "no copies".
  const ownLoading = familyId !== null && loadedMembers === null;
  const depths = useMemo(() => depthsOf(members), [members]);
  const coverIds = useMemo(
    () =>
      families
        .map((family) => family.coverId)
        .filter((id): id is string => id !== null),
    [families]
  );
  const ids = useMemo(
    () => [...new Set([...members.map((m) => m.id), ...coverIds])],
    [members, coverIds]
  );
  const meta = useMeta(ids);
  const ownFamily = families.find((family) => family.familyId === familyId) ?? null;

  return (
    <div className="psl__family">
      {ownLoading ? null : familyId !== null && members.length > 1 ? (
        <section aria-labelledby="psl-family-own">
          <div className="psl__family-head">
            <span id="psl-family-own" className="psl__copy-eyebrow">
              This snap’s family
            </span>
            <button
              type="button"
              className="psl__family-link"
              onClick={() => onFilterFamily(familyId)}
            >
              Show in grid
            </button>
          </div>
          <ul className="psl__family-list">
            {members.map((member) => {
              const isCurrent = member.id === record.id;
              const isTrashed = member.deleted_at !== null;
              const depth = Math.min(depths.get(member.id) ?? 0, 4);
              const row = meta.get(member.id);
              return (
                <li key={member.id}>
                  <button
                    type="button"
                    className={
                      "psl__family-row" +
                      (isCurrent ? " is-current" : "") +
                      (isTrashed ? " is-trashed" : "")
                    }
                    style={{ paddingLeft: `${8 + depth * 14}px` }}
                    aria-current={isCurrent ? "true" : undefined}
                    disabled={isTrashed}
                    onClick={() => onSelectMember(member.id)}
                  >
                    <MemberThumb record={member} />
                    <span className="psl__family-body">
                      <span className="psl__family-title">
                        {titleOf(member, row?.enrichment ?? null)}
                      </span>
                      <span className="psl__family-meta">
                        {member.duplicated_from === null || member.duplicated_from === undefined
                          ? "Original"
                          : "Copy"}
                        {" · "}
                        {dateFormatter.format(new Date(member.captured_at))}
                        {isTrashed ? " · in Trash" : ""}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : (
        <p className="psl__family-empty">
          This snap has no copies. Duplicate it ({duplicateShortcutLabel()}) to start a family.
        </p>
      )}

      <section aria-labelledby="psl-family-all">
        <div className="psl__family-head">
          <span id="psl-family-all" className="psl__copy-eyebrow">
            All families · {families.length}
          </span>
        </div>
        <ul className="psl__family-list">
          {families.map((family) => {
            const cover = family.coverId === null ? null : meta.get(family.coverId) ?? null;
            const isOwn = family.familyId === ownFamily?.familyId;
            return (
              <li key={family.familyId}>
                <button
                  type="button"
                  className={"psl__family-row" + (isOwn ? " is-current" : "")}
                  onClick={() => onFilterFamily(family.familyId)}
                  title="Show this family in the grid"
                >
                  {cover !== null ? (
                    <MemberThumb record={cover.record} />
                  ) : (
                    <span className="psl__family-thumb" aria-hidden="true" />
                  )}
                  <span className="psl__family-body">
                    <span className="psl__family-title">
                      {titleOf(cover?.record ?? null, cover?.enrichment ?? null)}
                    </span>
                    <span className="psl__family-meta">
                      {family.liveCount} snap{family.liveCount === 1 ? "" : "s"}
                      {family.trashedCount > 0 ? ` · ${family.trashedCount} in Trash` : ""}
                    </span>
                  </span>
                  <span className="psl__family-count" aria-hidden="true">
                    ⧉ {family.liveCount}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
