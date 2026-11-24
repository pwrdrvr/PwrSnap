// Settings → Support → Troubleshooting (page id `developer`, kept so deep
// links that already name it keep working).
//
// The same page PwrAgent and PwrGit call Troubleshooting, in the same
// order: Chrome DevTools (Developer Mode) first, then logs, then CPU and
// heap monitoring. The backing settings remain under `general.*` for
// compatibility with the existing menu code and settings files.

import { useEffect, useState, type ReactElement } from "react";
import type {
  HotCpuProfileStartDelayMs
} from "@pwrsnap/shared";
import { desktopFileManagerName, hotCpuRulesCadenceMs, migrateHotCpuCaptureRules } from "@pwrsnap/shared";
import { dispatch } from "../../../lib/pwrsnap";
import { Card, Row, Switch } from "../components";
import { HotCpuCaptureRulesRow } from "./HotCpuCaptureRules";
import { useSettingsContext } from "../SettingsContext";
import { settingsGroupOf, settingsPageName } from "../settings-categories";

const START_DELAY_OPTIONS: readonly {
  label: string;
  meta: string;
  value: HotCpuProfileStartDelayMs;
}[] = [
  { label: "Immediate", meta: "Arm now", value: 0 },
  { label: "5 seconds", meta: "Short setup", value: 5_000 },
  { label: "10 seconds", meta: "Long setup", value: 10_000 }
];

const HEAP_SNAPSHOT_LIMIT_OPTIONS: readonly {
  label: string;
  meta: string;
  value: number;
}[] = [
  { label: "2 snapshots", meta: "Start + stop", value: 2 },
  { label: "3 snapshots", meta: "Extra sample", value: 3 }
];

function formatStartDelay(delayMs: HotCpuProfileStartDelayMs): string {
  return delayMs === 0 ? "Immediate" : `Delay ${Math.round(delayMs / 1_000)}s`;
}

function SegmentButtons<T extends string | number>({
  ariaLabel,
  disabled,
  options,
  value,
  onChange
}: {
  ariaLabel: string;
  disabled?: boolean;
  options: readonly { label: string; meta: string; value: T }[];
  value: T;
  onChange: (next: T) => void;
}): ReactElement {
  return (
    <div className="pss__seg" role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={active}
            className={"pss__seg-btn pss__seg-btn--stacked" + (active ? " is-active" : "")}
            disabled={disabled}
            onClick={() => onChange(option.value)}
          >
            <span>{option.label}</span>
            <span className="pss__seg-meta">{option.meta}</span>
          </button>
        );
      })}
    </div>
  );
}

export function DeveloperPage(): ReactElement {
  const { settings, patch } = useSettingsContext();
  const ready = settings !== null;
  const developerMode = settings?.general.developerMode ?? false;
  const environment = settings?.hotCpuProfilingEnvironment;
  const captureHeapSnapshot = settings?.general.hotCpuProfilingCaptureHeapSnapshot ?? false;
  const hotCpuEnabled = environment?.armed || settings?.general.hotCpuProfilingEnabled || captureHeapSnapshot;
  const startDelayMs = settings?.general.hotCpuProfilingStartDelayMs ?? 0;
  const rules = settings?.general.hotCpuProfilingRules ?? migrateHotCpuCaptureRules(
    settings?.general.hotCpuProfilingTriggerMode, settings?.general.hotCpuProfilingSlowburnThresholdPercent
  );
  const cadenceMs = environment?.rules?.cadenceMs ?? hotCpuRulesCadenceMs(rules);
  const captureChromiumTrace = environment?.chromiumTrace ?? settings?.general.hotCpuProfilingCaptureChromiumTrace ?? false;
  const heapSnapshotLimit = settings?.general.hotCpuProfilingHeapSnapshotLimit ?? 2;
  const [countdownEndsAt, setCountdownEndsAt] = useState<number | null>(null);
  const [countdownRemainingMs, setCountdownRemainingMs] = useState(0);
  const [diagnosticsStatus, setDiagnosticsStatus] = useState<string | null>(null);
  const [revealingDiagnostics, setRevealingDiagnostics] = useState(false);
  const [logsStatus, setLogsStatus] = useState<string | null>(null);

  useEffect(() => {
    if (countdownEndsAt === null) return;
    const updateCountdown = (): void => {
      const remainingMs = Math.max(0, countdownEndsAt - Date.now());
      setCountdownRemainingMs(remainingMs);
      if (remainingMs === 0) setCountdownEndsAt(null);
    };
    updateCountdown();
    const interval = window.setInterval(updateCountdown, 250);
    return () => window.clearInterval(interval);
  }, [countdownEndsAt]);

  const countdownActive = countdownRemainingMs > 0;
  const countdownSeconds = Math.ceil(countdownRemainingMs / 1_000);
  const startDelayText = formatStartDelay(startDelayMs);

  const startHotCpuCapture = async (): Promise<void> => {
    await patch({ general: { hotCpuProfilingEnabled: true } });
    if (startDelayMs > 0) {
      const endsAt = Date.now() + startDelayMs;
      setCountdownEndsAt(endsAt);
      setCountdownRemainingMs(startDelayMs);
    } else {
      setCountdownEndsAt(null);
      setCountdownRemainingMs(0);
    }
  };

  const stopHotCpuCapture = async (): Promise<void> => {
    setCountdownEndsAt(null);
    setCountdownRemainingMs(0);
    await patch({ general: { hotCpuProfilingEnabled: false, hotCpuProfilingCaptureHeapSnapshot: false } });
  };

  const revealDiagnosticsRoot = async (): Promise<void> => {
    if (!ready || revealingDiagnostics) return;
    setDiagnosticsStatus(null);
    setRevealingDiagnostics(true);
    try {
      const result = await dispatch("diagnostics:revealHotCpuRoot", {});
      if (!result.ok) {
        setDiagnosticsStatus(`Reveal failed: ${result.error.message}`);
      }
    } finally {
      setRevealingDiagnostics(false);
    }
  };

  return (
    <>
      <div className="pss__main-hdr">
        <div className="pss__main-hdr-l">
          <div className="pss__main-eyebrow">{settingsGroupOf("developer")}</div>
          <h1 className="pss__main-title">{settingsPageName("developer")}</h1>
          <p className="pss__main-sub">
            Developer tools, logs and CPU diagnostics, for when something is
            slow or broken.
          </p>
        </div>
      </div>

      <Card eyebrow="TROUBLESHOOTING" title="Chrome DevTools">
        <Row
          label="Developer Mode"
          sub="Adds Reload, Force Reload and Toggle Developer Tools to the View menu."
        >
          <Switch
            on={developerMode}
            label="Developer Mode"
            onChange={
              ready
                ? (next) => {
                    void patch({ general: { developerMode: next } });
                  }
                : undefined
            }
          />
        </Row>
      </Card>

      <Card eyebrow="TROUBLESHOOTING" title="Logs">
        <Row
          label="App log"
          sub="Recent events from PwrSnap. Include it when you report a problem."
        >
          <div className="pss__update-channel">
            <div className="pss__btn-row">
              <button
                className="pss__top-btn"
                type="button"
                onClick={() => {
                  setLogsStatus(null);
                  void dispatch("logs:openWindow", {}).then((result) => {
                    if (!result.ok) setLogsStatus(`Couldn't open the Logs window: ${result.error.message}`);
                  });
                }}
              >
                Open Logs
              </button>
              <button
                className="pss__top-btn"
                type="button"
                onClick={() => {
                  setLogsStatus(null);
                  void dispatch("logs:revealFile", {}).then((result) => {
                    if (!result.ok) setLogsStatus(`Couldn't reveal the log file: ${result.error.message}`);
                  });
                }}
              >
                Reveal Log File
              </button>
            </div>
            {logsStatus !== null ? (
              <span className="pss__update-note" role="status">
                {logsStatus}
              </span>
            ) : null}
          </div>
        </Row>
      </Card>

      <Card eyebrow="TROUBLESHOOTING" title="CPU and heap monitoring">
        <Row
          label="CPU profile capture"
          sub="Arms the Library renderer and main-process monitors; writes a DevTools .cpuprofile when a capture rule matches, with per-process CPU (incl. GPU) in the session samples."
        >
          <div className="pss__update-channel">
            {hotCpuEnabled || countdownActive ? (
              <button
                className="pss__top-btn"
                type="button"
                disabled={!ready || environment?.armed === true}
                onClick={() => {
                  void stopHotCpuCapture();
                }}
              >
                Stop Capture
              </button>
            ) : (
              <button
                className="pss__top-btn is-active"
                type="button"
                disabled={!ready}
                onClick={() => {
                  void startHotCpuCapture();
                }}
              >
                Start Capture ({startDelayText})
              </button>
            )}
            <span className="pss__update-note" aria-live="polite">
              {countdownActive
                ? `Starting in ${countdownSeconds}s`
                : hotCpuEnabled
                  ? `${environment?.armed ? "Armed by environment" : "Monitoring"} · samples every ${cadenceMs / 1000} s`
                  : "Artifacts save under the diagnostics folder in app data."}
            </span>
          </div>
        </Row>

        <Row
          label="Profiling start delay"
          sub="Wait before sampling begins so you can switch to the scenario you want to capture."
        >
          <SegmentButtons
            ariaLabel="Profiling start delay"
            disabled={!ready}
            options={START_DELAY_OPTIONS}
            value={startDelayMs}
            onChange={(next) => {
              void patch({ general: { hotCpuProfilingStartDelayMs: next } });
            }}
          />
        </Row>

        <HotCpuCaptureRulesRow rules={rules} environment={environment?.rules} disabled={!ready}
          onChange={(next) => patch({ general: { hotCpuProfilingRules: next } })} />

        <Row
          label="Chromium trace"
          sub="Keep a rolling trace of renderer layout, paint, and compositor events while capture is armed. Saves a filtered trace beside the renderer profile when a trace is available."
        >
          <Switch on={captureChromiumTrace} label="Chromium trace"
            disabled={!ready || environment?.chromiumTrace !== undefined}
            onChange={(next) => { void patch({ general: { hotCpuProfilingCaptureChromiumTrace: next } }); }} />
          <span className="pss__update-note">
            {environment?.chromiumTrace !== undefined
              ? "Set by PWRSNAP_HOT_CPU_PROFILING_CHROMIUM_TRACE."
              : "Off by default. Recording adds overhead, so turn it off after investigating."}
          </span>
        </Row>

        <Row
          label="Smart heap snapshots"
          sub="Capture bounded heap snapshots around the next hot CPU trigger, then turn this option back off."
        >
          <Switch
            on={captureHeapSnapshot}
            label="Smart heap snapshots"
            onChange={
              ready
                ? (next) => {
                    void patch({
                      general: { hotCpuProfilingCaptureHeapSnapshot: next }
                    });
                  }
                : undefined
            }
          />
        </Row>

        <Row
          label="Heap snapshot limit"
          sub="Keep emergency heap capture small enough to avoid filling disk or repeatedly stalling the app."
        >
          <SegmentButtons
            ariaLabel="Heap snapshot limit"
            disabled={!ready || !captureHeapSnapshot}
            options={HEAP_SNAPSHOT_LIMIT_OPTIONS}
            value={heapSnapshotLimit}
            onChange={(next) => {
              void patch({ general: { hotCpuProfilingHeapSnapshotLimit: next } });
            }}
          />
        </Row>

        <Row
          label="Diagnostics folder"
          sub={`Reveal captured CPU profiles, heap snapshots, and sidecar logs in ${desktopFileManagerName(window.pwrsnapApi?.platform)}.`}
        >
          <div className="pss__update-channel">
            <button
              className="pss__top-btn"
              type="button"
              disabled={!ready || revealingDiagnostics}
              onClick={() => {
                void revealDiagnosticsRoot();
              }}
            >
              {revealingDiagnostics ? "Revealing..." : "Reveal Folder"}
            </button>
            {diagnosticsStatus !== null ? (
              <span className="pss__update-note" aria-live="polite">
                {diagnosticsStatus}
              </span>
            ) : null}
          </div>
        </Row>
      </Card>
    </>
  );
}
