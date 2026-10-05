import { dispatchOrThrow } from "../../lib/pwrsnap";
import { PersonSegmenter } from "./segmentation";

const video = document.createElement("video");
video.muted = true;
video.playsInline = true;
document.body.insertBefore(video, document.querySelector("footer"));
let stream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let chunks: Promise<void> = Promise.resolve();
let startedAt = 0;
let stoppedAt = 0;
let finished: Promise<void> = Promise.resolve();
let failure: Error | null = null;
let pendingBytes = 0;
let segmenter: PersonSegmenter | null = null;
const canvas = document.createElement("canvas");
const maskCanvas = document.createElement("canvas");

async function loaded(): Promise<void> {
  if (video.readyState >= 2) return;
  await new Promise<void>((resolve, reject) => {
    video.onloadeddata = () => resolve();
    video.onerror = () =>
      reject(new Error("Camera video could not be decoded."));
  });
}

const api = {
  clock: () => performance.now(),
  async record(deviceId: string, token: string) {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: { exact: deviceId },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
      },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    await loaded();
    const mime = ["video/mp4;codecs=avc1.42001E", "video/webm;codecs=vp8"].find(
      (value) => MediaRecorder.isTypeSupported(value),
    );
    if (!mime) throw new Error("No camera video encoder is available.");
    recorder = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: 4_000_000,
    });
    chunks = Promise.resolve();
    failure = null;
    pendingBytes = 0;
    stoppedAt = 0;
    const encoder = recorder;
    finished = new Promise((resolve) => {
      encoder.onstop = () => {
        stoppedAt = performance.now();
        stream?.getTracks().forEach((track) => track.stop());
        resolve();
      };
    });
    recorder.ondataavailable = (event) => {
      pendingBytes += event.data.size;
      if (pendingBytes > 32 * 1024 * 1024) {
        failure = new Error("Camera storage could not keep up with recording.");
        if (encoder.state !== "inactive") encoder.stop();
        return;
      }
      chunks = chunks
        .then(async () => {
          const bytes = new Uint8Array(await event.data.arrayBuffer());
          // Bound each bus message even after a delayed dataavailable event.
          for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
            const receipt = await dispatchOrThrow("recording:cameraChunk", {
              token,
              bytes: Array.from(bytes.subarray(offset, offset + 256 * 1024)),
            });
            if (!receipt.accepted)
              throw new Error("Camera recording was interrupted.");
          }
        })
        .finally(() => {
          pendingBytes -= event.data.size;
        });
      void chunks.catch(() => {
        if (recorder?.state === "recording") recorder.stop();
      });
    };
    await new Promise<void>((resolve, reject) => {
      recorder!.onstart = () => {
        startedAt = performance.now();
        resolve();
      };
      recorder!.onerror = () => {
        failure = new Error("Camera encoder failed.");
        reject(failure);
      };
      recorder!.start(500);
    });
    return {
      startedAt,
      width: video.videoWidth,
      height: video.videoHeight,
      mimeType: mime.startsWith("video/mp4") ? "video/mp4" : "video/webm",
    };
  },
  async stop() {
    if (recorder?.state === "recording") recorder.stop();
    await finished;
    await chunks;
    if (failure) throw failure;
    stream?.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
    return { durationSec: (stoppedAt - startedAt) / 1000 };
  },
  async open(url: string) {
    video.srcObject = null;
    video.crossOrigin = "anonymous";
    video.src = url;
    video.load();
    await loaded();
    segmenter?.close();
    segmenter = new PersonSegmenter();
  },
  async frame(time: number, width: number, height: number) {
    // Recording stop can trail the final encoded frame by one frame interval.
    if (Number.isFinite(video.duration))
      time = Math.min(time, Math.max(0, video.duration - 0.001));
    if (Math.abs(video.currentTime - time) > 0.0001) {
      await new Promise<void>((resolve, reject) => {
        video.onseeked = () => resolve();
        video.onerror = () =>
          reject(new Error("Camera frame could not be decoded."));
        video.currentTime = time;
      });
    }
    const mask = await segmenter!.mask(video);
    maskCanvas.width = mask.width;
    maskCanvas.height = mask.height;
    maskCanvas.getContext("2d")!.putImageData(mask, 0, 0);
    canvas.width = width * 2;
    canvas.height = height;
    const context = canvas.getContext("2d")!;
    context.drawImage(video, 0, 0, width, height);
    context.drawImage(maskCanvas, width, 0, width, height);
    return canvas.toDataURL("image/png").split(",")[1]!;
  },
};
Object.assign(window, { pwrsnapCameraWorker: api });
