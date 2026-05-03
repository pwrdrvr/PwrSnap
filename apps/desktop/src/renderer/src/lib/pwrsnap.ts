// Renderer-side helper around `window.pwrsnapApi.dispatch`. Wraps the
// preload-exposed dispatcher with typed Req<C> / Res<C> inference and
// a small `unwrap` helper for callers that prefer a thrown error to a
// Result envelope (e.g. inside React event handlers where awaiting the
// envelope adds noise).

import type {
  CommandName,
  PwrSnapError,
  Req,
  Res,
  Result
} from "@pwrsnap/shared";

/**
 * Dispatch a command-bus command from the renderer. Returns the full
 * Result envelope. Use `dispatchOrThrow` when you'd rather throw on
 * failure than branch on `result.ok` at the call site.
 */
export async function dispatch<C extends CommandName>(
  name: C,
  req: Req<C>
): Promise<Result<Res<C>, PwrSnapError>> {
  if (!window.pwrsnapApi) {
    return {
      ok: false,
      error: {
        kind: "unknown",
        code: "preload_unavailable",
        message: "pwrsnapApi is not exposed; preload failed to load"
      }
    };
  }
  return window.pwrsnapApi.dispatch(name, req);
}

export class PwrSnapDispatchError extends Error {
  constructor(public readonly cause: PwrSnapError) {
    super(`${cause.kind}: ${cause.code}: ${cause.message}`);
    this.name = "PwrSnapDispatchError";
  }
}

export async function dispatchOrThrow<C extends CommandName>(
  name: C,
  req: Req<C>
): Promise<Res<C>> {
  const result = await dispatch(name, req);
  if (!result.ok) {
    throw new PwrSnapDispatchError(result.error);
  }
  return result.value;
}

/**
 * Subscribe to a server-pushed event channel (see `EVENT_CHANNELS` in
 * `@pwrsnap/shared/ipc`). Returns an unsubscribe function. Designed for
 * `useSyncExternalStore` — the hook lands in Phase 1.8.
 */
export function subscribe(
  channel: string,
  handler: (payload: unknown) => void
): () => void {
  if (!window.pwrsnapApi) return () => undefined;
  return window.pwrsnapApi.on(channel, handler);
}
