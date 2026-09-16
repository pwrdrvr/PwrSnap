// "Release notes" — the one control that takes a version out to its
// published GitHub release page.
//
// Four surfaces render it (Settings -> Updates' slot tiles and status line,
// the Library's update toast, the tray + float-over rows) and they share
// this component rather than each writing their own anchor, for the same
// reason they share `appUpdateNotice`: the wording and the behaviour must
// not drift. Only the skin differs, which is what `className` is for.
//
// It is a BUTTON, not an anchor, and that is deliberate on both counts:
//
//   - Semantically it performs an action — hand a URL to the OS browser —
//     rather than navigating this document. `app:openExternal` is the only
//     thing that ever opens it.
//   - No `href` means no navigation vector. PwrSnap installs no
//     `will-navigate` / `setWindowOpenHandler` guard, so a middle-click or
//     cmd-click on a real anchor is the one input that could put a remote
//     origin inside an app BrowserWindow. Settings -> About's three link
//     rows predate this and still use anchors; this component is what the
//     update surfaces use instead of multiplying them.
//
// Render nothing when there is no URL. `releaseNotesUrl` answers undefined
// for a version that is not a published release — a dev build, an E2E
// version override — and a dead "Release notes" control is worse than none.

import type { ReactElement } from "react";
import { dispatch } from "../../lib/pwrsnap";

export type ReleaseNotesLinkProps = {
  /** From `releaseNotesUrl(version)`. `undefined` renders nothing. */
  url: string | undefined;
  /** Surface skin. Every caller styles it in its own namespace. */
  className: string;
  /** Visible text. The compact rows have room for less. */
  label?: string;
  /**
   * Accessible name, when the visible label alone does not say WHICH
   * version's notes these are — the four-slot matrix renders four of
   * these at once, and "Release notes, Release notes, Release notes"
   * is not a usable list.
   */
  ariaLabel?: string;
};

export function ReleaseNotesLink({
  url,
  className,
  label = "Release notes",
  ariaLabel
}: ReleaseNotesLinkProps): ReactElement | null {
  if (url === undefined) return null;
  return (
    <button
      type="button"
      className={className}
      title={url}
      {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
      onClick={() => {
        // Fire and forget. The bus answers a Result, but the only failure it
        // can report is a refused URL — which this component cannot compose,
        // since `releaseNotesUrl` builds every one of them inside the
        // allowlist — and none of these surfaces has an error slot worth
        // spending on a case pinned shut by `release-notes.test.ts`.
        void dispatch("app:openExternal", { url });
      }}
    >
      {label}
      <svg
        viewBox="0 0 24 24"
        width="10"
        height="10"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M14 4h6v6" />
        <path d="M20 4 11 13" />
        <path d="M18 14.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4.5" />
      </svg>
    </button>
  );
}
