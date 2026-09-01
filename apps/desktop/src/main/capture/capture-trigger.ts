import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  createCaptureInvocation,
  type CaptureInvocationOrigin
} from "@pwrsnap/shared";
import { bus, type CommandDispatchOptions } from "../command-bus";

export function dispatchInteractiveCapture(
  origin: CaptureInvocationOrigin,
  mode: "auto" | "region" | "window" | "timed",
  options: CommandDispatchOptions = { principal: "ipc" }
) {
  const invocation = createCaptureInvocation({
    id: randomUUID(),
    origin,
    monotonicNow: () => performance.timeOrigin + performance.now()
  });
  return bus.dispatch("capture:interactive", { mode, invocation }, options);
}
