import { useEffect, useState } from "react";
import type { CapturePresetMetric, RenderPreset } from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";
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
    setMetrics({});
    void dispatch("capture:presetMetrics", { captureId }).then((result) => {
      if (cancelled) return;
      if (!result.ok) return;
      setMetrics(metricsByPreset(result.value.metrics));
    });

    return () => {
      cancelled = true;
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
