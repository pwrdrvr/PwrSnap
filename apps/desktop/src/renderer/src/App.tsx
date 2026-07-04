import { AppDocumentWindow } from "./features/documents/AppDocumentWindow";
import { Library } from "./features/library/Library";
import { CapturesAccessBanner } from "./features/library/CapturesAccessBanner";
import { CartProvider } from "./features/library/CartContext";
import { HotCpuProfileBanner } from "./features/library/HotCpuProfileBanner";
import { FloatOverHost } from "./features/float-over/FloatOverHost";
import { RecordingController } from "./features/recording/RecordingController";
import { RegionSelector } from "./features/region/RegionSelector";
import { SettingsApp } from "./features/settings/SettingsApp";
import { SizzleApp } from "./features/sizzle/SizzleApp";
import { TrayMenu } from "./features/tray/TrayMenu";
import { AppUpdateBanner } from "./features/update/AppUpdateBanner";
import { RendererErrorBoundary } from "./RendererErrorBoundary";
import { useAppearanceSync } from "./lib/useAppearance";
import { useEditMenuBridge } from "./lib/editMenuBridge";
import { usePreventBrowserZoom } from "./lib/usePreventBrowserZoom";

type Stage =
  | "library"
  | "float-over"
  | "tray"
  | "region"
  | "settings"
  | "sizzle"
  | "document"
  | "recording-controller";
type AppDocumentKind = "changelog" | "third-party-licenses";

function readStage(): Stage {
  const hash = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(hash);
  const v = params.get("stage");
  if (
    v === "tray" ||
    v === "float-over" ||
    v === "region" ||
    v === "settings" ||
    v === "sizzle" ||
    v === "document" ||
    v === "recording-controller"
  ) {
    return v;
  }
  return "library";
}

function readDocumentKind(): AppDocumentKind | null {
  const hash = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(hash);
  const kind = params.get("kind");
  if (kind === "changelog" || kind === "third-party-licenses") {
    return kind;
  }
  return null;
}

const STAGE = readStage();
const DOCUMENT_KIND = readDocumentKind();
document.body.dataset.stage = STAGE;

// Distinct document.title per stage. Every PwrSnap window loads
// the same `index.html` whose `<title>` tag would otherwise stamp
// EVERY window as "PwrSnap" — including the ones that show up in
// the dock right-click menu's window list. Tray, float-over, and
// the region selector are hidden via `skipTaskbar: true` so their
// titles don't matter, but the library + edit windows are
// user-facing and need to read sensibly when the user is hunting
// for one in the dock list. setting document.title overrides the
// HTML one and propagates through Electron's BrowserWindow.title.
const TITLE_BY_STAGE: Record<Stage, string> = {
  library: "PwrSnap",
  tray: "PwrSnap Tray",
  "float-over": "PwrSnap Toast",
  region: "PwrSnap Capture",
  settings: "PwrSnap Settings",
  sizzle: "PwrSnap Sizzle Reels",
  "recording-controller": "PwrSnap Recording",
  document:
    DOCUMENT_KIND === "third-party-licenses"
      ? "PwrSnap Third-party Licenses"
      : "PwrSnap Changelog"
};
document.title = TITLE_BY_STAGE[STAGE] ?? "PwrSnap";

export function App() {
  // Wire the appearance / theme system once per BrowserWindow. The
  // hook keeps `<html data-theme>` in sync with the persisted
  // Settings.appearance.theme, listens for OS `prefers-color-scheme`
  // flips while theme === "system", and propagates cross-window
  // theme changes via the Settings broadcast. Return value is unused
  // at this level — the Appearance settings page reads from its own
  // `useSettings` snapshot to render the segmented control.
  useAppearanceSync();

  // Bridge the native Edit ▸ Undo / Edit ▸ Redo menu items (and the
  // Windows/Linux Ctrl+Y redo accelerator) to the right undo system,
  // focus-aware. Mounted once per BrowserWindow here so text-field undo
  // keeps working in every surface and the editor's canvas undo is
  // reachable wherever the editor is mounted (the Library window's Focus
  // mode). See ./lib/editMenuBridge.ts.
  useEditMenuBridge();

  // Suppress Chromium's native visual page-zoom (trackpad pinch /
  // ctrl+wheel) on every surface. The preload arms visual zoom so the
  // editor receives the pinch gesture stream; without this guard a
  // pinch over the Library grid (or any non-editor surface) magnifies
  // the whole window — sidebar and title bar scroll off-screen and
  // don't come back. The editor's own canvas zoom is unaffected: it
  // reads the same events and never relies on the browser default.
  // See ./lib/usePreventBrowserZoom.ts.
  usePreventBrowserZoom();

  const app = (() => {
    if (STAGE === "tray") {
      return <TrayMenu activeMode="auto" />;
    }
    if (STAGE === "float-over") {
      return <FloatOverHost />;
    }
    if (STAGE === "region") {
      return <RegionSelector />;
    }
    if (STAGE === "settings") {
      return <SettingsApp />;
    }
    if (STAGE === "sizzle") {
      return <SizzleApp />;
    }
    if (STAGE === "recording-controller") {
      return <RecordingController />;
    }
    if (STAGE === "document") {
      return <AppDocumentWindow kind={DOCUMENT_KIND} />;
    }
    return (
      <div className="app-shell">
        <CartProvider>
          <Library />
        </CartProvider>
        {/* Floating toast stack, lower-left. Both notices float OVER the
            Library rather than pushing its content down, and stay clear of
            the post-capture float-over (its own bottom-right window). Each
            banner carries its own role/aria-live, so the wrapper stays a
            neutral container. */}
        <div className="app-toast-stack">
          <CapturesAccessBanner />
          <HotCpuProfileBanner />
          <AppUpdateBanner />
        </div>
      </div>
    );
  })();

  return <RendererErrorBoundary stage={STAGE}>{app}</RendererErrorBoundary>;
}
