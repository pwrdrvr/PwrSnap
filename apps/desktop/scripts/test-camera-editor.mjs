// Hidden Electron integration: real custom-protocol video decoding, canvas
// placement and editor controls. Never opens a window or a physical camera,
// and never reads the operator's Library. Run after building the renderer.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { _electron } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const renderer = join(desktop, "src/renderer");
const scratch = await mkdtemp(join(tmpdir(), "pwrsnap-camera-editor-"));
let server, electron;
try {
  const fixture = join(scratch, "camera.mp4");
  const screenFixture = join(scratch, "screen.mp4");
  for (const [path, color, duration] of [[fixture, "orange", 8], [screenFixture, "royalblue", 5]]) {
  const encoded = spawnSync(process.env.FFMPEG_PATH ?? "ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=640x360:r=30:d=${duration}`,
    "-c:v", process.platform === "darwin" ? "h264_videotoolbox" : "libopenh264",
    "-b:v", "1M", "-pix_fmt", "yuv420p", "-y", path,
  ], { encoding: "utf8" });
  assert.equal(encoded.status, 0, encoded.stderr);
  }
  const fileResponse = ts.transpileModule(await readFile(join(desktop, "src/main/protocol-file-response.ts"), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  await writeFile(join(scratch, "file-response.cjs"), fileResponse);
  const probe = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VideoStage } from './src/features/library/VideoStage';
import { EditHistory } from './src/features/shared/edit-history';
import './src/styles/tokens.css';
import './src/styles/video-timeline.css';
const video = { durationSec: 5, containerFormat: 'mp4', hasSystemAudio: false,
  hasMicrophoneAudio: false, requestedSystemAudio: false, requestedMicrophone: false,
  defaultRange: {start:0,end:5}, segments:[{start:0,end:5}], previewStatus:'ready',previewPath:null,
  camera:{version:1,durationSec:8,width:640,height:360,offsetSec:-3,mimeType:'video/mp4',sha256:'a'.repeat(64)},
  avatar:{visible:true,background:'original',x:0.72,y:0.72,width:0.26,mirror:true,crop:{x:0,y:0,width:1,height:1}} };
const history = new EditHistory();
function App() {
  const [record,setRecord]=useState({id:'fixture',kind:'video',width_px:640,height_px:360,video});
  const [segments,setSegments]=useState(video.segments);
  window.pwrsnapApi = {on:()=>()=>{}, dispatch:async(command,request)=>{
    if(command==='video:setAvatar'){setRecord(previous=>({...previous,video:{...previous.video,avatar:request.avatar}}));return {ok:true,value:{}}}
    return {ok:false,error:{kind:'validation',code:'fixture',message:'No audio/filmstrip in this fixture'}};
  }};
  return <div style={{width:1000,height:740,margin:16,color:'var(--text-primary)'}}>
    <VideoStage record={record} video={record.video} trim={{range:video.defaultRange,segments,
      setRange:()=>{},setSegments, pending:false,canUndo:false,canRedo:false,undo:()=>{},redo:()=>{},history}}/>
  </div>;
}
createRoot(document.getElementById('root')).render(<App/>);`;
  const virtualPath = join(renderer, "__camera-editor-probe.tsx");
  server = await createServer({ configFile: false, root: renderer, logLevel: "error",
    resolve: { alias: { "@pwrsnap/shared": resolve(desktop, "../../packages/shared/src/index.ts") } },
    plugins: [react(), {
      name: "camera-editor-fixture",
      resolveId(id) { if (id === "/__camera-editor-probe.tsx") return virtualPath; },
      load(id) { if (id === virtualPath) return probe; },
      configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
        if (req.url !== "/") return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml("/", '<div id="root"></div><script type="module" src="/__camera-editor-probe.tsx"></script>'));
      }); },
    }], server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const main = join(scratch, "main.cjs");
  await writeFile(main, `
const {app, BrowserWindow, protocol} = require('electron');
app.setPath('userData', ${JSON.stringify(join(scratch, "user-data"))});
if (process.platform === 'darwin') app.setActivationPolicy('prohibited');
protocol.registerSchemesAsPrivileged([{scheme:'pwrsnap-capture',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true,corsEnabled:true}}]);
app.whenReady().then(async()=>{
 const {fileResponse}=require('./file-response.cjs');
 protocol.handle('pwrsnap-capture', request=>fileResponse(request.url.includes('://c/') ? ${JSON.stringify(fixture)} : ${JSON.stringify(screenFixture)},request,{cors:true}));
 const window = new BrowserWindow({show:false,width:1040,height:790,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 await window.loadURL(${JSON.stringify(origin)});
});`);
  // Keep Electron resolvable from the temporary entry without installing or
  // changing the operator's app. Playwright uses this exact workspace runtime.
  electron = await _electron.launch({ executablePath: require("electron"), args: [main],
    env: { ...process.env, PWRSNAP_DATA_ROOT: join(scratch, "data"), NODE_PATH: dirname(require.resolve("electron/package.json")) + "/.." } });
  const page = await electron.firstWindow();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  const painted = () => page.waitForFunction(() => {
    const canvas = document.querySelector(".pres-obj__canvas");
    return canvas && canvas.width > 1 && canvas.getContext("2d").getImageData(0,0,1,1).data[3] > 200;
  });
  try {
    await page.getByTestId("video-timeline-camera-span").waitFor({timeout:10_000});
    await painted();
  } catch (error) {
    console.error({errors, body: await page.locator("body").innerText()});
    throw error;
  }
  assert(await page.getByTestId("video-timeline-camera").isVisible());
  // Selecting the presenter floats its toolbar over the stage; the video
  // frame keeps its size.
  const before = await page.locator(".psl__video-frame").boundingBox();
  const presenter = page.getByTestId("presenter-object");
  await presenter.click();
  await page.getByTestId("presenter-toolbar").waitFor();
  assert.deepEqual(await page.locator(".psl__video-frame").boundingBox(), before);
  const old = await presenter.boundingBox();
  await page.getByTestId("presenter-place").click();
  await page.getByRole("menuitemradio", {name:"Top left",exact:true}).click();
  await page.waitForFunction(previous => document.querySelector("[data-testid=presenter-object]").getBoundingClientRect().left < previous, old.x, {timeout:5000});
  const moved = await presenter.boundingBox();
  assert(moved.x < old.x && moved.y < old.y);
  // Escape closes an open menu and returns focus to its button; the next
  // Escape deselects the presenter.
  await page.getByTestId("presenter-place").click();
  await page.getByTestId("presenter-place-menu").waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByTestId("presenter-place-menu").count(), 0);
  assert(await page.getByTestId("presenter-place").evaluate(el => el === document.activeElement));
  await page.keyboard.press("Escape");
  await page.getByTestId("presenter-toolbar").waitFor({state:"detached"});
  // Hiding the presenter keeps the camera lane.
  await page.getByTestId("video-transport-presenter").click();
  assert.equal(await presenter.count(), 0);
  assert(await page.getByTestId("video-timeline-camera").isVisible());
  await page.getByTestId("video-transport-presenter").click();
  await painted();
  const screenshot = process.env.CAMERA_EDITOR_SCREENSHOT;
  if (screenshot) {
    await page.screenshot({path:screenshot});
    await presenter.click();
    await page.screenshot({path:screenshot.replace(/\.png$/, "-selected.png")});
  }
  // An unavailable segmentation worker must not make a valid camera disappear.
  await page.evaluate(() => {
    window.fixtureWorker = window.Worker;
    window.Worker = class { constructor() { throw new Error("Forced worker failure"); } };
  });
  if (!await page.getByTestId("presenter-toolbar").count()) await presenter.click();
  await page.getByTestId("presenter-look-cut").click();
  await page.getByTestId("presenter-mask-failed").waitFor();
  assert(await page.locator(".pres-obj__canvas").evaluate(canvas => canvas.getContext("2d").getImageData(0,0,1,1).data[3] > 200));
  await page.evaluate(() => { window.Worker = window.fixtureWorker; });
  assert.deepEqual(errors, []);
  // Exercise the packaged file:// asset path as well as the dev/http editor.
  // Inference must use the real local model/WASM in a sandboxed Electron worker.
  const worker = await electron.evaluate(async ({BrowserWindow}, url) => {
    const window = new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
    await window.loadFile(url);
    return window.id;
  }, join(desktop, "out/renderer/camera.html"));
  const maskBytes = await electron.evaluate(async ({BrowserWindow}, id) => {
    const contents = BrowserWindow.fromId(id).webContents;
    return contents.executeJavaScript(`(async()=>{
      await window.pwrsnapCameraWorker.open('pwrsnap-capture://c/fixture');
      return (await window.pwrsnapCameraWorker.frame(0.1,320,180)).length;
    })()`);
  }, worker);
  assert(maskBytes > 100);
  assert.equal(await electron.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().some(w => w.isVisible())), false);
  console.log("Hidden Electron camera editor passed: real protocol decode and canvas, camera lane, fixed stage size, presenter placement, visibility, Escape focus return, raw preview after worker failure, packaged local MediaPipe inference.");
} finally {
  await electron?.close();
  await server?.close();
  await rm(scratch, {recursive:true,force:true});
}
