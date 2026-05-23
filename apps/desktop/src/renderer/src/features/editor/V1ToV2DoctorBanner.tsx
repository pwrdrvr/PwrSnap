// Floating banner for the v1 → v2 lazy doctor (Phase 3 of the v2
// editor plan). Rendered absolutely over the editor canvas while the
// doctor runs (status === "upgrading") or after it parks
// (status === "view_only"). Returns null in all other states so the
// editor surface is unchanged for v2 captures and for v1 captures that
// have already migrated.
//
// Visual language mirrors LegacyMigrationBanner — black-elevated panel,
// accent-tinted border, soft glow — but anchored top-center over the
// editor canvas instead of bottom-right. The two banners serve
// different scopes (library-wide migration vs. per-capture lazy
// doctor) but share PwrSnap's overlay aesthetic.

import type { ReactElement } from "react";
import type { EnsureV2State } from "./useEnsureV2";

export interface V1ToV2DoctorBannerProps {
  readonly state: EnsureV2State;
  onRetry(): void;
}

export function V1ToV2DoctorBanner({
  state,
  onRetry
}: V1ToV2DoctorBannerProps): ReactElement | null {
  if (state.status === "irrelevant" || state.status === "ready") {
    return null;
  }

  if (state.status === "upgrading") {
    return (
      <div
        className="pse-v1v2-banner pse-v1v2-banner--upgrading"
        role="status"
        aria-live="polite"
        data-testid="v1v2-doctor-banner"
        data-state="upgrading"
      >
        <span aria-hidden className="pse-v1v2-banner__spinner" />
        <span className="pse-v1v2-banner__label">
          Upgrading capture to v2&hellip;
        </span>
      </div>
    );
  }

  // view_only — doctor parked after MAX_ATTEMPTS or hit an uncaught
  // error. The Retry button is the recovery path: clears parked state
  // server-side and re-fires the doctor.
  return (
    <div
      className="pse-v1v2-banner pse-v1v2-banner--view-only"
      role="alert"
      data-testid="v1v2-doctor-banner"
      data-state="view_only"
    >
      <span aria-hidden className="pse-v1v2-banner__warn">!</span>
      <div className="pse-v1v2-banner__body">
        <span className="pse-v1v2-banner__label">
          Couldn&rsquo;t upgrade &mdash; read-only view
        </span>
        <span className="pse-v1v2-banner__hint">
          Error: <code>{state.errorCode}</code>
        </span>
      </div>
      <button
        type="button"
        className="pse-v1v2-banner__retry"
        data-testid="v1v2-doctor-retry"
        onClick={onRetry}
      >
        Retry
      </button>
    </div>
  );
}
