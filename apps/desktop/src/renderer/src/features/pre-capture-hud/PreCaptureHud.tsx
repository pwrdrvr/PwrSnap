import { useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { EVENT_CHANNELS, type PreCaptureHudState } from "@pwrsnap/shared";

type HudCopy = Readonly<{ eyebrow: string; title: string; detail: string }>;

export function preCaptureHudCopy(
  state: PreCaptureHudState,
  platform: string
): HudCopy {
  const subject = state.intent === "video" ? "Screen recording" : "Screen capture";
  switch (state.phase) {
    case "preparing":
      return {
        eyebrow: subject,
        title: "Preparing PwrSnap…",
        detail: "Getting capture tools ready"
      };
    case "permission":
      return {
        eyebrow: subject,
        title:
          platform === "darwin"
            ? "Checking Screen Recording access…"
            : "Checking screen capture readiness…",
        detail:
          platform === "darwin"
            ? "macOS may ask you to approve access"
            : "Verifying this display can be captured"
      };
    case "storage":
      return {
        eyebrow: subject,
        title: "Checking save location…",
        detail: "Making sure your capture folder is writable"
      };
    case "countdown":
      return {
        eyebrow: subject,
        title: `Capture in ${state.secondsRemaining}…`,
        detail: "Stage the menu, tooltip, or window you want to capture"
      };
    case "selector-handoff":
      return {
        eyebrow: subject,
        title: "Opening the selector…",
        detail: "Choose an area or window"
      };
    case "blocked":
      if (state.reason === "permission") {
        return {
          eyebrow: `${subject} paused`,
          title: "Screen access is needed",
          detail:
            platform === "darwin"
              ? "Follow the macOS permission prompt, then try again"
              : "Check Windows privacy settings, then try again"
        };
      }
      if (state.reason === "storage") {
        return {
          eyebrow: `${subject} paused`,
          title: "The capture folder is unavailable",
          detail: "Check folder access, then try again"
        };
      }
      return {
        eyebrow: `${subject} stopped`,
        title: "PwrSnap couldn’t start the capture",
        detail: "Nothing was captured; try again"
      };
  }
}

function isHudState(value: unknown): value is PreCaptureHudState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    runId?: unknown;
    intent?: unknown;
    phase?: unknown;
    secondsRemaining?: unknown;
    reason?: unknown;
  };
  if (
    typeof candidate.runId !== "number" ||
    !Number.isFinite(candidate.runId) ||
    (candidate.intent !== "snap" && candidate.intent !== "video")
  ) return false;
  if (candidate.phase === "countdown") {
    return (
      typeof candidate.secondsRemaining === "number" &&
      Number.isFinite(candidate.secondsRemaining) &&
      candidate.secondsRemaining > 0
    );
  }
  if (candidate.phase === "blocked") {
    return (
      candidate.reason === "permission" ||
      candidate.reason === "storage" ||
      candidate.reason === "unexpected"
    );
  }
  return (
    candidate.phase === "preparing" ||
    candidate.phase === "permission" ||
    candidate.phase === "storage" ||
    candidate.phase === "selector-handoff"
  );
}

export function PreCaptureHud(): ReactElement | null {
  const [state, setState] = useState<PreCaptureHudState | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const unsubscribe = window.pwrsnapApi?.on(
      EVENT_CHANNELS.preCaptureHudState,
      (payload) => {
        if (isHudState(payload)) setState(payload);
      }
    );
    window.pwrsnapApi?.notifyPreCaptureHudReady();
    return () => unsubscribe?.();
  }, []);

  useLayoutEffect(() => {
    const element = wrapperRef.current;
    if (element === null) return;
    let postedWidth = -1;
    let postedHeight = -1;
    const post = (): void => {
      const rect = element.getBoundingClientRect();
      const width = Math.ceil(rect.width);
      const height = Math.ceil(rect.height);
      if (width === postedWidth && height === postedHeight) return;
      postedWidth = width;
      postedHeight = height;
      window.pwrsnapApi?.requestPreCaptureHudResize({ width, height });
    };
    post();
    const observer = new ResizeObserver(post);
    observer.observe(element);
    return () => observer.disconnect();
  }, [state]);

  if (state === null) return null;
  const copy = preCaptureHudCopy(state, window.pwrsnapApi?.platform ?? "unknown");
  const blocked = state.phase === "blocked";

  return (
    <div ref={wrapperRef} className="pch-measurer">
      <section
        className={`pch${blocked ? " pch--blocked" : ""}`}
        role={blocked ? "alert" : "status"}
        aria-live={blocked ? "assertive" : "polite"}
        aria-atomic="true"
        data-phase={state.phase}
      >
        <div className="pch__indicator" aria-hidden="true">
          {blocked ? "!" : <span className="pch__spinner" />}
        </div>
        <div className="pch__copy">
          <div className="pch__eyebrow">{copy.eyebrow}</div>
          <div className="pch__title">{copy.title}</div>
          <div className="pch__detail">{copy.detail}</div>
        </div>
      </section>
    </div>
  );
}
