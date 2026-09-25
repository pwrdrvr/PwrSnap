// The sticky MP4 audio preference behind the grid's Mic / System toggles.
// It must persist through Settings (main exports from the persisted
// value when a caller names no audio), roll back when a write fails, and
// not let a stale broadcast flip a toggle the user just set.

import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  mp4ExportAudio,
  recordedAudioTracks,
  useMp4ExportAudio,
  type RecordedAudioTracks
} from "../useMp4ExportAudio";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

type Pending = { name: string; req: unknown; resolve: (value: unknown) => void };

const pending: Pending[] = [];
const settingsSubscribers = new Set<(payload: unknown) => void>();

(globalThis as unknown as { window: Window }).window =
  (globalThis as unknown as { window?: Window }).window ?? ({} as Window);
(globalThis as unknown as { window: { pwrsnapApi: unknown } }).window.pwrsnapApi = {
  dispatch: (name: string, req: unknown): Promise<unknown> =>
    new Promise<unknown>((resolve) => {
      pending.push({ name, req, resolve });
    }),
  on: (channel: string, handler: (payload: unknown) => void): (() => void) => {
    if (channel === EVENT_CHANNELS.settingsChanged) settingsSubscribers.add(handler);
    return () => settingsSubscribers.delete(handler);
  }
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  pending.length = 0;
  settingsSubscribers.clear();
});

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
});

type Snapshot = ReturnType<typeof useMp4ExportAudio>;

function Probe({
  recorded,
  onSnapshot
}: {
  recorded: RecordedAudioTracks;
  onSnapshot: (snapshot: Snapshot) => void;
}): null {
  const result = useMp4ExportAudio(recorded);
  useEffect(() => {
    onSnapshot(result);
  });
  return null;
}

function mount(recorded: RecordedAudioTracks = { microphone: true, systemAudio: true }): () => Snapshot {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  let last: Snapshot | null = null;
  act(() => {
    root!.render(createElement(Probe, { recorded, onSnapshot: (s) => (last = s) }));
  });
  return () => {
    if (last === null) throw new Error("no snapshot");
    return last;
  };
}

function settings(mic: boolean, system: boolean): unknown {
  return { recording: { mp4IncludeMicrophone: mic, mp4IncludeSystemAudio: system } };
}

function take(name: string): Pending {
  const index = pending.findIndex((p) => p.name === name);
  if (index < 0) throw new Error(`no pending ${name}; queued: ${pending.map((p) => p.name).join(", ")}`);
  return pending.splice(index, 1)[0]!;
}

async function settle(p: Pending, value: unknown): Promise<void> {
  await act(async () => {
    p.resolve(value);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function broadcast(mic: boolean, system: boolean): void {
  act(() => {
    for (const handler of settingsSubscribers) handler({ settings: settings(mic, system), secrets: {} });
  });
}

describe("mp4ExportAudio", () => {
  test("narrows the kept tracks to the ones the take recorded", () => {
    expect(
      mp4ExportAudio({ microphone: false, systemAudio: true }, { microphone: true, systemAudio: true })
    ).toEqual({ includeMicrophone: false, includeSystemAudio: true });
  });

  test("recordedAudioTracks reads a capture's video metadata and tolerates none", () => {
    expect(recordedAudioTracks({ hasMicrophoneAudio: true, hasSystemAudio: false })).toEqual({
      microphone: true,
      systemAudio: false
    });
    expect(recordedAudioTracks(null)).toEqual({ microphone: false, systemAudio: false });
  });
});

describe("useMp4ExportAudio", () => {
  test("sends no audio and shows no choice until the saved preference loads", async () => {
    const snapshot = mount();

    expect(snapshot().audio).toBeUndefined();
    expect(snapshot().control.kept).toBeNull();

    await settle(take("settings:read"), { ok: true, value: settings(false, true) });

    expect(snapshot().control.kept).toEqual({ microphone: false, systemAudio: true });
    expect(snapshot().audio).toEqual({ includeMicrophone: false, includeSystemAudio: true });
  });

  test("a toggle shows at once, writes only its own field, and holds through its echo", async () => {
    const snapshot = mount();
    await settle(take("settings:read"), { ok: true, value: settings(true, true) });

    act(() => snapshot().control.onToggle("microphone", false));

    expect(snapshot().audio).toEqual({ includeMicrophone: false, includeSystemAudio: true });
    const write = take("settings:write");
    expect(write.req).toEqual({ recording: { mp4IncludeMicrophone: false } });

    // An unrelated write queued ahead of ours broadcasts the old value.
    broadcast(true, true);
    expect(snapshot().control.kept).toEqual({ microphone: false, systemAudio: true });

    broadcast(false, true);
    await settle(write, { ok: true, value: settings(false, true) });
    expect(snapshot().control.kept).toEqual({ microphone: false, systemAudio: true });

    // With nothing in flight, another window's change applies.
    broadcast(true, false);
    expect(snapshot().control.kept).toEqual({ microphone: true, systemAudio: false });
  });

  test("a failed write rolls back to the persisted choice", async () => {
    const snapshot = mount();
    await settle(take("settings:read"), { ok: true, value: settings(true, true) });

    act(() => snapshot().control.onToggle("systemAudio", false));
    expect(snapshot().control.kept?.systemAudio).toBe(false);

    await settle(take("settings:write"), {
      ok: false,
      error: { kind: "settings", code: "write_failed", message: "disk full" }
    });

    expect(snapshot().control.kept).toEqual({ microphone: true, systemAudio: true });
  });

  test("a failed write rolls back to the latest persisted value, not the pre-toggle one", async () => {
    const snapshot = mount();
    await settle(take("settings:read"), { ok: true, value: settings(true, true) });

    act(() => snapshot().control.onToggle("microphone", false));
    const first = take("settings:write");
    act(() => snapshot().control.onToggle("systemAudio", false));
    const second = take("settings:write");

    // The first write's echo does not match the second's optimistic
    // value, so it is held — but it is what is persisted now.
    broadcast(false, true);
    await settle(first, { ok: true, value: settings(false, true) });
    expect(snapshot().control.kept).toEqual({ microphone: false, systemAudio: false });

    await settle(second, {
      ok: false,
      error: { kind: "settings", code: "write_failed", message: "disk full" }
    });
    expect(snapshot().control.kept).toEqual({ microphone: false, systemAudio: true });
  });

  test("an initial read that resolves after a broadcast does not overwrite it", async () => {
    const snapshot = mount();
    const read = take("settings:read");

    broadcast(false, true);
    expect(snapshot().control.kept).toEqual({ microphone: false, systemAudio: true });

    await settle(read, { ok: true, value: settings(true, true) });
    expect(snapshot().control.kept).toEqual({ microphone: false, systemAudio: true });
  });

  test("a take with no audio exports silent without waiting for the preference", () => {
    const snapshot = mount({ microphone: false, systemAudio: false });

    expect(snapshot().audio).toEqual({ includeMicrophone: false, includeSystemAudio: false });
  });

  test("a toggle made before the initial read resolves is not overwritten by it", async () => {
    const snapshot = mount();
    const read = take("settings:read");
    // No preference yet → the toggle is ignored rather than guessing a base.
    act(() => snapshot().control.onToggle("microphone", false));
    expect(pending.filter((p) => p.name === "settings:write")).toHaveLength(0);

    await settle(read, { ok: true, value: settings(true, true) });
    expect(snapshot().control.kept).toEqual({ microphone: true, systemAudio: true });
  });
});
