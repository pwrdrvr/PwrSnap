// A/B harness for the video-stage playhead publish rate.
//
// Runs the repo's own Electron binary with a visible, always-on-top
// window playing a REAL capture, and samples per-process CPU through
// `app.getAppMetrics()` — which is where this cost lives: raster runs
// in the GPU process under out-of-process rasterization, so a moving
// playhead shows up there, not only in the renderer.
//
//   ../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
//     main.cjs --video <path.mp4> --film <strip.png> [--seconds 16] [--rounds 3]
//
// Generate the filmstrip from the same file so the strip lane paints
// the same pixels the app's does:
//
//   ffmpeg -i <path.mp4> -vf "fps=1/6,scale=-1:112,tile=30x1" \
//     -frames:v 1 strip.png
//
// Arms alternate (frozen → raf → throttled, twice) so thermal drift
// and any background load land on both arms equally.

const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const videoPath = arg("video", null);
const seconds = Number(arg("seconds", "16"));
const rounds = Number(arg("rounds", "3"));
const filmPath = arg("film", path.join(__dirname, "filmstrip.png"));
if (videoPath === null) throw new Error("--video <path> required");

const ARMS = ["frozen", "raf", "throttled"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True per-process CPU over `ms`, from the kernel's cumulative CPU
 *  time for each pid — the same quantity Activity Monitor's %CPU
 *  column is a rate of, and one core = 100 %.
 *
 *  Electron's own `percentCPUUsage` is NOT used for the headline
 *  numbers: measured against `ps` on this machine it reads roughly an
 *  order of magnitude low (it is normalized across cores), so it gets
 *  the A/B ratio right but not the scale Activity Monitor shows. */
const cpuSeconds = (pid) => {
  const out = execFileSync("ps", ["-o", "cputime=", "-p", String(pid)], { encoding: "utf8" }).trim();
  if (out === "") return null;
  const parts = out.split(/[:.]/).map(Number); // [mm, ss, hundredths] or [hh, mm, ss, hundredths]
  const cs = parts.pop();
  let secs = cs / 100;
  let mult = 1;
  while (parts.length > 0) {
    secs += parts.pop() * mult;
    mult *= 60;
  }
  return secs;
};

function pids() {
  const rows = app.getAppMetrics();
  const of = (types) => rows.filter((r) => types.includes(r.type)).map((r) => r.pid);
  return { gpu: of(["GPU"]), renderer: of(["Tab", "Renderer"]) };
}

const totalCpu = (list) => list.reduce((a, pid) => a + (cpuSeconds(pid) ?? 0), 0);

async function sample(ms) {
  const p = pids();
  const before = { gpu: totalCpu(p.gpu), renderer: totalCpu(p.renderer) };
  const t0 = Date.now();
  await sleep(ms);
  const elapsed = (Date.now() - t0) / 1000;
  const after = { gpu: totalCpu(p.gpu), renderer: totalCpu(p.renderer) };
  return {
    gpu: ((after.gpu - before.gpu) / elapsed) * 100,
    renderer: ((after.renderer - before.renderer) / elapsed) * 100
  };
}

app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1040,
    height: 640,
    show: true,
    alwaysOnTop: true,
    backgroundColor: "#000000",
    webPreferences: { contextIsolation: false, nodeIntegration: true, backgroundThrottling: false }
  });
  await win.loadFile(path.join(__dirname, "index.html"));
  win.showInactive();
  win.setAlwaysOnTop(true, "screen-saver");

  const src = `file://${encodeURI(videoPath)}`;
  const film = existsSync(filmPath) ? `file://${encodeURI(path.resolve(filmPath))}` : "none";
  const meta = await win.webContents.executeJavaScript(
    `window.bench.load(${JSON.stringify(src)}, ${JSON.stringify(film)})`
  );
  console.log(`media: ${meta.duration.toFixed(1)} s · requestVideoFrameCallback: ${meta.hasVfc}`);

  // Let decode, the compositor, and the OS settle before the first arm.
  await sleep(6000);

  const results = new Map(ARMS.map((a) => [a, []]));
  for (let round = 0; round < rounds; round += 1) {
    for (const armName of ARMS) {
      await win.webContents.executeJavaScript(`window.bench.arm(${JSON.stringify(armName)})`);
      await sleep(2500); // settle after the switch
      await win.webContents.executeJavaScript("window.bench.read()");
      const cpu = await sample(seconds * 1000);
      const counts = await win.webContents.executeJavaScript("window.bench.read()");
      const hz = counts.publishes / seconds;
      const fps = counts.frames / seconds;
      results.get(armName).push({ ...cpu, hz, fps });
      console.log(
        `round ${round + 1} · ${armName.padEnd(10)} gpu ${cpu.gpu.toFixed(1).padStart(5)}%  ` +
          `renderer ${cpu.renderer.toFixed(1).padStart(5)}%  ` +
          `publish ${hz.toFixed(1).padStart(5)} Hz  rAF ${fps.toFixed(1)} fps`
      );
    }
  }

  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  console.log("\n=== mean over rounds ===");
  console.log("arm         GPU proc   renderer   publish Hz   rAF fps");
  for (const armName of ARMS) {
    const rs = results.get(armName);
    console.log(
      `${armName.padEnd(11)} ${mean(rs.map((r) => r.gpu)).toFixed(1).padStart(7)}%   ` +
        `${mean(rs.map((r) => r.renderer)).toFixed(1).padStart(6)}%   ` +
        `${mean(rs.map((r) => r.hz)).toFixed(1).padStart(9)}   ` +
        `${mean(rs.map((r) => r.fps)).toFixed(1).padStart(7)}`
    );
  }
  app.quit();
});
