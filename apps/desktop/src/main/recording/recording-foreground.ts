import { activateApp, listWindowsSnapshot } from "../capture/window-list";

export type RecordingForegroundRestorer = {
  readonly pid: number | null;
  restore: () => Promise<void>;
};

/**
 * Remember the app that owns the OS foreground before PwrSnap opens a
 * permission decision surface. Permission windows are intentionally focused,
 * but that focus must not change which app the selector freezes or the native
 * recorder starts against.
 *
 * Restoration is best-effort and idempotent. A missing helper/frontmost app is
 * represented by a no-op restorer so every caller can use a finally block.
 */
export async function snapshotRecordingForeground(): Promise<RecordingForegroundRestorer> {
  const { frontmostPid } = await listWindowsSnapshot();
  const pid =
    frontmostPid !== null && Number.isInteger(frontmostPid) && frontmostPid > 0
      ? frontmostPid
      : null;
  let restored = false;

  return {
    pid,
    restore: async (): Promise<void> => {
      if (restored) return;
      restored = true;
      if (pid !== null) await activateApp(pid);
    }
  };
}

/** Run a permission operation and restore its original foreground app before
 * control returns to the caller (for example, immediately before pickRegion). */
export async function withRecordingForegroundRestored<T>(
  operation: () => Promise<T>
): Promise<T> {
  const foreground = await snapshotRecordingForeground();
  try {
    return await operation();
  } finally {
    await foreground.restore();
  }
}
