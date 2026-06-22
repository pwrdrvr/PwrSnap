// Settings → Experimental.
//
// Mirrors PwrAgnt's Experimental tab: a home for opt-in features that
// are still soaking and may change shape or be removed without notice.
// These cards used to live inline on the General page; they were pulled
// onto their own tab so the General page stays about everyday settings
// (appearance, startup, updates, developer mode) and the soak toggles
// are clearly fenced off as experiments.
//
// Each toggle writes through `useSettingsContext().patch`, which the
// main process validates and broadcasts back — same flow as every other
// settings control. `experimental.processSplit` is read once at process
// start (it determines the boot role), so flipping it only takes effect
// after PwrSnap is quit and relaunched; the other two resolve the export
// ladder at render time and apply immediately.

import type { ReactElement } from "react";
import { Card, Row, Switch } from "../components";
import { useSettingsContext } from "../SettingsContext";

export function ExperimentalPage(): ReactElement {
  const { settings, patch } = useSettingsContext();
  const ready = settings !== null;

  // macOS-only: the two-process split doesn't exist on other platforms
  // (the boot is always single-process there), so don't show a switch
  // that can't do anything.
  const isMac = window.pwrsnapApi?.platform === "darwin";

  const processSplit = settings?.experimental.processSplit ?? false;
  const dpiAwareExport = settings?.experimental.dpiAwareExport ?? false;
  const allowRetinaExport = settings?.experimental.allowRetinaExport ?? true;

  const onProcessSplitChange = ready
    ? (next: boolean): void => {
        void patch({ experimental: { processSplit: next } });
      }
    : undefined;

  const onDpiAwareExportChange = ready
    ? (next: boolean): void => {
        void patch({ experimental: { dpiAwareExport: next } });
      }
    : undefined;

  const onAllowRetinaExportChange = ready
    ? (next: boolean): void => {
        void patch({ experimental: { allowRetinaExport: next } });
      }
    : undefined;

  return (
    <>
      <div className="pss__main-hdr">
        <div className="pss__main-hdr-l">
          <div className="pss__main-eyebrow">Experimental</div>
          <h1 className="pss__main-title">Experimental</h1>
          <p className="pss__main-sub">
            Opt-in features that are still soaking — they may change shape or
            be removed without notice.
          </p>
        </div>
      </div>

      {isMac ? (
        <Card eyebrow="EXPERIMENTAL" title="Two-process mode">
          <Row
            label="Run the capture agent and Library as separate processes"
            sub="The menu-bar capture agent and the Library window run as separate apps, so capture overlays never disturb the Library or flash the Dock. Turn off to revert to single-process mode. Takes effect after PwrSnap is quit and relaunched."
            tag="process-split"
          >
            <Switch on={processSplit} onChange={onProcessSplitChange} />
          </Row>
        </Card>
      ) : null}

      <Card eyebrow="EXPERIMENTAL" title="DPI-aware export">
        <Row
          label="Scale exports by display resolution"
          sub="Maps Low / Med / High to 25% / 50% / 100% of the capture's pixels instead of the fixed 800 / 1440 / full widths. On a Retina display High is the full 2× image; Med lands at the on-screen (1×) size. Off by default — flip it on to try the new sizing."
          tag="experimental"
        >
          <Switch on={dpiAwareExport} onChange={onDpiAwareExportChange} />
        </Row>
        {dpiAwareExport ? (
          <Row
            label="Allow Retina export"
            sub="When on, High keeps the full Retina (2×) pixels. Turn off to cap exports at the on-screen 1× resolution — High becomes today's 50%, with two smaller sizes below it."
            tag="retina"
          >
            <Switch on={allowRetinaExport} onChange={onAllowRetinaExportChange} />
          </Row>
        ) : null}
      </Card>
    </>
  );
}
