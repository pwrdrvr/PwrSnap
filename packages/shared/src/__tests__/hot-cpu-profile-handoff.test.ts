import { describe, expect, test } from "vitest";
import {
  buildHotCpuProfileHandoffMessage,
  type HotCpuProfileCapturedEvent
} from "../protocol";

const baseEvent: HotCpuProfileCapturedEvent = {
  capturedAt: "2026-07-04T19:44:18.760Z",
  profileFilename: "renderer-hot-0001.cpuprofile",
  profilePath:
    "/Users/example/Library/Application Support/PwrSnap/diagnostics/hot-cpu/hot-cpu-2026-07-04-1543-8f0193/renderer-hot-0001.cpuprofile",
  sessionDirectory:
    "/Users/example/Library/Application Support/PwrSnap/diagnostics/hot-cpu/hot-cpu-2026-07-04-1543-8f0193",
  sessionDirectoryName: "hot-cpu-2026-07-04-1543-8f0193",
  triggerConsecutiveSamples: 2,
  triggerCpuPercent: 104.289,
  triggerMode: "sustained",
  triggerThresholdPercent: 50
};

describe("buildHotCpuProfileHandoffMessage", () => {
  test("builds a compact handoff for CPU-only captures", () => {
    const message = buildHotCpuProfileHandoffMessage(baseEvent);

    expect(message).toContain("PwrSnap captured a renderer CPU profile.");
    expect(message).toContain("Analyze these artifacts as evidence");
    expect(message).toContain("Trigger: Sustained");
    expect(message).toContain(`Session: ${baseEvent.sessionDirectory}`);
    expect(message).toContain(`CPU profile: ${baseEvent.profilePath}`);
    expect(message).toContain("Sidecars: session.json, samples.ndjson, events.ndjson");
    expect(message).not.toContain("Session basename:");
    expect(message).not.toContain("CPU profile basename:");
    expect(message).not.toContain("Heap snapshots:");
  });

  test("includes heap snapshot paths when memory captures are present", () => {
    const message = buildHotCpuProfileHandoffMessage({
      ...baseEvent,
      heapSnapshotArtifacts: [
        {
          filename: "renderer-hot-0001-start.heapsnapshot",
          path: `${baseEvent.sessionDirectory}/renderer-hot-0001-start.heapsnapshot`,
          phase: "start"
        },
        {
          filename: "renderer-hot-0001-stop.heapsnapshot",
          path: `${baseEvent.sessionDirectory}/renderer-hot-0001-stop.heapsnapshot`,
          phase: "stop"
        }
      ]
    });

    expect(message).toContain("Heap snapshots: 2");
    expect(message).toContain(
      `- start: ${baseEvent.sessionDirectory}/renderer-hot-0001-start.heapsnapshot`
    );
    expect(message).toContain(
      `- stop: ${baseEvent.sessionDirectory}/renderer-hot-0001-stop.heapsnapshot`
    );
    expect(message).not.toContain("Heap snapshot start basename:");
    expect(message).not.toContain("Heap snapshot stop basename:");
  });

  test("does not clamp trigger CPU percentages above 100 percent", () => {
    const message = buildHotCpuProfileHandoffMessage(baseEvent);

    expect(message).toContain("trigger sample 104.3%)");
  });
});
