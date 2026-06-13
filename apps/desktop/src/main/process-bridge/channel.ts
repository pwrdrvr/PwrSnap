// Transport abstraction under the process bridge. Production wraps the
// parent↔child Node IPC pipe (`child.send` / `process.send`); tests wire
// two endpoints together with `inMemoryChannelPair`. If the two-process
// architecture ever moves to separate bundles, this file is the only
// place that swaps a pipe for a socket.

import type { ChildProcess } from "node:child_process";
import type { BridgeMessage } from "./protocol";

export type BridgeChannel = {
  /** Send one message to the peer. Returns false if the pipe is gone. */
  send(message: BridgeMessage): boolean;
  /** Subscribe to raw incoming messages. Returns an unsubscribe. */
  onMessage(listener: (message: unknown) => void): () => void;
  /** Subscribe to channel close (peer exit/disconnect). Fires at most once. */
  onClose(listener: () => void): () => void;
};

/** De-dup guard: `disconnect` and `exit` both fire on a dying child. */
function once(listener: () => void): () => void {
  let fired = false;
  return () => {
    if (fired) return;
    fired = true;
    listener();
  };
}

/** Agent-side channel wrapping a supervised library child process. */
export function channelForChildProcess(child: ChildProcess): BridgeChannel {
  return {
    send(message) {
      if (child.connected !== true) return false;
      try {
        return child.send(message);
      } catch {
        return false;
      }
    },
    onMessage(listener) {
      child.on("message", listener);
      return () => {
        child.off("message", listener);
      };
    },
    onClose(listener) {
      const fire = once(listener);
      child.once("disconnect", fire);
      child.once("exit", fire);
      return () => {
        child.off("disconnect", fire);
        child.off("exit", fire);
      };
    }
  };
}

/** Library-side channel wrapping this process's pipe to the agent. */
export function channelForParentProcess(proc: NodeJS.Process = process): BridgeChannel {
  return {
    send(message) {
      if (typeof proc.send !== "function" || proc.connected !== true) return false;
      try {
        return proc.send(message);
      } catch {
        return false;
      }
    },
    onMessage(listener) {
      proc.on("message", listener);
      return () => {
        proc.off("message", listener);
      };
    },
    onClose(listener) {
      const fire = once(listener);
      proc.once("disconnect", fire);
      return () => {
        proc.off("disconnect", fire);
      };
    }
  };
}

export type InMemoryBridgeChannel = BridgeChannel & {
  /** Sever the pair: both sides' onClose fire, further sends fail. */
  close(): void;
};

/**
 * Two channels wired back-to-back for unit tests. Delivery is async
 * (microtask) and messages take a JSON round trip, mimicking the real
 * pipe's serialization — a payload that wouldn't survive `child.send`
 * doesn't survive this either.
 */
export function inMemoryChannelPair(): [InMemoryBridgeChannel, InMemoryBridgeChannel] {
  let closed = false;
  const closeListeners: Array<() => void> = [];

  function makeSide(): {
    channel: InMemoryBridgeChannel;
    deliver: (message: unknown) => void;
    setPeer: (peer: (message: unknown) => void) => void;
  } {
    const messageListeners = new Set<(message: unknown) => void>();
    let sendToPeer: ((message: unknown) => void) | null = null;
    const channel: InMemoryBridgeChannel = {
      send(message) {
        if (closed || sendToPeer === null) return false;
        let wire: unknown;
        try {
          wire = JSON.parse(JSON.stringify(message));
        } catch {
          return false;
        }
        const deliverTo = sendToPeer;
        queueMicrotask(() => {
          if (closed) return;
          deliverTo(wire);
        });
        return true;
      },
      onMessage(listener) {
        messageListeners.add(listener);
        return () => {
          messageListeners.delete(listener);
        };
      },
      onClose(listener) {
        const fire = once(listener);
        closeListeners.push(fire);
        return () => {
          const index = closeListeners.indexOf(fire);
          if (index !== -1) closeListeners.splice(index, 1);
        };
      },
      close() {
        if (closed) return;
        closed = true;
        for (const listener of [...closeListeners]) listener();
      }
    };
    return {
      channel,
      deliver: (message) => {
        for (const listener of [...messageListeners]) listener(message);
      },
      setPeer: (peer) => {
        sendToPeer = peer;
      }
    };
  }

  const a = makeSide();
  const b = makeSide();
  a.setPeer(b.deliver);
  b.setPeer(a.deliver);
  return [a.channel, b.channel];
}
