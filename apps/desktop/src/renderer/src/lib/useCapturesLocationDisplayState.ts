import { useEffect, useState } from "react";

import type {
  CapturesFolderLocation,
  CapturesLocationStatus
} from "@pwrsnap/shared";

import { dispatch } from "./pwrsnap";

export type CapturesLocationDisplayState = {
  location: CapturesFolderLocation;
  /** True also while status is unknown, so copy never invents a real path. */
  overridden: boolean;
};

export function useCapturesLocationDisplayState(
  fallbackLocation: CapturesFolderLocation
): CapturesLocationDisplayState {
  const [status, setStatus] = useState<CapturesLocationStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus(null);
    void dispatch("storage:capturesLocationStatus", {}).then((result) => {
      if (!cancelled && result.ok) setStatus(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, [fallbackLocation]);

  return {
    location: status?.location ?? fallbackLocation,
    overridden: status?.overridden ?? true
  };
}
