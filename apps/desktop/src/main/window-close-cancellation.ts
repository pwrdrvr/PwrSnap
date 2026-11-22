const listeners = new Set<() => void>();

/** Observe a user's refusal to close a window, including during a native
 * update close pass that runs before app.before-quit. */
export function onWindowCloseCancelled(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyWindowCloseCancelled(): void {
  for (const listener of [...listeners]) listener();
}
