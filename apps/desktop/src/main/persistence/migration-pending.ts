// Pure migration-file helpers shared by the migration runner and the
// read-only `migrations: "verify"` open path (two-process split, plan
// 2026-06-12-001 §D6: the library process never migrates — it lists
// pending files and fails closed). Electron-free so tests run plain.

export const MIGRATION_FILE_PATTERN = /^\d{4}_.+\.sql$/;

export function migrationVersionOf(file: string): number | null {
  if (!MIGRATION_FILE_PATTERN.test(file)) return null;
  const version = Number.parseInt(file.slice(0, 4), 10);
  return Number.isNaN(version) ? null : version;
}

/** Migration files (any order) not present in `applied`, sorted. */
export function pendingMigrationFiles(
  files: readonly string[],
  applied: ReadonlySet<number>
): string[] {
  return [...files].sort().filter((file) => {
    const version = migrationVersionOf(file);
    return version !== null && !applied.has(version);
  });
}
