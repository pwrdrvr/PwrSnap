import { utilityProcess } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  TimelineRenderRequest,
  TimelineRenderResult,
} from "./timeline-render";

export async function renderTimelineInChild(
  request: TimelineRenderRequest,
  signal: AbortSignal,
  progress?: (ratio: number) => void,
): Promise<TimelineRenderResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "sizzle-timeline-worker.js",
      ),
      [],
      { serviceName: "PwrSnap Sizzle renderer", stdio: "ignore" },
    );
    let result: TimelineRenderResult | null = null;
    let failure: Error | null = null;
    const cancel = (): void => {
      child.postMessage({ kind: "cancel" });
    };
    signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => {
      failure = new Error("Timeline render timed out");
      cancel();
    }, 30 * 60_000);
    child.on(
      "message",
      (message: {
        kind: string;
        ratio?: number;
        result?: TimelineRenderResult;
        message?: string;
      }) => {
        if (message.kind === "progress" && message.ratio !== undefined)
          progress?.(message.ratio);
        if (message.kind === "done") {
          result = message.result ?? null;
          child.kill();
        }
        if (message.kind === "error") {
          failure = new Error(message.message);
          child.kill();
        }
      },
    );
    // Await process exit: cache cleanup must drain the worker before deleting
    // anything, including its last staging file.
    child.on("exit", () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      if (signal.aborted) reject(new Error("Render cancelled"));
      else if (failure) reject(failure);
      else if (result) resolve(result);
      else
        reject(new Error("Timeline render process exited before completion"));
    });
    child.once("spawn", () => {
      child.postMessage({ kind: "render", request });
      if (signal.aborted) cancel();
    });
  });
}
