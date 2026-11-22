// Chromium has one trace session per instance, even across renderer targets.
let owner: symbol | undefined;
let grantManualLease: (() => void) | undefined;
const leaseListeners = new Set<() => void>();

function notifyLeaseChanged(): void {
  for (const listener of [...leaseListeners]) listener();
}

export function tryAcquireChromiumTrace(): (() => void) | undefined {
  if (owner) return;
  const token = Symbol();
  owner = token;
  return () => {
    if (owner !== token) return;
    owner = undefined;
    // Transfer to the explicit request before a rolling recorder can rearm.
    grantManualLease?.();
    notifyLeaseChanged();
  };
}

export function isManualChromiumTraceWaiting(): boolean {
  return grantManualLease !== undefined;
}

export function acquireManualChromiumTrace(signal: AbortSignal): Promise<(() => void) | undefined> {
  if (signal.aborted || grantManualLease) return Promise.resolve(undefined);
  const immediate = tryAcquireChromiumTrace();
  if (immediate) return Promise.resolve(immediate);

  return new Promise((resolve) => {
    const cancel = () => {
      grantManualLease = undefined;
      resolve(undefined);
      notifyLeaseChanged();
    };
    grantManualLease = () => {
      signal.removeEventListener("abort", cancel);
      grantManualLease = undefined;
      resolve(tryAcquireChromiumTrace());
    };
    signal.addEventListener("abort", cancel, { once: true });
    notifyLeaseChanged();
  });
}

export function onChromiumTraceLeaseChanged(listener: () => void): () => void {
  leaseListeners.add(listener);
  return () => { leaseListeners.delete(listener); };
}
