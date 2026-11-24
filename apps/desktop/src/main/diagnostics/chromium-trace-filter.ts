import { addAbortListener } from "node:events";
import { utilityProcess } from "electron";
import type { ChromiumTraceFilterRequest } from "./chromium-trace-worker";

export function startChromiumTraceFilter(module: string, request: ChromiumTraceFilterRequest, signal: AbortSignal) {
  signal.throwIfAborted();
  // Moving the Worker out of the browser PID keeps its CPU out of the main
  // profiler's trigger while retaining its V8 heap limit.
  const child = utilityProcess.fork(module, [], {
    serviceName: "PwrSnap Chromium trace filter",
    stdio: "ignore"
  });
  let stopping = false;
  let running = true;
  let cpuMs: number | undefined;
  function stop(): void {
    if (stopping || !running) return;
    stopping = true;
    // If cancellation precedes spawn, the spawn handler will terminate it.
    if (child.pid !== undefined) child.kill();
  }
  const cancellation = addAbortListener(signal, stop);
  const exited = new Promise<number | undefined>((resolve) => {
    child.once("spawn", () => {
      if (stopping) child.kill();
      else child.postMessage(request);
    });
    child.once("message", (message: unknown) => {
      if (stopping || !running) return;
      if (typeof message === "number" && Number.isFinite(message) && message >= 0) cpuMs = message;
      stop();
    });
    // The diagnostic report can contain private data. Exit settles the job.
    child.once("error", () => {
      cpuMs = undefined;
      stop();
    });
    child.once("exit", () => {
      cancellation[Symbol.dispose]();
      running = false;
      resolve(cpuMs);
    });
  });
  return { exited, stop, get running() { return running; } };
}
