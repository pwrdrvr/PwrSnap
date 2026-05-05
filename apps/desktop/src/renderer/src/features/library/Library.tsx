import { useEffect, useMemo, useState } from "react";
import type { CaptureRecord } from "@pwrsnap/shared";
import { Editor } from "../editor/Editor";
import { AppIcon, AppTag } from "../shared/AppIcons";
import { PwrSnapMark, PwrSnapWordmark } from "../shared/BrandMark";
import { FixtureBackedRecords } from "./adapter";
import type { Capture } from "./captures";
import { APP_INFO, groupByDay } from "./captures";
import { cacheUrl, dispatch } from "../../lib/pwrsnap";
import { useLibrary } from "../../lib/useLibrary";
// Thumb (synthetic per-app gradient) is the fallback for the empty
// state and for fixture rows in dev. Real captures render via
// <img src="pwrsnap-cache://"> through CellThumb below.
import { Thumb } from "./Thumb";

/**
 * Picks the right thumb representation: real cache-rendered image
 * when we have a record, synthetic per-app gradient otherwise. The
 * cache URL goes through main's protocol handler → render pipeline,
 * so the very first read of a freshly-captured snap composes its
 * 240w.webp on demand and caches it.
 */
function CellThumb({
  capture,
  record,
  width
}: {
  capture: Capture;
  record: CaptureRecord | null;
  width: number;
}) {
  if (record !== null) {
    return (
      <img
        src={cacheUrl(record.id, width)}
        alt=""
        style={{
          width: "100%",
          height: "100%",
          // `contain` preserves the capture's true aspect ratio.
          // Cells use `aspect-ratio: 16/10` for a uniform grid layout;
          // letterboxing inside the cell keeps the thumbnail honest
          // for any source aspect (a tiny region capture stays small;
          // a tall window capture stays tall).
          objectFit: "contain",
          display: "block"
        }}
      />
    );
  }
  return <Thumb c={capture} />;
}

export function Library({
  initialSelected = 1,
  sizzleMode = false,
  sizzlePicks = []
}: {
  initialSelected?: number;
  sizzleMode?: boolean;
  sizzlePicks?: number[];
}) {
  const [selected, setSelected] = useState(initialSelected);
  const [activeApp, setActiveApp] = useState<string>("all");
  const [view, setView] = useState<"reel" | "grid">("reel");
  const [picks] = useState<number[]>(sizzlePicks);
  const sizzle = sizzleMode || picks.length > 0;

  // Library mode router. The reel + sidebars stay constant across
  // mode switches — only the center pane swaps content. Per plan
  // §"Decision 2: Library layout", the reel is the time-anchor and
  // never reorders, so the user's place in history is preserved
  // through every inspect/edit transition.
  type LibraryMode = "browse" | "inspect" | "edit";
  const [libraryMode, setLibraryMode] = useState<LibraryMode>("browse");
  /** The captureId being inspected/edited, if any. Tracked
   *  separately from the fixture-driven `selected` because mode
   *  navigation needs the REAL record id, and the fixture-driven
   *  selection is keyed by the synthetic numeric id from
   *  `captures.ts`. Null when in browse mode. */
  const [inspectingId, setInspectingId] = useState<string | null>(null);

  const { records, loading, error } = useLibrary();
  const fixtureBacking = useMemo(() => new FixtureBackedRecords(records), [records]);
  const fixtureCaptures = useMemo(() => fixtureBacking.fixtures(), [fixtureBacking]);

  const visible =
    activeApp === "all" ? fixtureCaptures : fixtureCaptures.filter((c) => c.app === activeApp);
  const grouped = useMemo(() => groupByDay(visible), [visible]);
  const current = fixtureCaptures.find((c) => c.id === selected) ?? fixtureCaptures[0];

  // Look up the real CaptureRecord for the currently-selected fixture
  // — used by the thumb URL + the Detail rail.
  const selectedRecord = current ? fixtureBacking.recordFor(current.id) : null;

  // Resolve the inspect/edit target — a real CaptureRecord we can
  // hand to the editor / inspect canvas. Falls back to nothing when
  // the inspecting id no longer maps to a live record (handles the
  // stale-selection case from §"Phase 2 / Stale-selection fallback").
  const inspectingRecord: CaptureRecord | null = useMemo(() => {
    if (inspectingId === null) return null;
    return records.find((r) => r.id === inspectingId) ?? null;
  }, [records, inspectingId]);

  // Stale-selection fallback: when the user is inspecting a record
  // that disappears from the live list (e.g. a soft-delete races
  // an open editor), fall back to the most recent record. Beats
  // dumping the user back to browse and losing context.
  useEffect(() => {
    if (libraryMode === "browse") return;
    if (inspectingRecord !== null) return;
    if (records.length === 0) {
      setLibraryMode("browse");
      setInspectingId(null);
      return;
    }
    setInspectingId(records[0]!.id);
  }, [libraryMode, inspectingRecord, records]);

  // Mode keyboard shortcuts:
  //   • ESC   — step back (edit→inspect→browse)
  //   • E     — inspect→edit
  //   • Click in reel/grid — browse→inspect on the clicked record
  // Editor.tsx has its own ESC handler for canceling drafts; that
  // one runs first because it's attached to the editor canvas.
  // Once the draft is cleared, our window-level handler fires on
  // the next ESC and exits edit mode.
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") {
        if (libraryMode === "edit") {
          event.preventDefault();
          setLibraryMode("inspect");
        } else if (libraryMode === "inspect") {
          event.preventDefault();
          setLibraryMode("browse");
          setInspectingId(null);
        }
        return;
      }
      if (event.key === "e" || event.key === "E") {
        if (libraryMode === "inspect" && inspectingRecord !== null) {
          event.preventDefault();
          setLibraryMode("edit");
        }
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [libraryMode, inspectingRecord]);

  /**
   * Single-click handler for cells / reel frames. When the clicked
   * fixture has a real record behind it, enter inspect mode on that
   * record. Otherwise (fixture-only data, e.g. dev placeholders)
   * fall back to the legacy `setSelected` so the right-rail
   * preview still updates.
   */
  function onSelectCell(c: Capture): void {
    setSelected(c.id);
    const record = fixtureBacking.recordFor(c.id);
    if (record !== null) {
      setInspectingId(record.id);
      setLibraryMode("inspect");
    }
  }

  return (
    <div className="psl">
      <header className="psl__topbar">
        <div className="psl__topbar-l">
          <div className="psl__title">
            <span className="psl__title-mark">
              <PwrSnapMark size={18} />
            </span>
            <PwrSnapWordmark />
          </div>
          <span className="psl__count">
            {loading ? "loading…" : `${records.length} captures`}
          </span>
        </div>
        <div className="psl__topbar-c">
          <div className="psl__view">
            <button
              className={"psl__view-btn" + (view === "reel" ? " is-active" : "")}
              onClick={() => setView("reel")}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="6" width="4" height="12" />
                <rect x="10" y="6" width="4" height="12" />
                <rect x="17" y="6" width="4" height="12" />
              </svg>
              Reel
            </button>
            <button
              className={"psl__view-btn" + (view === "grid" ? " is-active" : "")}
              onClick={() => setView("grid")}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
              </svg>
              Grid
            </button>
          </div>
        </div>
        <div className="psl__topbar-r">
          <div className="psl__search-wrap">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              className="psl__search"
              placeholder="Search captures, tags, OCR…"
              defaultValue=""
            />
          </div>
          <button className="psl__chip-btn psl__chip-btn--accent" style={{ height: 28 }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
              <path d="M5 12h14M12 5v14" />
            </svg>
            New snap · ⌘⇧P
          </button>
        </div>
      </header>

      <aside className="psl__left">
        <div className="psl__left-section">Library</div>
        <button
          className={"psl__nav" + (activeApp === "all" ? " is-active" : "")}
          onClick={() => setActiveApp("all")}
        >
          <span className="psl__nav-icon">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
            </svg>
          </span>
          <span className="psl__nav-label">All Captures</span>
          <span className="psl__nav-count">{records.length}</span>
        </button>
        <button className="psl__nav">
          <span className="psl__nav-icon">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
          </span>
          <span className="psl__nav-label">Today</span>
          <span className="psl__nav-count">8</span>
        </button>
        <button className="psl__nav">
          <span className="psl__nav-icon">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M5 4l1 16h12l1-16" />
              <path d="M9 4V2h6v2" />
            </svg>
          </span>
          <span className="psl__nav-label">Trash</span>
          <span className="psl__nav-count">14</span>
        </button>

        <div className="psl__left-section">Source App</div>
        {Object.entries(APP_INFO).map(([app, info]) => (
          <button
            key={app}
            className={"psl__nav" + (activeApp === app ? " is-active" : "")}
            onClick={() => setActiveApp(app)}
          >
            <span className="psl__nav-icon">
              <AppIcon app={app as never} size={11} />
            </span>
            <span className="psl__nav-label">{info.name}</span>
            <span className="psl__nav-count">
              {fixtureCaptures.filter((c) => c.app === app).length}
            </span>
          </button>
        ))}

        <div className="psl__left-section">Smart Filters</div>
        <button className="psl__nav">
          <span className="psl__nav-icon">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M12 2 9 9l-7 1 5 5-1 7 6-3 6 3-1-7 5-5-7-1z" />
            </svg>
          </span>
          <span className="psl__nav-label">Pinned</span>
          <span className="psl__nav-count">6</span>
        </button>
        <button className="psl__nav">
          <span className="psl__nav-icon">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0Z" />
              <path d="m9 12 2 2 4-4" />
            </svg>
          </span>
          <span className="psl__nav-label">Bug repros</span>
          <span className="psl__nav-count">5</span>
        </button>
        <button className="psl__nav">
          <span className="psl__nav-icon">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M4 4h16v6H4zM4 14h16v6H4z" />
            </svg>
          </span>
          <span className="psl__nav-label">Has annotations</span>
          <span className="psl__nav-count">11</span>
        </button>
      </aside>

      <main className="psl__main">
        {sizzle && (
          <div className="psl__sizzle-strip">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M5 3v18l7-4 7 4V3z" />
            </svg>
            <div className="psl__sizzle-strip-text">
              <b>Sizzle Reel</b> — {picks.length || 5} captures · ~28s · Codex chose order
              <small>drag frames to reorder · ⌥click to drop · export as MP4 / GIF / Markdown</small>
            </div>
            <button className="psl__chip-btn psl__chip-btn--accent">Export reel</button>
          </div>
        )}

        <section className="psl__reel-wrap">
          <div className="psl__reel-hdr">
            <span className="psl__reel-title">
              Timeline · {activeApp === "all" ? "all sources" : APP_INFO[activeApp]?.name}
            </span>
            <span className="psl__reel-mode">
              scrub <b>⌘[ / ⌘]</b>
            </span>
          </div>
          <div className="psl__reel">
            <div className="psl__playhead" style={{ left: 318 }} />
            {grouped.map((g) => (
              <div key={g.day} className="psl__reel-day">
                <div className="psl__reel-day-label">
                  {g.day} · {g.date}
                </div>
                <div className="psl__reel-day-frames">
                  {g.items.map((c) => (
                    <button
                      key={c.id}
                      className={
                        "psl__frame" +
                        (c.id === selected ? " is-selected" : "") +
                        (picks.includes(c.id) ? " is-in-reel" : "")
                      }
                      onClick={() => onSelectCell(c)}
                    >
                      <CellThumb capture={c} record={fixtureBacking.recordFor(c.id)} width={140} />
                      <span className="psl__frame-num">{c.time}</span>
                      <span className="psl__frame-app">
                        <AppIcon app={c.app} size={8} />
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        {libraryMode === "browse" && (
        <div className="psl__grid-wrap">
          {grouped.slice(0, 2).map((g) => (
            <div key={g.day}>
              <div className="psl__day-hdr">
                <span className="psl__day-hdr-label">{g.day}</span>
                <span className="psl__day-hdr-meta">
                  {g.date} · {g.items.length} captures
                </span>
                <span className="psl__day-hdr-line" />
              </div>
              <div className="psl__grid">
                {g.items.map((c) => (
                  <div
                    key={c.id}
                    className={
                      "psl__cell" +
                      (c.id === selected ? " is-selected" : "") +
                      (picks.includes(c.id) ? " is-in-reel" : "")
                    }
                    onClick={() => onSelectCell(c)}
                  >
                    <div className="psl__cell-thumb">
                      <CellThumb capture={c} record={fixtureBacking.recordFor(c.id)} width={400} />
                      <span className="psl__cell-time">{c.time}</span>
                      <span className="psl__cell-app">
                        <span className="psl__app-dot">
                          <AppIcon app={c.app} size={10} />
                        </span>
                      </span>
                      {sizzle && (
                        <span className="psl__cell-pick">
                          {picks.indexOf(c.id) >= 0 ? picks.indexOf(c.id) + 1 : ""}
                        </span>
                      )}
                    </div>
                    <div className="psl__cell-meta">
                      <div className="psl__cell-name">{c.n}</div>
                      <div className="psl__cell-tags">
                        <AppTag app={c.app} name={APP_INFO[c.app]?.name ?? "Unknown app"} size="sm" />
                        {c.tags.slice(0, 1).map((t) => (
                          <span key={t} className="ps-tag is-sm">
                            {t}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        )}
        {libraryMode === "inspect" && inspectingRecord !== null && (
          <InspectPane
            record={inspectingRecord}
            onEdit={() => setLibraryMode("edit")}
            onClose={() => {
              setLibraryMode("browse");
              setInspectingId(null);
            }}
          />
        )}
        {libraryMode === "edit" && inspectingRecord !== null && (
          <div className="psl__edit-pane">
            <Editor captureId={inspectingRecord.id} />
          </div>
        )}
      </main>

      <aside className="psl__right">
        <div className="psl__right-tabs">
          <button className="psl__right-tab is-active">Detail</button>
          <button className="psl__right-tab">History</button>
          <button className="psl__right-tab">OCR</button>
        </div>
        <div className="psl__right-body">
          {error !== null && (
            <div style={{ padding: 12, color: "var(--danger-text)", font: "500 12px var(--font-sans)" }}>
              Failed to load library: {error}
            </div>
          )}
          {!loading && current === undefined ? (
            <div style={{ padding: 24, color: "var(--text-muted)", font: "500 13px var(--font-sans)" }}>
              No captures yet — press <b style={{ color: "var(--text-primary)" }}>⌘⇧P</b> to take your first snap.
            </div>
          ) : current === undefined ? null : (<>
          <div className="psl__preview">
            <div
              style={{
                position: "relative",
                aspectRatio: "16/10",
                overflow: "hidden",
                background: "var(--bg-input)"
              }}
            >
              {selectedRecord !== null ? (
                <img
                  src={cacheUrl(selectedRecord.id, 1440)}
                  alt=""
                  // `contain`, matching the grid cells. The preview
                  // frame is a fixed 16:10 box; an off-aspect capture
                  // letterboxes against the dark frame background
                  // rather than getting cropped at the edges.
                  style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
                />
              ) : (
                <Thumb c={current} />
              )}
              <svg
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
                viewBox="0 0 100 62"
                preserveAspectRatio="none"
              >
                <rect x="48" y="34" width="22" height="9" fill="none" stroke="#e8743a" strokeWidth="0.6" />
                <path d="M48 34 L 30 22" stroke="#e8743a" strokeWidth="0.5" />
                <circle cx="30" cy="22" r="1.6" fill="#e8743a" />
              </svg>
            </div>
            <div className="psl__preview-toolbar">
              <button className="psl__pt-btn is-active" title="Crop">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M6 2v16h16M2 6h16v16" />
                </svg>
              </button>
              <button className="psl__pt-btn" title="Arrow">
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                >
                  <path d="M5 19 19 5M19 5h-7M19 5v7" />
                </svg>
              </button>
              <button className="psl__pt-btn" title="Box">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <rect x="4" y="4" width="16" height="16" />
                </svg>
              </button>
              <button className="psl__pt-btn" title="Text">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M5 6h14M12 6v14M9 20h6" />
                </svg>
              </button>
              <button className="psl__pt-btn" title="Blur">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <circle cx="7" cy="12" r="2" />
                  <circle cx="13" cy="8" r="2" />
                  <circle cx="17" cy="14" r="2" />
                  <circle cx="11" cy="17" r="2" />
                </svg>
              </button>
              <span className="psl__pt-sep" />
              <button className="psl__pt-btn" title="Magic wand">
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                >
                  <path d="m4 20 12-12M14 4h2v2M20 8h2v2M18 14h2v2" />
                </svg>
              </button>
              <button className="psl__pt-btn" title="Undo">
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                >
                  <path d="M3 12h12a4 4 0 1 1 0 8h-3" />
                  <path d="m7 8-4 4 4 4" />
                </svg>
              </button>
            </div>
          </div>

          <div className="psl__detail-meta">
            <input className="psl__detail-name" defaultValue={current.n} />
            <div className="psl__detail-row">
              <span>
                <b>
                  {current.w}×{current.h}
                </b>
              </span>
              <span>{current.size} KB</span>
              <span>PNG</span>
              <span>
                {current.day} · {current.time}
              </span>
            </div>
            <div className="psl__detail-tags">
              <AppTag app={current.app} name={APP_INFO[current.app]?.name ?? "Unknown app"} />
              {current.tags.map((t) => (
                <span key={t} className="ps-tag">
                  {t}
                </span>
              ))}
              <span className="ps-tag is-suggest">+ codex</span>
            </div>
          </div>

          <div className="psl__ai-card">
            <div className="psl__ai-card-hdr">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="m12 2 2.5 5 5.5.5-4 4 1 5.5-5-3-5 3 1-5.5-4-4 5.5-.5z" />
              </svg>
              Codex caption
              <small>haiku-4.5 · 1.4s</small>
            </div>
            <div className="psl__ai-card-text">
              <b>{APP_INFO[current.app]?.name ?? "Unknown app"}</b> capture showing{" "}
              <b>{current.tags.join(", ")}</b>.
              Highlighted region likely the <b>error toast at column G37</b>. Suggest tagging{" "}
              <b>finance</b>, <b>Q4</b>.
            </div>
            <div className="psl__ai-card-actions">
              <button className="psl__chip-btn">Regenerate</button>
              <button className="psl__chip-btn">Apply tags</button>
              <button className="psl__chip-btn">Copy as alt-text</button>
            </div>
          </div>

          <div className="psl__big-cta">
            <button
              className="is-primary"
              onClick={() => {
                if (selectedRecord !== null) {
                  void dispatch("clipboard:copy", { captureId: selectedRecord.id, preset: "med" });
                }
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <rect x="9" y="9" width="11" height="11" rx="1.5" />
                <path d="M5 15V5h10" />
              </svg>
              Copy
            </button>
            <button>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 4v12M6 10l6-6 6 6M4 20h16" />
              </svg>
              Share
            </button>
            <button>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 7h18M8 7V4h8v3M6 7l1 14h10l1-14" />
              </svg>
            </button>
            <button title="Open full editor">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" />
              </svg>
              Editor
            </button>
          </div>
          </>)}
        </div>
      </aside>

      <footer className="psl__status">
        <div className="psl__status-l">
          <span>
            <span className="a">●</span> 3.2 GB local · <b>iCloud sync</b>
          </span>
          <span>
            Codex auto-tag <b>on</b>
          </span>
        </div>
        <div className="psl__status-r">
          <span>⌘⇧P new · ⌘L library · ⌘K search</span>
          <span>
            <b>v0.0.1</b>
          </span>
        </div>
      </footer>
    </div>
  );
}

/**
 * Inspect mode body — selected record zoomed into the main pane.
 * The reel stays pinned at the top of `<main>`; this component
 * fills the area below it. Single-click on a tile / reel frame
 * enters this mode; ESC returns to browse; E enters edit. The
 * meta strip below the image surfaces capture metadata so the
 * user has full context without losing their place in history.
 */
function InspectPane({
  record,
  onEdit,
  onClose
}: {
  record: CaptureRecord;
  onEdit: () => void;
  onClose: () => void;
}) {
  return (
    <div className="psl__inspect">
      <div className="psl__inspect-canvas">
        <img
          src={cacheUrl(record.id, 1440)}
          alt={record.source_app_name ?? "Capture"}
          // contain: preserve aspect ratio inside the canvas frame
          // (the inspect-canvas has no fixed aspect-ratio, so the
          // image fills whichever dimension is the natural fit).
          style={{
            display: "block",
            maxWidth: "100%",
            maxHeight: "100%",
            objectFit: "contain"
          }}
        />
      </div>
      <div className="psl__inspect-meta">
        <div className="psl__inspect-meta-l">
          <b>{record.source_app_name ?? "Capture"}</b>
          <span>
            {record.width_px}×{record.height_px}
          </span>
          <span>{new Date(record.captured_at).toLocaleString()}</span>
        </div>
        <div className="psl__inspect-meta-r">
          <button className="psl__chip-btn" onClick={onClose} type="button">
            Close (Esc)
          </button>
          <button
            className="psl__chip-btn psl__chip-btn--accent"
            onClick={onEdit}
            type="button"
          >
            Edit (E)
          </button>
        </div>
      </div>
    </div>
  );
}
