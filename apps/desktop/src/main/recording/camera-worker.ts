import { BrowserWindow, app } from "electron";
import { join } from "node:path";

/** Internal, hidden sandboxed processor. It never paints over the recording. */
export class CameraWorker {
  readonly window = new BrowserWindow({
    width: 640,
    height: 360,
    show: false,
    focusable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  async load(): Promise<void> {
    const dev = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
    if (dev) await this.window.loadURL(new URL("camera.html", dev).href);
    else await this.window.loadFile(join(__dirname, "../renderer/camera.html"));
  }
  async call<T>(
    method: "clock" | "record" | "stop" | "open" | "frame",
    ...args: unknown[]
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.window.webContents.executeJavaScript(
          `window.pwrsnapCameraWorker[${JSON.stringify(method)}](...${JSON.stringify(args)})`,
        ) as Promise<T>,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Camera processing timed out.")),
            30_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  close(): void {
    if (!this.window.isDestroyed()) this.window.destroy();
  }
}
