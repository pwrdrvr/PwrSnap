// Settings → Developer.
//
// Keeps developer-only application menu controls and hot renderer CPU
// diagnostics out of the default General page. The backing settings
// remain under `general.*` for compatibility with the existing menu
// code and settings files; this page is just the advanced developer UI.

import { useEffect, useState, type ReactElement } from "react";
import type {
  HotCpuProfileCleanupResult,
  HotCpuProfileStartDelayMs,
  HotCpuProfileTriggerMode
} from "@pwrsnap/shared";
import { dispatch } from "../../../lib/pwrsnap";
import { Card, Row, Switch } from "../components";
import { useSettingsContext } from "../SettingsContext";

const START_DELAY_OPTIONS: readonly {
  label: string;
  meta: string;
  value: HotCpuProfileStartDelayMs;
}[] = [
  { label: "Immediate", meta: "Arm now", value: 0 },
  { label: "5 seconds", meta: "Short setup", value: 5_000 },
  { label: "10 seconds", meta: "Long setup", value: 10_000 }
];

const TRIGGER_MODE_OPTIONS: readonly {
  label: string;
  meta: string;
  value: HotCpuProfileTriggerMode;
}[] = [
  { label: "Spike", meta: "> 50%", value: "spike" },
  { label: "Sustained", meta: "2x > 50%", value: "sustained" },
  { label: "Slowburn", meta: "2x > 15%", value: "slowburn" }
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
  const hotCpuEnabled = settings?.general.hotCpuProfilingEnabled ?? false;
  const startDelayMs = settings?.general.hotCpuProfilingStartDelayMs ?? 0;
  const triggerMode = settings?.general.hotCpuProfilingTriggerMode ?? "sustained";
  const slowburnThreshold =
    settings?.general.hotCpuProfilingSlowburnThresholdPercent ?? 15;
  const captureHeapSnapshot =
    settings?.general.hotCpuProfilingCaptureHeapSnapshot ?? false;
  const heapSnapshotLimit = settings?.general.hotCpuProfilingHeapSnapshotLimit ?? 2;
  const [countdownEndsAt, setCountdownEndsAt] = useState<number | null>(null);
  const [countdownRemainingMs, setCountdownRemainingMs] = useState(0);
  const [diagnosticsStatus, setDiagnosticsStatus] = useState<string | null>(null);
  const [diagnosticsAction, setDiagnosticsAction] = useState<
    "idle" | "revealing" | "clearing"
  >("idle");

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
  const diagnosticsBusy = diagnosticsAction !== "idle";
  const cleanupDisabled =
    !ready || diagnosticsBusy || hotCpuEnabled || captureHeapSnapshot || countdownActive;
  const hotCpuControlsDisabled = !ready || diagnosticsAction === "clearing";

  const startHotCpuCapture = async (): Promise<void> => {
    if (diagnosticsAction === "clearing") return;
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
    await patch({ general: { hotCpuProfilingEnabled: false } });
  };

  const revealDiagnosticsRoot = async (): Promise<void> => {
    if (!ready || diagnosticsBusy) return;
    setDiagnosticsStatus(null);
    setDiagnosticsAction("revealing");
    try {
      const result = await dispatch("diagnostics:revealHotCpuRoot", {});
      if (!result.ok) {
        setDiagnosticsStatus(`Reveal failed: ${result.error.message}`);
      }
    } finally {
      setDiagnosticsAction("idle");
    }
  };

  const clearDiagnostics = async (): Promise<void> => {
    if (cleanupDisabled) return;
    setDiagnosticsStatus(null);
    setDiagnosticsAction("clearing");
    try {
      const result = await dispatch("diagnostics:clearHotCpuSessions", {});
      if (!result.ok) {
        setDiagnosticsStatus(`Cleanup failed: ${result.error.message}`);
        return;
      }
      setDiagnosticsStatus(formatCleanupResult(result.value));
    } finally {
      setDiagnosticsAction("idle");
    }
  };

  return (
    <>
      <div className="pss__main-hdr">
        <div className="pss__main-hdr-l">
          <div className="pss__main-eyebrow">Advanced</div>
          <h1 className="pss__main-title">Developer</h1>
          <p className="pss__main-sub">
            Developer menu controls and diagnostics for troubleshooting hot renderers.
          </p>
        </div>
      </div>

      <Card eyebrow="DEVELOPER" title="Developer mode">
        <Row
          label="Show developer menu items"
          sub="Expose Reload, Force Reload, and Toggle Developer Tools in the View menu."
          tag="developer"
        >
          <Switch
            on={developerMode}
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

      <Card eyebrow="DIAGNOSTICS" title="Hot renderer CPU profiling">
        <Row
          label="CPU profile capture"
          sub="Arms the Library renderer monitor and writes a DevTools .cpuprofile when CPU stays hot."
          tag={hotCpuEnabled ? "monitoring" : "not armed"}
        >
          <div className="pss__update-channel">
            {hotCpuEnabled || countdownActive ? (
              <button
                className="pss__top-btn"
                type="button"
                disabled={hotCpuControlsDisabled}
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
                disabled={hotCpuControlsDisabled}
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
                  ? "Monitoring"
                  : "Artifacts save under the diagnostics folder in app data."}
            </span>
          </div>
        </Row>

        <Row
          label="Profiling start delay"
          sub="Wait before sampling begins so you can switch to the scenario you want to capture."
          tag={startDelayText.toLowerCase()}
        >
          <SegmentButtons
            ariaLabel="Profiling start delay"
            disabled={hotCpuControlsDisabled}
            options={START_DELAY_OPTIONS}
            value={startDelayMs}
            onChange={(next) => {
              void patch({ general: { hotCpuProfilingStartDelayMs: next } });
            }}
          />
        </Row>

        <Row
          label="CPU profile trigger"
          sub={`Slowburn uses ${slowburnThreshold}% across the same consecutive-sample window.`}
          tag={triggerMode}
        >
          <SegmentButtons
            ariaLabel="CPU profile trigger"
            disabled={hotCpuControlsDisabled}
            options={TRIGGER_MODE_OPTIONS}
            value={triggerMode}
            onChange={(next) => {
              void patch({ general: { hotCpuProfilingTriggerMode: next } });
            }}
          />
        </Row>

        <Row
          label="Smart heap snapshots"
          sub="Capture bounded heap snapshots around the next hot CPU trigger, then turn this option back off."
          tag="memory"
        >
          <Switch
            on={captureHeapSnapshot}
            onChange={
              !hotCpuControlsDisabled
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
          tag={`${heapSnapshotLimit}`}
        >
          <SegmentButtons
            ariaLabel="Heap snapshot limit"
            disabled={hotCpuControlsDisabled || !captureHeapSnapshot}
            options={HEAP_SNAPSHOT_LIMIT_OPTIONS}
            value={heapSnapshotLimit}
            onChange={(next) => {
              void patch({ general: { hotCpuProfilingHeapSnapshotLimit: next } });
            }}
          />
        </Row>

        <Row
          label="Diagnostics folder"
          sub="Reveal captured CPU profiles, heap snapshots, and sidecar logs in Finder."
          tag="folder"
        >
          <div className="pss__update-channel">
            <button
              className="pss__top-btn"
              type="button"
              disabled={!ready || diagnosticsBusy}
              onClick={() => {
                void revealDiagnosticsRoot();
              }}
            >
              Reveal Folder
            </button>
            <button
              className="pss__top-btn"
              type="button"
              disabled={cleanupDisabled}
              onClick={() => {
                void clearDiagnostics();
              }}
            >
              Clear Old Sessions
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

function formatCleanupResult(result: HotCpuProfileCleanupResult): string {
  const deleted = result.deletedSessions;
  const skipped = result.skippedEntries;
  const suffix =
    result.errors.length > 0 ? `, ${result.errors.length} errors` : "";
  return `Cleared ${deleted} session${deleted === 1 ? "" : "s"}; skipped ${skipped}${suffix}.`;
}
