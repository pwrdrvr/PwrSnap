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
  /** Subscribe to close (peer exit/disconnect or async send failure).
   * Fires once, immediately if the channel is already closed. */
  onClose(listener: () => void): () => void;
};

/** De-dup guard for in-memory close subscriptions. */
function once(listener: () => void): () => void {
  let fired = false;
  return () => {
    if (fired) return;
    fired = true;
    listener();
  };
}

/** Node's send boolean reports backpressure as well as failure: false can
 * still mean the command is queued. Only a disconnected pipe, a throw, or
 * the send callback's error establishes failure. Never replay the frame. */
function nodeIpcChannel(input: {
  connected: () => boolean;
  send: (message: BridgeMessage, callback: (error: Error | null) => void) => void;
  onMessage: BridgeChannel["onMessage"];
  onClose: BridgeChannel["onClose"];
}): BridgeChannel {
  let closed = false;
  let detachClose: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const close = (): void => {
    if (closed) return;
    closed = true;
    detachClose?.();
    detachClose = null;
    const pending = [...listeners];
    listeners.clear();
    for (const listener of pending) listener();
  };
  return {
    send(message) {
      if (closed) return false;
      if (!input.connected()) {
        close();
        return false;
      }
      try {
        input.send(message, (error) => { if (error) close(); });
        return true;
      } catch {
        return false;
      }
    },
    onMessage: input.onMessage,
    onClose(listener) {
      if (!input.connected()) close();
      if (closed) {
        listener();
        return () => undefined;
      }
      listeners.add(listener);
      detachClose ??= input.onClose(close);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          detachClose?.();
          detachClose = null;
        }
      };
    }
  };
}

/** Agent-side channel wrapping a supervised library child process. */
export function channelForChildProcess(child: ChildProcess): BridgeChannel {
  return nodeIpcChannel({
    connected: () => child.connected === true,
    send: (message, callback) => { child.send(message, callback); },
    onMessage(listener) {
      child.on("message", listener);
      return () => {
        child.off("message", listener);
      };
    },
    onClose(listener) {
      child.once("disconnect", listener);
      child.once("exit", listener);
      return () => {
        child.off("disconnect", listener);
        child.off("exit", listener);
      };
    }
  });
}

/** Library-side channel wrapping this process's pipe to the agent. */
export function channelForParentProcess(proc: NodeJS.Process = process): BridgeChannel {
  return nodeIpcChannel({
    connected: () => typeof proc.send === "function" && proc.connected === true,
    send: (message, callback) => { proc.send!(message, callback); },
    onMessage(listener) {
      proc.on("message", listener);
      return () => {
        proc.off("message", listener);
      };
    },
    onClose(listener) {
      proc.once("disconnect", listener);
      return () => {
        proc.off("disconnect", listener);
      };
    }
  });
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
        if (closed) {
          listener();
          return () => undefined;
        }
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
