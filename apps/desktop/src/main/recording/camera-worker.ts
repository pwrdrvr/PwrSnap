import { BrowserWindow, app, screen } from "electron";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { linuxSquareCorners } from "../linux-window-corners";
import { cameraPreviewBounds } from "./camera-preview-placement";

/** Sandboxed recorder/processor. Only the recorder can opt into a native,
 * explicitly excluded live preview; processing workers remain hidden. */
export class CameraWorker {
  private previewTitle: string | null = null;
  private readonly hidePreview = () => {
    if (!this.window.isDestroyed()) this.window.hide();
    this.previewTitle = null;
  };
  readonly window = new BrowserWindow({
    ...linuxSquareCorners(),
    width: 640,
    height: 360,
    show: false,
    focusable: false,
    skipTaskbar: true,
    frame: false,
    movable: false,
    resizable: false,
    backgroundColor: "#000000",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  preparePreview(displayId: number, rect: { x: number; y: number; w: number; h: number }): { title: string; ownerPid: number } | undefined {
    if (process.platform !== "darwin") return;
    const bounds = cameraPreviewBounds(screen.getAllDisplays(), displayId, rect);
    if (!bounds) return;
    this.previewTitle = `PwrSnap Camera ${randomUUID()}`;
    this.window.on("page-title-updated", event => event.preventDefault());
    this.window.setTitle(this.previewTitle);
    this.window.setContentProtection(true);
    this.window.setBounds(bounds, false);
    this.window.setAlwaysOnTop(true, "floating");
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.window.setIgnoreMouseEvents(true);
    // Order an invisible window so SCShareableContent can identify it. Camera
    // pixels become visible only after native capture confirms the exclusion.
    this.window.setOpacity(0);
    this.window.showInactive();
    screen.on("display-removed", this.hidePreview);
    screen.on("display-metrics-changed", this.hidePreview);
    return { title: this.previewTitle, ownerPid: process.pid };
  }

  confirmPreviewExclusion(excluded: boolean): void {
    if (!excluded || !this.previewTitle) { this.hidePreview(); return; }
    this.window.setOpacity(1);
  }
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
    screen.removeListener("display-removed", this.hidePreview);
    screen.removeListener("display-metrics-changed", this.hidePreview);
    if (!this.window.isDestroyed()) this.window.destroy();
  }
}
