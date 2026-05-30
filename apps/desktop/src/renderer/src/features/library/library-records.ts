import type { CaptureRecord } from "@pwrsnap/shared";

export function mergeOpenedLiveRecords(
  records: readonly CaptureRecord[],
  openedRecords: readonly CaptureRecord[]
): CaptureRecord[] {
  const byId = new Map<string, CaptureRecord>();
  const fetchedIds = new Set<string>();

  for (const record of records) {
    fetchedIds.add(record.id);
    if (record.deleted_at === null) byId.set(record.id, record);
  }

  for (const record of openedRecords) {
    if (record.deleted_at === null && !fetchedIds.has(record.id)) {
      byId.set(record.id, record);
    }
  }

  return Array.from(byId.values());
}
