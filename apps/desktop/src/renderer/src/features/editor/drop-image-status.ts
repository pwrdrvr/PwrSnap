import type { DropImageProgress, DropImageSummary } from "./useDropImage";

export function formatDropProgress(progress: DropImageProgress): string {
  const current = Math.min(progress.processedCount + 1, progress.attemptedCount);
  const droppedSuffix =
    progress.requestedCount > progress.attemptedCount
      ? ` · ${progress.requestedCount} dropped`
      : "";
  return (
    `Importing ${current} of ${progress.attemptedCount}` +
    ` · ${progress.importedCount} imported` +
    ` · ${progress.failedCount} failed${droppedSuffix}`
  );
}

export function formatDropSummary(
  summary: DropImageSummary,
  formatError: (error: { code: string; message: string }) => string
): string {
  const importedCount = summary.importedLayerIds.length;
  if (
    importedCount === summary.requestedCount &&
    summary.failures.length === 0 &&
    summary.truncatedCount === 0
  ) {
    return `Imported ${importedCount} images`;
  }

  const details: string[] = [];
  if (summary.failures.length > 0) {
    const errorCounts = new Map<string, number>();
    for (const failure of summary.failures) {
      const label = formatError(failure.error);
      errorCounts.set(label, (errorCounts.get(label) ?? 0) + 1);
    }
    const errors = Array.from(errorCounts, ([label, count]) =>
      count === 1 ? label : `${label} (${count})`
    );
    details.push(`${summary.failures.length} failed: ${errors.join("; ")}`);
  }
  if (summary.truncatedCount > 0) {
    details.push(
      `${summary.truncatedCount} not attempted (${summary.attemptedCount}-file limit)`
    );
  }
  return `Imported ${importedCount} of ${summary.requestedCount} images · ${details.join(" · ")}`;
}
