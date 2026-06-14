import { useEffect, useState } from "react";
import { EVENT_CHANNELS, type CapturePresetMetric, type RenderPreset } from "@pwrsnap/shared";
import { dispatch, subscribe } from "../../lib/pwrsnap";
import {
  exactPresetMetrics,
  type CopyButtonMetric,
  type CopyPreset
} from "./CopyButton";

export type PresetMetricMap = Partial<Record<CopyPreset, CopyButtonMetric>>;

export function usePresetRenderMetrics(
  captureId: string | null,
  overlaysVersion: number | null
): PresetMetricMap {
  const [metrics, setMetrics] = useState<PresetMetricMap>({});

  useEffect(() => {
    if (captureId === null) {
      setMetrics({});
      return undefined;
    }

    let cancelled = false;
    const fetchMetrics = (): void => {
      void dispatch("capture:presetMetrics", { captureId }).then((result) => {
        if (cancelled) return;
        if (!result.ok) return;
        setMetrics(metricsByPreset(result.value.metrics));
      });
    };

    setMetrics({});
    fetchMetrics();

    // Re-measure when settings change. The experimental DPI-aware export
    // toggle resolves a preset to a different output width, so main
    // returns different byteSizes; without this the card would keep the
    // prior mode's numbers until the next capture selection. The render
    // cache is width-keyed, so toggling never reuses a stale render — but
    // this in-memory snapshot still has to refetch. We don't clear first:
    // the prior numbers stay visible until the fresh ones land (no flash),
    // and refetches are cheap (cache-backed).
    const unsubscribe = subscribe(EVENT_CHANNELS.settingsChanged, () => fetchMetrics());

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [captureId, overlaysVersion]);

  return metrics;
}

function metricsByPreset(metrics: readonly CapturePresetMetric[]): PresetMetricMap {
  const byPreset: PresetMetricMap = {};
  for (const metric of metrics) {
    byPreset[toCopyPreset(metric.preset)] = exactPresetMetrics(metric);
  }
  return byPreset;
}

function toCopyPreset(preset: RenderPreset): CopyPreset {
  return preset;
}
