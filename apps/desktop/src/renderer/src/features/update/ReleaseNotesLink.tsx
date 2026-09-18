// "Release notes" — the one control that takes a version out to its
// published GitHub release page.
//
// Four surfaces render it (Settings -> Updates' slot tiles and status line,
// the Library's update toast, the tray + float-over rows) and they share
// this component rather than each writing their own anchor, for the same
// reason they share `appUpdateNotice`: the wording and the behaviour must
// not drift. Only the skin differs, which is what `className` is for.
//
// It is a real `<a href>` with `onClick` -> `preventDefault()` ->
// `app:openExternal` in front of it — the pairing Settings -> About's link
// rows use, and the one the root AGENTS.md section "No webContents opens a
// window, and none navigates away" tells you to keep. The verb is the
// mechanism: it is what actually opens the page, and it is the only path
// that can report a failure. The `href` is what makes the element honest —
// it is a link, it announces as one, and a middle-click or cmd-click (which
// Chromium turns into a `window.open` that `onClick` never sees) reaches the
// same page instead of doing nothing, because the navigation guard denies
// the window and hands the URL to the browser after clearing the SAME
// allowlist. Before that guard existed this was a `<button>` precisely
// because a modifier-click would otherwise have loaded github.com inside a
// BrowserWindow carrying our preload.
//
// It still carries no `title`. With an accessible name already present a
// `title` becomes the accessible DESCRIPTION, so a screen reader reads the
// whole URL aloud after every announcement — and PwrSnap wires no
// context-menu handler, so there is no "Copy Link Address" it would feed.
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
    <a
      className={className}
      // Disabled drops the `href` rather than only marking the element
      // aria-disabled, because the href is exactly what a modifier-click
      // reaches WITHOUT going through `onClick`. Leaving it would make a
      // greyed-out control the one thing on the surface still answering a
      // cmd-click. `tabIndex: -1` takes it out of the tab order to match,
      // and an anchor with no href is not focusable by default anyway.
      {...(disabled ? { "aria-disabled": true, tabIndex: -1 } : { href: url })}
      {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
      onClick={(event) => {
        // The verb opens the page, never the href — an in-app navigation to
        // github.com is precisely what the guard exists to refuse, and
        // `preventDefault` is what keeps this a request rather than one.
        event.preventDefault();
        if (disabled) return;
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
    </a>
  );
}
