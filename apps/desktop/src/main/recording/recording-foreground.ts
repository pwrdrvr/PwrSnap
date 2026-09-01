import { activateApp, listWindowsSnapshot } from "../capture/window-list";

export type RecordingForegroundRestorer = {
  readonly pid: number | null;
  restore: () => Promise<void>;
};

/**
 * Remember the app that owns the OS foreground before PwrSnap opens an
 * interactive permission surface. Restoring it prevents that surface from
 * changing the pixels frozen by the selector or handed to the recorder.
 *
 * Restoration is best-effort and idempotent. The native helper already
 * degrades to a no-op when the pid disappears or the OS refuses activation.
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

/** Restore the foreground snapshot before returning from an interactive
 * permission operation, including its cancel and error paths. */
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
