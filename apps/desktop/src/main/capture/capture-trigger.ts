import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  createCaptureInvocationTrigger,
  finalizeCaptureInvocation,
  type CaptureInvocationTrigger,
  type CaptureInvocationOrigin
} from "@pwrsnap/shared";
import { bus, type CommandDispatchOptions } from "../command-bus";

const monotonicNow = (): number => performance.timeOrigin + performance.now();

export function createInteractiveCaptureTrigger(
  origin: CaptureInvocationOrigin
): CaptureInvocationTrigger {
  return createCaptureInvocationTrigger({
    id: randomUUID(),
    origin,
    monotonicNow
  });
}

export function dispatchInteractiveCapture(
  triggerOrOrigin: CaptureInvocationTrigger | CaptureInvocationOrigin,
  mode: "auto" | "region" | "window" | "timed",
  options: CommandDispatchOptions = { principal: "ipc" }
) {
  const trigger =
    typeof triggerOrOrigin === "string"
      ? createInteractiveCaptureTrigger(triggerOrOrigin)
      : triggerOrOrigin;
  const invocation = finalizeCaptureInvocation(trigger, monotonicNow);
  return bus.dispatch("capture:interactive", { mode, invocation }, options);
}
