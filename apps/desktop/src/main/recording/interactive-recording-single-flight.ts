export type InteractiveRecordingSingleFlightDependencies = {
  runAttempt: (protectWindowIds: readonly number[]) => Promise<void>;
  onDuplicate?: (() => void) | undefined;
};

export type InteractiveRecordingSingleFlight = (
  protectWindowIds?: readonly number[]
) => Promise<void>;

/**
 * Wrap the complete permission → selector → recording handoff in one
 * process-local reservation. The reservation spans every await in the attempt,
 * so a second hotkey/tray/library trigger cannot open a competing selector or
 * permission broker.
 *
 * Selector/Float-Over/snapshot teardown belongs exclusively to
 * capture/record-selection.ts. This wrapper owns reservation only.
 */
export function createInteractiveRecordingSingleFlight(
  deps: InteractiveRecordingSingleFlightDependencies
): InteractiveRecordingSingleFlight {
  let reserved = false;

  return async (protectWindowIds = []): Promise<void> => {
    if (reserved) {
      deps.onDuplicate?.();
      return;
    }
    reserved = true;

    try {
      await deps.runAttempt(protectWindowIds);
    } finally {
      reserved = false;
    }
  };
}
