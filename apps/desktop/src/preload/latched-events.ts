// Server → client event subscription with a latch for one-shot intents.
//
// Most event channels are state broadcasts: a renderer that subscribes
// late simply fetches current state on mount, so an event that lands
// before anyone listens is safe to drop. A few channels instead carry a
// one-shot INTENT that exists nowhere else — `libraryOpenCapture` ("open
// this capture in Focus") is the one today. Dropping that event loses the
// user's action: the Library comes forward on the grid and the capture
// they asked for never opens.
//
// And the renderer cannot promise to be listening in time. Its subscriber
// is a React passive effect, which runs in a later task than the first
// render, while main's IPC message is queued as a task of its own. Nothing
// orders the two. Measured in the Linux E2E harness with one send per
// open: of 120 opens issued right after DOMContentLoaded, 59 were sent
// before the Library had subscribed, and each arrived only when it did.
// Main used to cover this by sending a second time 100ms later, which is
// a guess at how long the first render takes and not a guarantee.
//
// The preload is the one piece of renderer code guaranteed to run before
// the page does. A latched channel therefore gets its IPC listener here,
// at preload evaluation, and keeps the latest payload that arrived while
// nothing was subscribed. The first subscriber receives it synchronously
// when it subscribes, and later events flow live. Main still has to wait
// for the page to load before sending (an event sent to a document that
// has not run its preload yet goes nowhere), but it no longer has to
// guess when React mounts.
//
// Latest-wins, not a queue: two intents raised before the Library mounted
// resolve to the most recent one, which is what the user last asked for.
// It also bounds memory in windows that never subscribe to the channel.
//
// "While nothing was subscribed" is literal: ANY subscriber on a latched
// channel receives events live, so a second, earlier subscriber (a
// diagnostic listener, say) would take the intent before the Library
// mounts. Give a latched channel exactly one consumer.

export interface IpcEventSource {
  on(channel: string, listener: (event: unknown, payload: unknown) => void): unknown;
  off(channel: string, listener: (event: unknown, payload: unknown) => void): unknown;
}

export type EventSubscribe = (
  channel: string,
  handler: (payload: unknown) => void
) => () => void;

type Latch = {
  handlers: Set<(payload: unknown) => void>;
  pending: { payload: unknown } | null;
};

export function createEventSubscriber(
  ipc: IpcEventSource,
  latchedChannels: readonly string[]
): EventSubscribe {
  const latches = new Map<string, Latch>();
  for (const channel of latchedChannels) {
    const latch: Latch = { handlers: new Set(), pending: null };
    latches.set(channel, latch);
    ipc.on(channel, (_event, payload) => {
      if (latch.handlers.size === 0) {
        latch.pending = { payload };
        return;
      }
      for (const handler of Array.from(latch.handlers)) handler(payload);
    });
  }

  return (channel, handler) => {
    const latch = latches.get(channel);
    if (latch === undefined) {
      const wrapped = (_event: unknown, payload: unknown): void => handler(payload);
      ipc.on(channel, wrapped);
      return () => {
        ipc.off(channel, wrapped);
      };
    }
    latch.handlers.add(handler);
    const pending = latch.pending;
    latch.pending = null;
    if (pending !== null) {
      // Delivered inside the caller's subscribe (a React effect). A throw
      // here would escape into that effect and take down the tree, where
      // the same throw from a live IPC delivery is only an uncaught error.
      // Keep it that way: report it asynchronously.
      try {
        handler(pending.payload);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
    return () => {
      latch.handlers.delete(handler);
    };
  };
}
