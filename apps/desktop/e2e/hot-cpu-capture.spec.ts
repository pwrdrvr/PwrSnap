import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { migrateHotCpuCaptureRules } from "@pwrsnap/shared";
import { expect, launchPwrSnap, test } from "./fixtures/electron-app";

test("combined CPU rules save one renderer profile and a redacted Chromium companion", async ({}, info) => {
  test.setTimeout(90_000);
  const root = info.outputPath("diagnostics");
  const app = await launchPwrSnap({
    env: {
      PWRSNAP_HOT_CPU_PROFILING_OUTPUT_ROOT: root,
      PWRSNAP_HOT_CPU_PROFILING_DURATION_MS: "1800",
      PWRSNAP_HOT_CPU_PROFILING_MAX_PROFILES: "1"
    }
  });
  try {
    // Deterministic CPU evidence drives the production sampler. Chromium,
    // the V8 profiler, settings and publication below run in real Electron.
    await app.electronApp.evaluate(({ app, BrowserWindow }, url) => {
      const library = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL() === url);
      if (!library) throw new Error("Missing Library renderer");
      const pid = library.webContents.getOSProcessId();
      const readMetrics = app.getAppMetrics.bind(app);
      const start = performance.now();
      app.getAppMetrics = () => readMetrics().map((metric) => ({
        ...metric,
        cpu: { ...metric.cpu, percentCPUUsage: 0, cumulativeCPUUsage: metric.pid === pid
          ? (performance.now() - start) * 0.0009 : 0 }
      }));
    }, app.window.url());

    const rules = migrateHotCpuCaptureRules();
    rules.slowburn.enabled = true;
    expect(await app.dispatch("settings:write", {
      general: { hotCpuProfilingRules: rules, hotCpuProfilingCaptureChromiumTrace: true }
    })).toMatchObject({ ok: true });
    expect(await app.dispatch("settings:write", {
      general: { hotCpuProfilingRules: { ...rules, high: { ...rules.high, enabled: false },
        slowburn: { ...rules.slowburn, enabled: false } } }
    })).toMatchObject({ ok: false, error: { code: "invalid_general_hotCpuProfilingRules" } });

    const settingsWindow = app.electronApp.waitForEvent("window");
    expect(await app.dispatch("settings:open", { page: "developer" })).toMatchObject({ ok: true });
    const settings = await settingsWindow;
    await expect(settings.getByRole("group", { name: "Capture rules" })).toBeVisible();
    await expect(settings.getByRole("checkbox", { name: "Slow burn" })).toBeChecked();
    await expect(settings.getByRole("switch", { name: "Chromium trace" })).toBeChecked();
    await settings.getByRole("button", { name: "Start Capture (Immediate)" }).click();

    let rendererSession = "";
    await expect.poll(async () => {
      const names = await readdir(root).catch(() => []);
      for (const name of names) {
        const dir = join(root, name);
        const manifest = await readFile(join(dir, "session.json"), "utf8").catch(() => "");
        if (manifest && JSON.parse(manifest).target === "renderer") {
          rendererSession = dir;
          return (await readFile(join(dir, "samples.ndjson"), "utf8").catch(() => "")).length;
        }
      }
      return 0;
    }, { timeout: 15_000 }).toBeGreaterThan(0);

    await app.window.evaluate(() => {
      performance.mark("pwrsnap-contrived-private-mark");
      function burnBeforeCombinedTrigger() {
        const row = document.createElement("div");
        document.body.append(row);
        try {
          const until = performance.now() + 300;
          let i = 0;
          while (performance.now() < until) {
            row.style.width = `${300 + ++i % 60}px`;
            row.getBoundingClientRect();
          }
        } finally {
          row.remove();
        }
      }
      burnBeforeCombinedTrigger();
    });

    const readEvents = async () => (await readFile(join(rendererSession, "events.ndjson"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    await expect.poll(async () => (await readEvents()).some(({ type }) => type === "profile-started"),
      { timeout: 12_000 }).toBe(true);
    // Reconfiguration clears pending streaks but the claimed capture uses
    // the original match and keeps its CPU profile and trace.
    expect(await app.dispatch("settings:write", {
      general: { hotCpuProfilingRules: { ...rules, sustained: { durationMs: 10000, thresholdPercent: 400 } } }
    })).toMatchObject({ ok: true });

    await expect(app.window.getByText("CPU profile captured", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(app.window.getByText(/Sustained.*Slow burn/)).toBeVisible();
    const profile = JSON.parse(await readFile(join(rendererSession, "renderer-hot-0001.cpuprofile"), "utf8"));
    expect(profile.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ callFrame: expect.objectContaining({ functionName: "burnBeforeCombinedTrigger" }) })
    ]));
    const startEvents = (await readEvents()).filter(({ type }) => type === "profile-started");
    expect(startEvents).toHaveLength(1);
    expect(startEvents[0].detail).toMatchObject({
      triggerMode: "sustained", triggerConsecutiveSamples: 2, triggerThresholdPercent: 50,
      matchedRules: [
        { id: "sustained", thresholdPercent: 50, durationMs: 4000, sampleCount: 2, measurement: "cumulative" },
        { id: "slowburn", thresholdPercent: 15, durationMs: 4000, sampleCount: 2, measurement: "cumulative" }
      ]
    });
    expect(startEvents[0].detail.preTriggerDurationMs).toBeGreaterThan(3000);

    const traceName = "renderer-hot-0001.trace.json";
    const manifestPath = join(rendererSession, "session.json");
    await expect.poll(async () => JSON.parse(await readFile(manifestPath, "utf8")).artifacts,
      { timeout: 20_000 }).toContain(traceName);
    const trace = await readFile(join(rendererSession, traceName), "utf8");
    expect(trace).not.toContain("pwrsnap-contrived-private-mark");
    expect(JSON.parse(trace).traceEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Layout" }),
      expect.objectContaining({ name: "User timing" })
    ]));
  } finally {
    await app.close();
  }
});
