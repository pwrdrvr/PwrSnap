// Type declarations for the preload-exposed `window.pwrsnapApi`.
//
// Keep in sync with apps/desktop/src/preload/index.ts. Renderer code
// should call through `lib/pwrsnap.ts` (Phase 1.4 helper) rather than
// using `window.pwrsnapApi.dispatch` directly — the helper provides
// typed Req<C> / Res<C> inference per command name.

import type { CommandName, Req, Res, PwrSnapError, Result } from "@pwrsnap/shared";

declare global {
  interface Window {
    pwrsnapApi?: {
      platform: string;
      versions: { chrome: string; electron: string; node: string };
      dispatch<C extends CommandName>(
        name: C,
        req: Req<C>
      ): Promise<Result<Res<C>, PwrSnapError>>;
      on(channel: string, handler: (payload: unknown) => void): () => void;
    };
  }
}

export {};
