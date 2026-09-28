// How long ago a snap was captured, for the toast's header and the
// rail's thumbnails. Durations while they are short enough to mean
// something ("3m 23s ago"), a day or a date once they are not.
//
// Everything counts from `captured_at`. The dock's tabs once carried a
// timer that counted from when the snap joined the dock, which nobody
// could read; an age the user can match to "the one I took a minute ago"
// is the point.

import { useEffect, useState } from "react";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Under this the header says "just now". */
const JUST_NOW_MS = 5 * SECOND;

/** `captured_at` as epoch ms, or null for a string that does not parse. */
export function capturedAtMs(capturedAt: string): number | null {
  const ms = Date.parse(capturedAt);
  return Number.isFinite(ms) ? ms : null;
}

function duration(elapsed: number): string | null {
  if (elapsed < MINUTE) return `${Math.floor(elapsed / SECOND)}s`;
  if (elapsed < HOUR) {
    return `${Math.floor(elapsed / MINUTE)}m ${Math.floor((elapsed % MINUTE) / SECOND)}s`;
  }
  if (elapsed < DAY) {
    return `${Math.floor(elapsed / HOUR)}h ${Math.floor((elapsed % HOUR) / MINUTE)}m`;
  }
  return null;
}

function isYesterday(then: Date, now: Date): boolean {
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return (
    then.getFullYear() === yesterday.getFullYear() &&
    then.getMonth() === yesterday.getMonth() &&
    then.getDate() === yesterday.getDate()
  );
}

const timeOfDay = (d: Date): string =>
  d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const weekday = (d: Date): string => d.toLocaleDateString(undefined, { weekday: "short" });
const monthDay = (d: Date): string =>
  d.toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** The toast header: "just now", "42s ago", "3m 23s ago", "1h 3m ago",
 *  then "yesterday 2:02 PM", "Tue 2:02 PM", "Sep 17 2:02 PM". A capture
 *  stamped in the future (clock skew, an import) reads as just now. */
export function formatCaptureAgo(capturedAt: number, now: number): string {
  const elapsed = Math.max(0, now - capturedAt);
  if (elapsed < JUST_NOW_MS) return "just now";
  const short = duration(elapsed);
  if (short !== null) return `${short} ago`;
  const then = new Date(capturedAt);
  const today = new Date(now);
  if (isYesterday(then, today)) return `yesterday ${timeOfDay(then)}`;
  if (elapsed < WEEK) return `${weekday(then)} ${timeOfDay(then)}`;
  return `${monthDay(then)} ${timeOfDay(then)}`;
}

/** A thumbnail's corner: "42s", "3m 23s", "1h 3m", "Yesterday", "Tue",
 *  "Sep 17". */
export function formatThumbAge(capturedAt: number, now: number): string {
  const elapsed = Math.max(0, now - capturedAt);
  const short = duration(elapsed);
  if (short !== null) return short;
  const then = new Date(capturedAt);
  if (isYesterday(then, new Date(now))) return "Yesterday";
  if (elapsed < WEEK) return weekday(then);
  return monthDay(then);
}

/** How often an age that old needs re-rendering: seconds are shown
 *  under an hour, minutes under a day, nothing finer after that. */
export function ageTickMs(capturedAt: number, now: number): number {
  const elapsed = Math.max(0, now - capturedAt);
  if (elapsed < HOUR) return SECOND;
  return MINUTE;
}

/**
 * The current time, re-read every `tickMs` (or never, for null). One
 * clock per component that shows ages, rather than one per age, so a
 * rail of thumbnails re-renders once a tick instead of once per thumb.
 */
export function useNow(tickMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (tickMs === null) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(timer);
  }, [tickMs]);
  return now;
}
