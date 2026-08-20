// Drives perf-bench/dist in headless Chromium and reports the renderer
// cost of one animation frame of video-stage playback.
//
//   node perf-bench/run.mjs [--seconds 15] [--runs 3] [--label baseline]
//
// Reports, per run and averaged: total main-thread task time and its
// script / style / layout breakdown (Performance.getMetrics deltas)
// divided by the rAF frames actually observed in the same window, plus
// DOM mutations per frame.
//
// `task` carries a fixed harness overhead (frame scheduling, the
// mutation counter, the profiler) present in both arms — read the
// script / style / layout columns, or the A/B delta.
//
// Which React the bundle was built against is detected at runtime, not
// assumed: build with BENCH_REACT=development for the other arm.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "dist");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const seconds = Number(arg("seconds", "15"));
const runs = Number(arg("runs", "3"));
const label = arg("label", "run");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
// Trailing separator: without it a sibling directory whose name merely
// starts with "dist" would satisfy the prefix check.
const distRoot = dist + path.sep;
const server = http.createServer((req, res) => {
  const rel = (req.url ?? "/").split("?")[0];
  const file = path.join(dist, rel === "/" ? "index.html" : rel);
  if (!file.startsWith(distRoot) || !fs.existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

function analyze(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  let total = 0;
  for (let i = 0; i < profile.samples.length; i += 1) {
    const d = Math.max(profile.timeDeltas[i] ?? 0, 0);
    total += d;
    self.set(profile.samples[i], (self.get(profile.samples[i]) ?? 0) + d);
  }
  let idle = 0;
  let program = 0;
  for (const [id, t] of self) {
    const n = byId.get(id);
    if (n === undefined) continue;
    const name = n.callFrame.functionName || "(anonymous)";
    if (name === "(idle)") idle += t;
    if (name === "(program)") program += t;
  }
  // `jsMs` is a cross-check on the engine metrics, not the headline:
  // per-component attribution is not available in a production React
  // build (the frame names are minified away), which is why the report
  // is built on Performance.getMetrics instead.
  return {
    totalMs: total / 1000,
    programMs: program / 1000,
    jsMs: (total - idle - program) / 1000
  };
}

let reactArm = "unknown React build";
const browser = await chromium.launch({
  args: ["--force-device-scale-factor=2", "--autoplay-policy=no-user-gesture-required"]
});
const results = [];
for (let i = 0; i < runs; i += 1) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector("[data-testid=video-timeline]");
  await page.waitForTimeout(500);
  if (i === 0) {
    // The page reports which react-dom it was built against; the
    // header must never assert an arm the bundle did not use.
    reactArm = await page.evaluate(() => window.__bench.reactArm);
    const dom = await page.evaluate(() => ({
      stripWidth: document.querySelector(".vtl__strip")?.getBoundingClientRect().width,
      ticks: document.querySelectorAll(".vtl__tick").length,
      elements: document.querySelectorAll("[data-testid=video-stage] *").length,
      timecode: document.querySelector("[data-testid=video-transport-time] b")?.textContent
    }));
    console.log(`   dom: ${JSON.stringify(dom)}`);
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Performance.enable");
  await page.evaluate(() => window.__bench.start());
  await page.waitForTimeout(300);
  const before = await cdp.send("Performance.getMetrics");
  await cdp.send("Profiler.start");
  await page.waitForTimeout(seconds * 1000);
  const { profile } = await cdp.send("Profiler.stop");
  const after = await cdp.send("Performance.getMetrics");
  const metric = (name) => {
    const a = after.metrics.find((m) => m.name === name)?.value ?? 0;
    const b = before.metrics.find((m) => m.name === name)?.value ?? 0;
    return (a - b) * 1000; // seconds -> ms
  };
  const engine = {
    scriptMs: metric("ScriptDuration"),
    layoutMs: metric("LayoutDuration"),
    styleMs: metric("RecalcStyleDuration"),
    taskMs: metric("TaskDuration")
  };
  // `elapsedMs` is the counter's OWN window, which is longer than
  // `seconds` (the 300 ms settle plus the Profiler.stop / getMetrics
  // round trip). Dividing by `seconds` instead inflated fps ~4 % and
  // understated every per-frame figure by the same margin.
  const { frames, mutations, elapsedMs } = await page.evaluate(() => window.__bench.stop());
  const stats = analyze(profile);
  results.push({
    ...stats,
    ...engine,
    frames,
    mutations,
    fps: (frames * 1000) / Math.max(elapsedMs, 1),
    mutPerFrame: mutations / Math.max(frames, 1)
  });
  await page.close();
}

server.close();
await browser.close();

const avg = (k) => results.reduce((a, r) => a + r[k], 0) / results.length;
const fmt = (n) => n.toFixed(1).padStart(8);
console.log(`\n=== ${label} — ${runs} runs × ${seconds}s (${reactArm})`);
console.log(`   wall    task  script   style  layout  mut/frm     fps`);
for (const r of results) {
  console.log(
    `${fmt(r.totalMs)}${fmt(r.taskMs)}${fmt(r.scriptMs)}${fmt(r.styleMs)}${fmt(r.layoutMs)}${fmt(
      r.mutPerFrame
    )}${fmt(r.fps)}`
  );
}
// Engine metrics cover the profile window only, so scale by the frames
// that window saw — the measured rate times its length.
const perFrame = (k) => (avg(k) * 1000) / (avg("fps") * seconds);
console.log(
  `AVG per frame: task ${perFrame("taskMs").toFixed(0)} us  ` +
    `(script ${perFrame("scriptMs").toFixed(0)}, style ${perFrame("styleMs").toFixed(
      0
    )}, layout ${perFrame("layoutMs").toFixed(0)})  ` +
    `${avg("mutPerFrame").toFixed(1)} DOM mutations/frame`
);
console.log(
  `     -> ${((perFrame("taskMs") / 1000) * 60 * 0.1).toFixed(
    2
  )}% of one core at 60 fps  (profiler JS ${avg("jsMs").toFixed(1)} ms / ${(
    (avg("jsMs") * 1000) /
    (avg("fps") * seconds)
  ).toFixed(0)} us per frame)`
);
console.log(
  JSON.stringify({
    label,
    seconds,
    runs,
    reactArm,
    avg: {
      js: avg("jsMs"),
      taskUsPerFrame: perFrame("taskMs"),
      scriptUsPerFrame: perFrame("scriptMs"),
      styleUsPerFrame: perFrame("styleMs"),
      layoutUsPerFrame: perFrame("layoutMs"),
      mutPerFrame: avg("mutPerFrame"),
      fps: avg("fps"),
      wall: avg("totalMs")
    }
  })
);
