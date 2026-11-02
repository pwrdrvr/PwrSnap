import type { ReactElement } from "react";

// Library glyphs that appear in more than one place: the sidebar's
// scope + type rows, and the trash family (Move to Trash / Restore /
// Delete permanently) on grid cells, Reel frames, the detail rail and
// the undo toast. Before this module the lidded trash path was pasted
// seven times and the sidebar drew an eighth, lidless one — which is
// how one of them drifted. Draw a trash can from here, nowhere else.
//
// Shapes follow Lucide (ISC) redrawn on our 24-unit grid; there is no
// icon dependency. Design: "PwrSnap Library Icons" in the PwrSnap
// Claude Design project (trash T2, sidebar option B).

export type PsIconName =
  | "all"
  | "today"
  | "trash"
  | "restore"
  | "purge"
  | "images"
  | "videos"
  | "projects"
  | "plus";

// The three trash verbs share one can, so restore and delete-forever
// read as the same object with a different action inside it — and the
// irreversible one is visibly not the reversible one.
const LID = "M3.5 6h17";
const HANDLE = "M8.5 6V4.5A1.5 1.5 0 0 1 10 3h4a1.5 1.5 0 0 1 1.5 1.5V6";
const CAN = "M5.5 6l.95 13.1A2 2 0 0 0 8.45 21h7.1a2 2 0 0 0 2-1.9L18.5 6";
const can = (inner: string): ReactElement => (
  <>
    <path d={LID} />
    <path d={HANDLE} />
    <path d={CAN} />
    <path d={inner} />
  </>
);

const GLYPHS: Record<PsIconName, ReactElement> = {
  all: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  // A calendar with today's cell filled — a clock read as "recent".
  today: (
    <>
      <rect x="3" y="4.5" width="18" height="16.5" rx="2.5" />
      <path d="M3 9.5h18M8 2.5v4M16 2.5v4" />
      <rect x="13" y="13" width="4.5" height="4.5" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  trash: can("M10 10.5v6M14 10.5v6"),
  restore: can("M12 17.5v-7M9.25 13.25 12 10.5l2.75 2.75"),
  purge: can("M9.75 11l4.5 4.5M14.25 11l-4.5 4.5"),
  images: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <circle cx="8.75" cy="8.75" r="1.75" />
      <path d="m21 15-4.3-4.3a1.5 1.5 0 0 0-2.1 0L5 20.5" />
    </>
  ),
  // A recorded clip…
  videos: (
    <>
      <rect x="2.5" y="6" width="13.5" height="12" rx="2.5" />
      <path d="m16 10.5 4.6-2.75a.6.6 0 0 1 .9.5v7.5a.6.6 0 0 1-.9.5L16 13.5" />
    </>
  ),
  // …and an edited reel. These two were the same camera.
  projects: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <path d="M7.5 3v18M16.5 3v18M3 12h18M3 7.5h4.5M3 16.5h4.5M16.5 7.5H21M16.5 16.5H21" />
    </>
  ),
  plus: <path d="M12 5.5v13M5.5 12h13" />
};

/**
 * One glyph at `size` CSS px. The stroke is derived from the rendered
 * size so every glyph draws a `line`-px line whatever its box: a fixed
 * `strokeWidth="2"` renders 0.92px at 11px and 1.33px at 16px, and the
 * old sidebar's 1.8 at 11px was 0.83px — thinner than its own label.
 * ~1.2px suits glyphs beside 11–12px text; 1.5px suits 16px glyphs on
 * the media scrim.
 */
export function PsIcon({
  name,
  size,
  line = 1.25,
  className
}: {
  name: PsIconName;
  size: number;
  line?: number;
  className?: string;
}): ReactElement {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={(24 / size) * line}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {GLYPHS[name]}
    </svg>
  );
}
