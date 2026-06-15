// Library-side connection to the supervising agent process (plan
// 2026-06-12-001 §D2/D4). The supervisor spawned us with a Node IPC
// pipe on fd 3; connecting attaches the bridge endpoint over it and —
// because boot calls this AFTER command handlers register — doubles as
// the readiness hello the agent's dispatch gate waits on.

import { BrowserWindow, app } from "electron";
import { err, type PwrSnapError, type Result } from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { broadcastRendererEventToLocalWindows } from "../events";
import { getMainLogger } from "../log";
import { channelForParentProcess } from "../process-bridge/channel";
import { BridgeEndpoint } from "../process-bridge/endpoint";
import { deliverRelayedRendererEventToMain } from "./event-relay";

const log = getMainLogger("pwrsnap:agent-bridge");

let endpoint: BridgeEndpoint | null = null;
let pipeAlive = false;

/**
 * Attach to the parent pipe. Returns false when there is no parent —
 * a `--pwrsnap-role=library` launched by hand (dev convenience); the
 * window still works, but agent-owned commands fail with
 * `bridge_unavailable`.
 */
export function connectAgentBridge(): boolean {
  if (endpoint !== null) return true;
  if (typeof process.send !== "function") {
    log.warn("no parent IPC pipe — library running standalone, agent commands unavailable");
    return false;
  }
  log.info("connectAgentBridge: attaching to parent pipe");
  const channel = channelForParentProcess();
  pipeAlive = true;
  // Orphan guard: a clean agent quit kills this process explicitly, so
  // a dropped pipe means the agent crashed (or was force-killed). A
  // windowless library has no reason to outlive its agent — and a
  // fresh user launch would start a NEW agent that respawns its own
  // child, leaving this one a zombie. With visible windows, let the
  // user finish; window-all-closed (index.ts) quits when the bridge is
  // dead. Hidden utility windows (text-bake pool) don't count.
  channel.onClose(() => {
    pipeAlive = false;
    const visibleWindows = BrowserWindow.getAllWindows().filter((w) => w.isVisible());
    if (visibleWindows.length === 0) {
      log.warn("agent pipe closed with no visible windows — quitting orphaned library");
      app.quit();
      return;
    }
    log.warn("agent pipe closed — library orphaned; quitting when last window closes");
  });
  endpoint = new BridgeEndpoint({
    role: "library",
    channel,
    dispatchLocal: (name, req) => {
      // DIAG (cold-launch race): proves a bridge request (e.g.
      // library:focus) actually reached the library, and brackets the
      // synchronous dispatch so a stall inside it is attributable.
      log.info("bridge dispatchLocal: begin", { name });
      const result = bus.dispatch(name as never, req as never, { principal: "bridge" });
      void result.finally(() => log.info("bridge dispatchLocal: settled", { name }));
      return result;
    },
    onRemoteEvent: (channel_, payload) => {
      broadcastRendererEventToLocalWindows(channel_, payload);
      deliverRelayedRendererEventToMain(channel_, payload);
    },
    onRemoteCancel: (key) => {
      bus.cancel(key);
    },
    warn: (message, meta) => log.warn(message, meta)
  });
  return true;
}

/** True while the parent pipe is attached AND alive. The bus
 *  forwarder gates on this, and window-all-closed quits an orphaned
 *  library instead of idling with a dead bridge. */
export function isAgentBridgeConnected(): boolean {
  return endpoint !== null && pipeAlive;
}

/** The library's RemoteCommandForwarder body. Never rejects. */
export async function dispatchToAgentProcess(
  name: string,
  req: unknown
): Promise<Result<unknown, PwrSnapError>> {
  if (endpoint === null) {
    return err({
      kind: "unknown",
      code: "bridge_unavailable",
      message: `no agent bridge; cannot dispatch ${name}`
    });
  }
  return endpoint.dispatchRemote(name, req);
}

/** Renderer-event relay toward the agent (e.g. library edits → the
 *  float-over refreshes its record). */
export function forwardRendererEventToAgent(channel: string, payload: unknown): void {
  endpoint?.emitEvent(channel, payload);
}

/** Cancellation relay toward the agent — a capture deleted here must
 *  abort the agent's in-flight enrichment for it. */
export function forwardCancellationToAgent(key: string): void {
  endpoint?.cancelRemote(key);
}
