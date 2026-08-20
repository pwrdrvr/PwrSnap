// HotCpuTarget adapter for the Electron main process itself.
//
// node:inspector speaks the same Chrome DevTools Protocol Profiler
// domain the renderer path drives through webContents.debugger, so the
// whole trigger/profile machinery in hot-cpu-profiler.ts works
// unchanged: attach() connects an in-process inspector session,
// sendCommand() posts CDP methods to it, and Profiler.stop returns a
// .cpuprofile-shaped object for the main thread.

import { Session } from "node:inspector";
import type { HotCpuTarget } from "./hot-cpu-profiler";

export function createMainProcessHotCpuTarget(): HotCpuTarget {
  let session: Session | null = null;

  return {
    debugger: {
      attach: () => {
        if (session !== null) {
          throw new Error("main-process inspector session already attached");
        }
        const next = new Session();
        next.connect();
        session = next;
      },
      detach: () => {
        const current = session;
        session = null;
        current?.disconnect();
      },
      isAttached: () => session !== null,
      sendCommand: (method, params) =>
        new Promise((resolve, reject) => {
          if (session === null) {
            reject(new Error("main-process inspector session not attached"));
            return;
          }
          session.post(method, params ?? {}, (error, result) => {
            if (error) reject(error);
            else resolve(result);
          });
        }),
      // An in-process inspector session never detaches spontaneously
      // (there is no remote peer to drop it), so the detach listener
      // contract is a no-op here.
      on: () => {},
      off: () => {}
    },
    getOSProcessId: () => process.pid
    // Deliberately NO `takeHeapSnapshot`. The only main-process API for
    // it, `v8.writeHeapSnapshot`, is SYNCHRONOUS: it blocks the main
    // thread for the length of the write (~seconds on a heap of a few
    // hundred MB), and with it every window, all IPC, the tray, and the
    // global hotkeys. The profiler would call it up to three times per
    // triggered profile (start/mid/stop), turning a background
    // diagnostic into a user-visible app hang. Omitting it also keeps
    // `heapSnapshotLimit` honest — the counter is per-profiler, so a
    // second snapshotting target would silently double the user's
    // configured budget. Main sessions are CPU-profile only; the
    // renderer path still captures heap snapshots in its own process,
    // where the stall is contained.
  };
}
