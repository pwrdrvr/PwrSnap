/* eslint-disable */
// PwrSnap Settings — desktop window with sidebar + main scroll area.
// Visual vocabulary lifted from PwrAgnt's Settings (eyebrow + title, collapsible
// cards, label/sub on left + control on right, amber-highlighted "currently using" rows).

const { useState: useStateSet } = React;
const { PsAppIcon } = window.PS;

// ============================================================
// Tiny icon helpers — Lucide-shape, single-weight strokes
// ============================================================
function Icon({ d, fill = "none", size = 14, sw = 1.6, ...p }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24"
      fill={fill} stroke="currentColor" strokeWidth={sw}
      strokeLinecap="round" strokeLinejoin="round" {...p}>
      {typeof d === "string" ? <path d={d} /> : d}
    </svg>
  );
}
const SVG = {
  arrowLeft: "M19 12H5M12 19l-7-7 7-7",
  gear: <g><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" /></g>,
  chevronDown: "m6 9 6 6 6-6",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z",
  search: <g><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></g>,
  question: <g><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-.6.6-1.5 1-1.5 2"/><path d="M12 17h.01"/></g>,
};

// ============================================================
// Categories
// ============================================================
const CATEGORIES = [
  { group: "General",  items: [
    { id: "startup",      name: "Startup & Menu Bar" },
    { id: "hotkeys",      name: "Hotkeys" },
    { id: "notifications", name: "Notifications" },
    { id: "ai",           name: "AI Providers" },
  ]},
  { group: "Capture",  items: [
    { id: "capture",      name: "Capture defaults" },
    { id: "output",       name: "Output & format" },
    { id: "annotate",     name: "Annotate" },
  ]},
  { group: "Library",  items: [
    { id: "storage",      name: "Storage & retention" },
    { id: "sources",      name: "App detection" },
  ]},
  { group: "Advanced", items: [
    { id: "experimental", name: "Experimental" },
    { id: "about",        name: "About" },
  ]},
];

// ============================================================
// Title bar (desktop window chrome)
// ============================================================
function TitleBar({ here }) {
  return (
    <header className="pss__titlebar">
      <span className="pss__lights"><span /><span /><span /></span>
      <span className="pss__title-brand">
        <PsAppIcon app="any" size={14} />
        <span>Pwr<span className="a">Snap</span></span>
      </span>
      <span className="pss__title-crumb">
        Settings <span className="sep">›</span> <span className="here">{here}</span>
      </span>
      <span className="pss__title-r">
        <span className="pss__title-r-icon" title="Search settings"><Icon d={SVG.search} sw={1.7} /></span>
        <span className="pss__title-r-icon" title="Help"><Icon d={SVG.question} sw={1.5} /></span>
      </span>
    </header>
  );
}

// ============================================================
// Sidebar
// ============================================================
function Sidebar({ active }) {
  return (
    <aside className="pss__sidebar">
      <button className="pss__exit" type="button">
        <Icon d={SVG.arrowLeft} sw={1.8} />
        Exit Settings
      </button>
      {CATEGORIES.map((cat, i) => (
        <React.Fragment key={cat.group}>
          <div className="pss__sb-section">{cat.group}</div>
          {cat.items.map((it) => (
            <button
              key={it.id}
              className={"pss__sb-nav" + (it.id === active ? " is-active" : "")}
              type="button"
            >
              {it.name}
            </button>
          ))}
        </React.Fragment>
      ))}
    </aside>
  );
}

// ============================================================
// Reusable row
// ============================================================
function Row({ label, sub, tag, children }) {
  return (
    <div className="pss__row">
      <div className="pss__row-l">
        <div className="pss__row-label">{label}</div>
        {sub ? <div className="pss__row-sub">{sub}</div> : null}
        {tag ? <div className="pss__row-tag">{tag}</div> : null}
      </div>
      <div className="pss__row-r">{children}</div>
    </div>
  );
}

function Card({ eyebrow, title, collapsed, children }) {
  return (
    <section className={"pss__card" + (collapsed ? " is-collapsed" : "")}>
      <header className="pss__card-hdr">
        <div className="pss__card-hdr-l">
          <span className="pss__card-eyebrow">{eyebrow}</span>
          <span className="pss__card-title">{title}</span>
        </div>
        <span className="pss__card-chev"><Icon d={SVG.chevronDown} /></span>
      </header>
      <div className="pss__card-body">
        {children}
      </div>
    </section>
  );
}

// ============================================================
// Helper bits
// ============================================================
function Kbd({ children }) { return <span className="ps-kbd">{children}</span>; }
function Hk({ keys, label = "Edit" }) {
  return (
    <button className="pss__hk" type="button">
      {keys.map((k, i) => <Kbd key={i}>{k}</Kbd>)}
      <span className="pss__hk-edit">{label}</span>
    </button>
  );
}
function HkUnset() {
  return <button className="pss__hk is-unset" type="button">+  click to set</button>;
}
function Switch({ on }) { return <span className={"pss__switch" + (on ? " is-on" : "")} />; }
function SwitchRow({ on, children }) {
  return <span className="pss__switch-row"><Switch on={on} /><span>{children}</span></span>;
}

// ============================================================
// PAGE — Output & format (the hero, modeled on the Models reference)
// ============================================================
function OutputPage() {
  const [format, setFormat] = useStateSet("png");
  const [target, setTarget] = useStateSet("auto");
  return (
    <>
      <div className="pss__main-hdr">
        <div className="pss__main-hdr-l">
          <div className="pss__main-eyebrow">Capture</div>
          <h1 className="pss__main-title">Output &amp; format</h1>
          <p className="pss__main-sub">
            How PwrSnap encodes each capture, where it lands on disk, and what
            the clipboard receives. The L / M / H presets at the bottom feed the
            Float-Over and Library copy rows.
          </p>
        </div>
        <div className="pss__main-actions">
          <button className="pss__top-btn is-active" type="button">Collapse all</button>
          <button className="pss__top-btn is-muted" type="button">Expand all</button>
        </div>
      </div>

      <Card eyebrow="ENCODING" title="File format">
        <Row
          label="Default format"
          sub="Used for every Region / Window / Full-Screen capture unless overridden in the editor."
          tag="format"
        >
          <div className="pss__swatches">
            {[
              ["png",  "PNG",  "lossless · α"],
              ["jpg",  "JPG",  "smaller · 92%"],
              ["heic", "HEIC", "macOS · 50% size"],
              ["webp", "WebP", "lossy · α"],
            ].map(([id, glyph, sub]) => (
              <button
                key={id}
                type="button"
                className={"pss__swatch" + (format === id ? " is-active" : "")}
                onClick={() => setFormat(id)}
              >
                <span className="pss__swatch-glyph">{glyph}</span>
                <span className="pss__swatch-sub">{sub}</span>
              </button>
            ))}
          </div>
        </Row>

        <Row
          label="JPG / WebP quality"
          sub="Ignored for PNG. Lower = smaller files; below 70 starts to show ringing on screenshots of text."
          tag="quality"
        >
          <div className="pss__slider-wrap">
            <input className="pss__slider" type="range" min="40" max="100" defaultValue="92" />
            <span className="pss__slider-readout">92%</span>
          </div>
        </Row>

        <Row
          label="Retina export"
          sub="Preserve the source DPI. Off = downsample to 1×, which roughly halves the file size on Retina displays."
        >
          <SwitchRow on={true}>Keep @2× / @3× pixels</SwitchRow>
        </Row>

        <Row
          label="Drop shadows on window captures"
          sub="macOS-native window shadows. Adds ~20px transparent margin around the snap."
        >
          <SwitchRow on={true}>Include shadow</SwitchRow>
        </Row>
      </Card>

      <Card eyebrow="DESTINATION" title="Save location">
        <Row
          label="Where snaps land"
          sub="The first valid location is used. PwrSnap will auto-create the folder if missing."
          tag="path"
        >
          <div className="pss__seg" style={{ marginBottom: 4 }}>
            <button
              className={"pss__seg-btn" + (target === "auto" ? " is-active" : "")}
              onClick={() => setTarget("auto")}
              type="button"
            >Auto · ~/Pictures/PwrSnap</button>
            <button
              className={"pss__seg-btn" + (target === "custom" ? " is-active" : "")}
              onClick={() => setTarget("custom")}
              type="button"
            >Custom path</button>
          </div>

          <div className="pss__opt is-using">
            <span className="pss__opt-icon"><Icon d={SVG.folder} sw={1.6} /></span>
            <div className="pss__opt-text">
              <span className="pss__opt-primary">~/Pictures/PwrSnap/2026/01</span>
              <span className="pss__opt-sub">macOS · sandbox-accessible · 3.2 GB used</span>
            </div>
            <span className="pss__opt-badges">
              <span className="pss__badge">default</span>
              <span className="pss__badge">writable</span>
              <span className="pss__badge is-using">Using</span>
            </span>
          </div>

          <div className="pss__opt">
            <span className="pss__opt-icon"><Icon d={SVG.folder} sw={1.6} /></span>
            <div className="pss__opt-text">
              <span className="pss__opt-primary">~/Library/Mobile Documents/com~apple~CloudDocs/PwrSnap</span>
              <span className="pss__opt-sub">iCloud Drive · syncs across devices · 24 GB free</span>
            </div>
            <span className="pss__opt-badges">
              <span className="pss__badge">icloud</span>
              <span className="pss__badge">writable</span>
              <button className="pss__opt-use" type="button">Use</button>
            </span>
          </div>

          <div className="pss__opt">
            <span className="pss__opt-icon"><Icon d={SVG.folder} sw={1.6} /></span>
            <div className="pss__opt-text">
              <span className="pss__opt-primary">/Volumes/Capture/pwrsnap</span>
              <span className="pss__opt-sub">external · last seen 4 days ago</span>
            </div>
            <span className="pss__opt-badges">
              <span className="pss__badge">external</span>
              <span className="pss__badge">offline</span>
            </span>
          </div>
        </Row>

        <Row
          label="Filename pattern"
          sub="Tokens: {app} {mode} {date} {time} {seq}. Falls back to {date}-{seq} on duplicate."
          tag="pattern"
        >
          <input className="pss__input" defaultValue="{date}-{time}-{app}-{mode}.{ext}" />
          <div className="pss__row-sub" style={{ marginTop: 6 }}>
            preview · <code style={{ font: "500 11px/1 var(--font-mono)", color: "var(--accent-bright)" }}>2026-01-23-1142-vscode-region.png</code>
          </div>
        </Row>

        <Row
          label="Save fallback"
          sub="If the primary destination is unreachable (drive disconnected, perms denied), spool here so nothing is lost."
        >
          <div className="pss__path">
            <span className="pss__path-icon"><Icon d={SVG.folder} sw={1.6} /></span>
            <span className="pss__path-text">~/Library/Caches/PwrSnap/spool
              <small>auto-flushes to primary when reachable</small>
            </span>
            <button className="pss__path-btn" type="button">Reveal</button>
            <button className="pss__path-btn" type="button">Change</button>
          </div>
        </Row>
      </Card>

      <Card eyebrow="CLIPBOARD" title="L / M / H copy presets">
        <Row
          label="Resolution presets"
          sub={
            <>Each Float-Over / Library copy row offers three sizes. Edit the
              scale used for L and M — H is always 100%. ⌘1 / ⌘2 / ⌘3 trigger them.</>
          }
          tag="scale"
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="pss__lmh">
              <span className="pss__lmh-label">Low ⌘1</span>
              <div className="pss__lmh-bar">
                <span className="pss__lmh-fill" style={{ width: "40%" }} />
                <b>40 %</b>
                <span>1152 × 768 · ~180 KB</span>
              </div>
              <span className="pss__lmh-pct">↑↓ to adjust</span>
            </div>
            <div className="pss__lmh">
              <span className="pss__lmh-label">Med ⌘2</span>
              <div className="pss__lmh-bar">
                <span className="pss__lmh-fill" style={{ width: "70%" }} />
                <b>70 %</b>
                <span>2016 × 1344 · ~610 KB</span>
              </div>
              <span className="pss__lmh-pct">↑↓</span>
            </div>
            <div className="pss__lmh">
              <span className="pss__lmh-label is-primary">High ⌘3</span>
              <div className="pss__lmh-bar">
                <span className="pss__lmh-fill" style={{ width: "100%", background: "var(--accent)", opacity: 0.22 }} />
                <b>100 %</b>
                <span>2880 × 1920 · ~2.4 MB</span>
              </div>
              <span className="pss__lmh-pct" style={{ color: "var(--text-muted)" }}>fixed</span>
            </div>
          </div>
        </Row>

        <Row
          label="Default copy on ⌘C in Editor"
          sub="When you cmd-C from the Library Focus or Float-Over without picking a size."
        >
          <button className="pss__select" type="button">
            High · 2880 × 1920 (100 %)
            <Icon d={SVG.chevronDown} sw={1.6} />
          </button>
        </Row>

        <Row
          label="Also write file path to clipboard"
          sub="Adds a second clipboard item for paste-as-attachment in Slack / Mail."
        >
          <SwitchRow on={false}>Off · only the image is on the clipboard</SwitchRow>
        </Row>
      </Card>

      <Card eyebrow="VERIFY" title="Self-test" collapsed>
        <Row label="Run an end-to-end capture" sub="Saves a 1×1 region capture, hits the encoder, writes the file, then loads it back." tag="test">
          <div className="pss__test">
            <span className="pss__test-icon">⏵</span>
            <div className="pss__test-l">
              <span className="pss__test-cmd">capture → encode → write → readback</span>
              <span className="pss__test-sub">last run · 2 hrs ago · 218 ms · OK</span>
            </div>
            <div className="pss__test-r">
              <span className="pss__badge is-using">PASS</span>
              <button className="pss__test-btn" type="button">Test</button>
            </div>
          </div>
        </Row>
      </Card>

      <div className="pss__footer">
        <span className="pss__footer-status">All changes saved automatically</span>
        <button className="pss__top-btn" type="button">Reset to defaults</button>
      </div>
    </>
  );
}

// ============================================================
// PAGE — Hotkeys
// ============================================================
function HotkeysPage() {
  return (
    <>
      <div className="pss__main-hdr">
        <div className="pss__main-hdr-l">
          <div className="pss__main-eyebrow">General</div>
          <h1 className="pss__main-title">Hotkeys</h1>
          <p className="pss__main-sub">
            PwrSnap is keyboard-first. ⌘⇧P is the global "smart" trigger that fires whatever
            capture mode is set as Quick Capture; the rest jump straight to a specific mode.
          </p>
        </div>
        <div className="pss__main-actions">
          <button className="pss__top-btn" type="button">Collapse all</button>
          <button className="pss__top-btn is-muted" type="button">Expand all</button>
        </div>
      </div>

      <Card eyebrow="CAPTURE" title="Global capture shortcuts">
        <Row label="Quick Capture" sub="The smart trigger. Picks region, window, or full-screen based on the cursor." tag="global">
          <Hk keys={["⌘","⇧","P"]} />
        </Row>
        <Row label="Region" sub="Drag a marquee on any display." tag="global">
          <Hk keys={["⌘","⇧","R"]} />
        </Row>
        <Row label="Window" sub="Click a window. ⌥ to include shadow." tag="global">
          <Hk keys={["⌘","⇧","W"]} />
        </Row>
        <Row label="Full Screen" sub="Active display." tag="global">
          <Hk keys={["⌘","⇧","F"]} />
        </Row>
        <Row label="All Screens" sub="Stitch every connected display into a single image." tag="global">
          <Hk keys={["⌘","⇧","A"]} />
        </Row>
        <Row label="Scrolling" sub="Capture full page from a scroll container." tag="global">
          <Hk keys={["⌘","⇧","S"]} />
        </Row>
        <Row label="Timed (5 s)" sub="Auto-trigger after countdown — useful for menus that close on focus loss." tag="global">
          <Hk keys={["⌘","⇧","T"]} />
        </Row>
      </Card>

      <Card eyebrow="APP" title="Library &amp; surfaces">
        <Row label="Open Library" sub="Brings the Library window to front and focuses the grid." tag="global">
          <Hk keys={["⌘","⇧","L"]} />
        </Row>
        <Row label="Open Tray" sub="Drops the menubar tray under the PwrSnap icon." tag="global">
          <Hk keys={["⌘","⇧","M"]} />
        </Row>
        <Row label="Re-show last Float-Over" sub="Pops the most recent capture back over the screen." tag="global">
          <HkUnset />
        </Row>
        <Row label="Open Settings" sub="This window." tag="global">
          <Hk keys={["⌘",","]} />
        </Row>
      </Card>

      <Card eyebrow="EDITOR" title="In-canvas tools (Focus + Float-Over)" collapsed>
        <Row label="Select / Crop / Arrow / Rect / Highlight / Text / Blur" sub="Single-letter when focus is in the editor canvas.">
          <SwitchRow on={true}>Single-letter shortcuts</SwitchRow>
        </Row>
      </Card>

      <div className="pss__footer">
        <span className="pss__footer-status">All changes saved automatically</span>
        <button className="pss__top-btn" type="button">Reset to defaults</button>
      </div>
    </>
  );
}

// ============================================================
// PAGE — AI Providers (modeled on PwrAgnt Models: Backends & credentials)
// ============================================================
function AIProvidersPage() {
  const [codexMode, setCodexMode] = useStateSet("auto");
  return (
    <>
      <div className="pss__main-hdr">
        <div className="pss__main-hdr-l">
          <div className="pss__main-eyebrow">Providers</div>
          <h1 className="pss__main-title">Backends &amp; credentials</h1>
          <p className="pss__main-sub">
            PwrSnap delegates AI work to multiple providers. Codex generates capture
            captions and tag suggestions; OpenAI vectorizes captures + OCR for semantic
            search. Configure each backend below.
          </p>
        </div>
        <div className="pss__main-actions">
          <button className="pss__top-btn is-active" type="button">Collapse all</button>
          <button className="pss__top-btn is-muted" type="button">Expand all</button>
        </div>
      </div>

      <Card eyebrow="ROLES" title="Job routing">
        <Row
          label="Which provider handles what"
          sub="Each AI job in PwrSnap is wired to one provider. Switch the assignment here without touching credentials."
          tag="routing"
        >
          <div className="pss__role">
            <span className="pss__role-icon">
              <Icon d={<g><path d="M12 2 9.5 9 2 10l5.5 5L6 22l6-3 6 3-1.5-7 5.5-5-7.5-1z"/></g>} sw={1.5} />
            </span>
            <div className="pss__role-l">
              <span className="pss__role-name">Capture captions &amp; tag suggestions</span>
              <span className="pss__role-sub">Codex caption shown in Library detail + Float-Over</span>
            </div>
            <span className="pss__role-arrow">→</span>
            <button className="pss__role-provider" type="button">
              <b>Codex</b>
              <span style={{ color: "var(--text-muted)", font: "500 11px/1 var(--font-mono)", marginLeft: 2 }}>haiku-4.5</span>
              <Icon d={SVG.chevronDown} sw={1.6} />
            </button>
          </div>

          <div className="pss__role">
            <span className="pss__role-icon">
              <Icon d={<g><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="M11 8v6M8 11h6"/></g>} sw={1.6} />
            </span>
            <div className="pss__role-l">
              <span className="pss__role-name">Semantic search vectorization</span>
              <span className="pss__role-sub">Embeds capture metadata + OCR for ⌘K search</span>
            </div>
            <span className="pss__role-arrow">→</span>
            <button className="pss__role-provider" type="button">
              <b>OpenAI</b>
              <span style={{ color: "var(--text-muted)", font: "500 11px/1 var(--font-mono)", marginLeft: 2 }}>3-small</span>
              <Icon d={SVG.chevronDown} sw={1.6} />
            </button>
          </div>

          <div className="pss__role" style={{ opacity: 0.6 }}>
            <span className="pss__role-icon" style={{ borderColor: "var(--border-subtle)", color: "var(--text-muted)" }}>
              <Icon d={<g><path d="M4 4h16v16H4z"/><path d="M4 9h16M9 4v16"/></g>} sw={1.5} />
            </span>
            <div className="pss__role-l">
              <span className="pss__role-name">OCR — extract text from screenshots</span>
              <span className="pss__role-sub">Currently using <b style={{ color: "var(--text-primary)" }}>macOS Vision</b> (local) — provider option coming soon</span>
            </div>
            <span className="pss__role-arrow">→</span>
            <button className="pss__role-provider" type="button" style={{ borderColor: "var(--border-default)", color: "var(--text-secondary)", background: "var(--bg-input)" }}>
              <b style={{ color: "var(--text-primary)" }}>System</b>
              <span style={{ color: "var(--text-muted)", font: "500 11px/1 var(--font-mono)", marginLeft: 2 }}>Vision.framework</span>
              <Icon d={SVG.chevronDown} sw={1.6} />
            </button>
          </div>
        </Row>
      </Card>

      <Card eyebrow="PROVIDER" title="Codex">
        <Row
          label="Codex selection"
          sub="Pick the Codex binary to invoke for captions. Auto Discovery tracks the newest version on disk; Specified Path pins a single binary."
          tag="config"
        >
          <div className="pss__seg">
            <button
              className={"pss__seg-btn" + (codexMode === "auto" ? " is-active" : "")}
              onClick={() => setCodexMode("auto")}
              type="button"
            >Auto Discovery — Use Newest</button>
            <button
              className={"pss__seg-btn" + (codexMode === "pinned" ? " is-active" : "")}
              onClick={() => setCodexMode("pinned")}
              type="button"
            >Specified Path</button>
          </div>
        </Row>

        <Row
          label="Available paths"
          sub="Detected on this machine. The first listed will be used."
          tag="config"
        >
          <div className="pss__opt is-using">
            <span className="pss__opt-icon">C</span>
            <div className="pss__opt-text">
              <span className="pss__opt-primary">/Applications/Codex.app/Contents/Resources/codex</span>
              <span className="pss__opt-sub">spawned via launchctl · validated 4 min ago</span>
            </div>
            <span className="pss__opt-badges">
              <span className="pss__badge">application</span>
              <span className="pss__badge">0.130.0-alpha.5</span>
              <span className="pss__badge is-using">Using</span>
            </span>
          </div>
          <div className="pss__opt">
            <span className="pss__opt-icon">C</span>
            <div className="pss__opt-text">
              <span className="pss__opt-primary">/opt/homebrew/bin/codex</span>
              <span className="pss__opt-sub">symlink → /opt/homebrew/Cellar/codex/0.125.0</span>
            </div>
            <span className="pss__opt-badges">
              <span className="pss__badge">path</span>
              <span className="pss__badge">0.125.0</span>
              <button className="pss__opt-use" type="button">Use</button>
            </span>
          </div>
        </Row>

        <Row
          label="Auth profile"
          sub="Select the Codex home used for auth, config, sessions, skills, and state."
          tag="default"
        >
          <div className="pss__opt is-using">
            <span className="pss__opt-icon">~</span>
            <div className="pss__opt-text">
              <span className="pss__opt-primary">System default</span>
              <span className="pss__opt-sub">/Users/huntharo/.codex</span>
            </div>
            <span className="pss__opt-badges">
              <span className="pss__badge">default</span>
              <span className="pss__badge">auth</span>
              <span className="pss__badge">config</span>
              <span className="pss__badge is-using">Using</span>
            </span>
          </div>
        </Row>

        <Row
          label="Connection test"
          sub="Spawns the selected Codex binary with --version and validates the version banner."
          tag="test"
        >
          <div className="pss__test">
            <span className="pss__test-icon">C</span>
            <div className="pss__test-l">
              <span className="pss__test-cmd">/Applications/Codex.app/Contents/Resources/codex</span>
              <span className="pss__test-sub">spawn --version</span>
            </div>
            <div className="pss__test-r">
              <span className="pss__badge is-using">PASS</span>
              <button className="pss__test-btn" type="button">Test</button>
            </div>
          </div>
        </Row>
      </Card>

      <Card eyebrow="PROVIDER" title="OpenAI">
        <Row
          label="API Key"
          sub="OpenAI API key. Stored in the system keychain — never written to config files."
          tag="keychain"
        >
          <div className="pss__keyrow">
            <input className="pss__input" type="password" defaultValue="sk-proj-••••••••••••••••" />
            <button className="pss__key-btn" type="button">Replace</button>
            <button className="pss__key-btn is-danger" type="button">Clear</button>
          </div>
          <div className="pss__key-meta">
            <span>set <b style={{ color: "var(--text-primary)" }}>3 days ago</b></span>
            <span>·</span>
            <span>keychain · org-pwrsnap-local</span>
          </div>
        </Row>

        <Row
          label="Embedding model"
          sub="Used to vectorize captures for semantic search. text-embedding-3-small is the cost-efficient default; 3-large doubles dimensionality."
          tag="model"
        >
          <button className="pss__select" type="button" style={{ minWidth: 280 }}>
            text-embedding-3-small
            <span style={{ color: "var(--text-muted)", font: "500 11px/1 var(--font-mono)", marginLeft: "auto" }}>1536 dim · $0.02 / 1M tokens</span>
            <Icon d={SVG.chevronDown} sw={1.6} />
          </button>
        </Row>

        <Row
          label="Base URL"
          sub="Override only when routing through a proxy or self-hosted OpenAI-compatible endpoint (e.g. LiteLLM, vLLM)."
          tag="endpoint"
        >
          <input className="pss__input" defaultValue="https://api.openai.com/v1" />
        </Row>

        <Row
          label="Connection test"
          sub="Calls GET /v1/models on the configured API endpoint and reports the available models."
          tag="test"
        >
          <div className="pss__test">
            <span className="pss__test-icon">X</span>
            <div className="pss__test-l">
              <span className="pss__test-cmd">api.openai.com/v1/models</span>
              <span className="pss__test-sub">GET /v1/models · 47 models · text-embedding-3-small available</span>
            </div>
            <div className="pss__test-r">
              <span className="pss__badge is-using">PASS</span>
              <button className="pss__test-btn" type="button">Test</button>
            </div>
          </div>
        </Row>
      </Card>

      <div className="pss__footer">
        <span className="pss__footer-status">All changes saved automatically</span>
        <button className="pss__top-btn" type="button">Reset to defaults</button>
      </div>
    </>
  );
}

// ============================================================
// Settings shell — picks which page to render
// ============================================================
function Settings({ initialPage = "output" }) {
  const all = CATEGORIES.flatMap(c => c.items);
  const here = (all.find(i => i.id === initialPage) || all[0]).name;
  let page;
  switch (initialPage) {
    case "hotkeys": page = <HotkeysPage />; break;
    case "ai":      page = <AIProvidersPage />; break;
    case "output":
    default:        page = <OutputPage />; break;
  }
  return (
    <div className="pss" data-screen-label="Settings">
      <TitleBar here={here} />
      <Sidebar active={initialPage} />
      <main className="pss__main">{page}</main>
    </div>
  );
}

window.PS = window.PS || {};
Object.assign(window.PS, { Settings });
