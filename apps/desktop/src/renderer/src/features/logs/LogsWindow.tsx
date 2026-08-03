import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactElement,
  type ReactNode
} from "react";
import { EVENT_CHANNELS, type AppLogEntry, type AppLogSnapshot } from "@pwrsnap/shared";
import { dispatch, subscribe } from "../../lib/pwrsnap";
import { PwrSnapMark, PwrSnapWordmark } from "../shared/BrandMark";

const MAX_RENDERED_LOG_ENTRIES = 5000;
const BOTTOM_THRESHOLD_PX = 32;
type LogLevelFilter = "error" | "warn" | "info" | "debug";
const FILTERS: Array<{ value: LogLevelFilter; label: string }> = [
  { value: "error", label: "Error" },
  { value: "warn", label: "Warning" },
  { value: "info", label: "Info" },
  { value: "debug", label: "Debug" }
];

type HighlightPart = { text: string; matchIndex?: number };
type RenderedLine = { entry: AppLogEntry; lineNumber: number; parts: HighlightPart[] };

function bootstrapLogFilePath(): string | undefined {
  const value = window.__pwrsnapLogFilePath;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function LogsWindow(): ReactElement {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const activeMatchRef = useRef<HTMLElement | null>(null);
  const followingRef = useRef(true);
  const desiredDebugRef = useRef(false);
  const confirmedDebugRef = useRef(false);
  const debugSyncInFlightRef = useRef(false);
  const [entries, setEntries] = useState<AppLogEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [logFilePath, setLogFilePath] = useState<string | undefined>(bootstrapLogFilePath);
  const [debugCollectionEnabled, setDebugCollectionEnabled] = useState(false);
  const [selectedLevels, setSelectedLevels] = useState<LogLevelFilter[]>([
    "error",
    "warn",
    "info"
  ]);
  const [query, setQuery] = useState("");
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const [following, setFollowing] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const setFollowingMode = useCallback((value: boolean) => {
    followingRef.current = value;
    setFollowing(value);
  }, []);

  const applySnapshot = useCallback((value: AppLogSnapshot) => {
    setEntries(value.entries.slice(-MAX_RENDERED_LOG_ENTRIES));
    setTruncated(value.truncated || value.entries.length > MAX_RENDERED_LOG_ENTRIES);
    setLogFilePath(value.logFilePath ?? bootstrapLogFilePath());
    setDebugCollectionEnabled(value.debugCollectionEnabled);
    confirmedDebugRef.current = value.debugCollectionEnabled;
    if (!debugSyncInFlightRef.current) desiredDebugRef.current = value.debugCollectionEnabled;
    setError(null);
  }, []);

  const loadSnapshot = useCallback(async () => {
    setLoading(true);
    const result = await dispatch("logs:read", {});
    setLoading(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    applySnapshot(result.value);
  }, [applySnapshot]);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  useEffect(() => subscribe(EVENT_CHANNELS.logEntry, (payload) => {
    if (!followingRef.current || !isAppLogEntry(payload)) return;
    setEntries((current) => {
      const next = [...current, payload];
      if (next.length <= MAX_RENDERED_LOG_ENTRIES) return next;
      setTruncated(true);
      return next.slice(-MAX_RENDERED_LOG_ENTRIES);
    });
  }), []);

  useEffect(() => {
    if (!following) return;
    const viewport = viewportRef.current;
    if (viewport !== null) viewport.scrollTop = viewport.scrollHeight;
  }, [entries, following]);

  const rendered = useMemo(() => {
    const visible = entries.filter((entry) => selectedLevels.includes(filterForLevel(entry.level)));
    return renderLines(visible, query);
  }, [entries, query, selectedLevels]);

  useEffect(() => setActiveMatchIndex(0), [query]);
  useEffect(() => {
    if (activeMatchIndex >= rendered.matchCount) {
      setActiveMatchIndex(Math.max(0, rendered.matchCount - 1));
    }
  }, [activeMatchIndex, rendered.matchCount]);
  useEffect(() => {
    activeMatchRef.current?.scrollIntoView({ block: "center", inline: "nearest" });
  }, [activeMatchIndex]);

  const toggleLevel = useCallback(async (level: LogLevelFilter) => {
    const next = selectedLevels.includes(level)
      ? selectedLevels.filter((value) => value !== level)
      : [...selectedLevels, level];
    setSelectedLevels(next);
    if (level !== "debug") return;

    desiredDebugRef.current = next.includes("debug");
    if (debugSyncInFlightRef.current) return;
    debugSyncInFlightRef.current = true;
    setLoading(true);
    try {
      while (confirmedDebugRef.current !== desiredDebugRef.current) {
        const desired = desiredDebugRef.current;
        const result = await dispatch("logs:setDebugCollection", { enabled: desired });
        if (!result.ok) {
          setError(result.error.message);
          break;
        }
        applySnapshot(result.value);
        if (desired === desiredDebugRef.current) break;
      }
    } finally {
      debugSyncInFlightRef.current = false;
      setLoading(false);
    }
  }, [applySnapshot, selectedLevels]);

  const jumpToEnd = useCallback(() => {
    setFollowingMode(true);
    void loadSnapshot();
  }, [loadSnapshot, setFollowingMode]);

  const handleScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    const shouldFollow = distance <= BOTTOM_THRESHOLD_PX;
    if (shouldFollow && !followingRef.current) void loadSnapshot();
    setFollowingMode(shouldFollow);
  }, [loadSnapshot, setFollowingMode]);

  const moveMatch = useCallback((direction: -1 | 1) => {
    if (rendered.matchCount === 0) return;
    setFollowingMode(false);
    setActiveMatchIndex((current) =>
      (current + direction + rendered.matchCount) % rendered.matchCount
    );
  }, [rendered.matchCount, setFollowingMode]);

  const copyPath = useCallback(async () => {
    if (logFilePath === undefined) return;
    const result = await dispatch("clipboard:copyText", { text: logFilePath });
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }, [logFilePath]);

  const revealPath = useCallback(async () => {
    const result = await dispatch("logs:revealFile", {});
    if (!result.ok) setError(result.error.message);
  }, []);

  const matchLabel = rendered.matchCount > 0
    ? `${activeMatchIndex + 1} / ${rendered.matchCount}`
    : "0";

  return (
    <div className="ps-doc ps-doc--logs">
      <header className="ps-doc__titlebar">
        <div className="ps-doc__brand">
          <PwrSnapMark size={18} />
          <PwrSnapWordmark />
        </div>
        <div className="ps-doc__crumb">
          <span>Help</span><span aria-hidden="true">/</span><b>Logs</b>
        </div>
      </header>
      <main className="log-window__content">
        <div className="log-window__toolbar" aria-label="Log controls">
          <label className="log-window__search">
            <span>Search</span>
            <input
              aria-label="Search logs"
              value={query}
              placeholder="Find in logs"
              spellCheck={false}
              onChange={(event) => {
                setQuery(event.target.value);
                if (event.target.value.trim()) setFollowingMode(false);
              }}
            />
          </label>
          <div className="log-window__level-filter" role="group" aria-label="Log levels">
            {FILTERS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                className="log-window__level-option"
                aria-pressed={selectedLevels.includes(value)}
                data-collection={value === "debug" && selectedLevels.includes(value) && !debugCollectionEnabled ? "off" : undefined}
                onClick={() => void toggleLevel(value)}
              >{label}</button>
            ))}
          </div>
          <span className="log-window__match-count" aria-live="polite">{matchLabel}</span>
          <button className="log-window__button" disabled={rendered.matchCount === 0} type="button" onClick={() => moveMatch(-1)}>Prev</button>
          <button className="log-window__button" disabled={rendered.matchCount === 0} type="button" onClick={() => moveMatch(1)}>Next</button>
          <button className="log-window__button" aria-pressed={following} type="button" onClick={jumpToEnd}>Follow</button>
        </div>

        {logFilePath !== undefined ? (
          <div className="log-window__file" aria-label="Log file path">
            <span className="log-window__file-label">File</span>
            <code className="log-window__file-path" title={logFilePath}>{logFilePath}</code>
            <button className="log-window__file-action" data-copied={copied || undefined} type="button" onClick={() => void copyPath()}>{copied ? "Copied" : "Copy"}</button>
            <button className="log-window__file-action" type="button" onClick={() => void revealPath()}>Reveal</button>
          </div>
        ) : null}

        <div className="log-window__status">
          <span>{following ? "Live app log stream" : "Paused app log stream"}</span>
          {truncated ? <b>Showing tail</b> : null}
          {debugCollectionEnabled ? <b>Debug collection on</b> : null}
          {loading ? <b>Loading</b> : null}
        </div>
        {error !== null ? <p className="ps-doc__error" role="alert">Could not load logs: {error}</p> : null}

        <div
          ref={viewportRef}
          className="log-window__viewport"
          aria-label="Log viewport"
          onPointerDown={() => setFollowingMode(false)}
          onScroll={handleScroll}
        >
          {rendered.lines.length === 0 ? (
            <p className="ps-doc__empty">{loading ? "Loading..." : "No matching log output yet."}</p>
          ) : (
            <pre className="log-window__lines" aria-label="Log output">
              {rendered.lines.map((line) => (
                <span key={line.entry.sequence} className={`log-window__line log-window__line--${filterForLevel(line.entry.level)}`}>
                  <span className="log-window__line-number">{line.lineNumber}</span>
                  <span className="log-window__line-text">
                    {line.parts.map((part, index) => renderPart(part, `${line.entry.sequence}-${index}`, activeMatchIndex, activeMatchRef))}
                  </span>{"\n"}
                </span>
              ))}
            </pre>
          )}
        </div>
      </main>
    </div>
  );
}

function renderPart(
  part: HighlightPart,
  key: string,
  activeMatchIndex: number,
  activeMatchRef: MutableRefObject<HTMLElement | null>
): ReactNode {
  if (part.matchIndex === undefined) return <span key={key}>{part.text}</span>;
  const active = part.matchIndex === activeMatchIndex;
  return <mark key={key} ref={active ? activeMatchRef : undefined} className={active ? "log-window__match log-window__match--active" : "log-window__match"}>{part.text}</mark>;
}

export function renderLines(entries: AppLogEntry[], query: string): {
  lines: RenderedLine[];
  matchCount: number;
} {
  const needle = query.trim().toLowerCase();
  let nextMatchIndex = 0;
  const lines = entries.map((entry, lineIndex) => {
    const parts: HighlightPart[] = [];
    let cursor = 0;
    const lowerLine = entry.line.toLowerCase();
    if (needle.length === 0) parts.push({ text: entry.line });
    while (needle.length > 0 && cursor < entry.line.length) {
      const foundAt = lowerLine.indexOf(needle, cursor);
      if (foundAt === -1) {
        parts.push({ text: entry.line.slice(cursor) });
        break;
      }
      if (foundAt > cursor) parts.push({ text: entry.line.slice(cursor, foundAt) });
      const end = foundAt + needle.length;
      parts.push({ text: entry.line.slice(foundAt, end), matchIndex: nextMatchIndex });
      nextMatchIndex += 1;
      cursor = end;
    }
    return { entry, lineNumber: lineIndex + 1, parts };
  });
  return { lines, matchCount: nextMatchIndex };
}

export function filterForLevel(level: string): LogLevelFilter {
  const normalized = level.trim().toLowerCase().replace(/[[\]]/g, "");
  if (normalized === "error") return "error";
  if (normalized === "warn" || normalized === "warning") return "warn";
  if (normalized === "debug" || normalized === "trace" || normalized === "verbose") return "debug";
  return "info";
}

function isAppLogEntry(value: unknown): value is AppLogEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<AppLogEntry>;
  return Number.isInteger(entry.sequence) && typeof entry.timestamp === "number" &&
    typeof entry.level === "string" && typeof entry.line === "string";
}
