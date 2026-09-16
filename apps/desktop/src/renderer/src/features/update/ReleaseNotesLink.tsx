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
// It takes a VERSION, not a URL, and composes the URL itself. That is what
// keeps "a version that is not a published release gets no control" a single
// decision: callers cannot compose a URL of their own, cannot forget the
// undefined case, and the copy modules that produce the surrounding wording
// (`app-update-notice.ts`, `update-progress.ts`) need no knowledge of GitHub
// at all. It renders nothing when `releaseNotesUrl` declines the version — a
// dev build, an E2E version override — because a dead "Release notes" control
// is worse than none, and on the two popovers, which size themselves to their
// content, it would also cost width for nothing.

import type { ReactElement } from "react";
import { releaseNotesUrl } from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";

export type ReleaseNotesLinkProps = {
  /** Bare (`1.1.1`) or tagged (`v1.1.1`). Anything `releaseNotesUrl` does not
   *  recognise as a published release renders nothing. */
  version: string | undefined | null;
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
  /** Greys out with the surface's other controls while their shared action is
   *  in flight. A row that disables Restart but not this one is reporting two
   *  different states for one click. */
  disabled?: boolean;
};

export function ReleaseNotesLink({
  version,
  className,
  label = "Release notes",
  ariaLabel,
  disabled = false
}: ReleaseNotesLinkProps): ReactElement | null {
  const url = releaseNotesUrl(version);
  if (url === undefined) return null;
  return (
    <button
      type="button"
      className={className}
      disabled={disabled}
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
