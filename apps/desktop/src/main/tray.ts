import { BrowserWindow, nativeImage, Tray } from "electron";
import { createTrayWindow, positionTrayWindow } from "./window";

// 1×1 transparent template image. Tray() requires a non-empty image, but on
// macOS we lean on `setTitle()` to render the visible glyph in the menubar
// — gives crisp text rendering across light/dark menubars without shipping
// a binary asset.
const BLANK_TEMPLATE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
  "base64"
);

let tray: Tray | null = null;
let trayWindow: BrowserWindow | null = null;

function ensureTrayWindow(): BrowserWindow {
  if (trayWindow && !trayWindow.isDestroyed()) return trayWindow;
  const window = createTrayWindow();
  trayWindow = window;
  window.on("closed", () => {
    if (trayWindow === window) trayWindow = null;
  });
  return window;
}

export function installTray(): Tray {
  if (tray) return tray;

  const icon = nativeImage.createFromBuffer(BLANK_TEMPLATE_PNG);
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setTitle("P");
  tray.setToolTip("PwrSnap — ⌘⇧P to capture");
  tray.setIgnoreDoubleClickEvents(true);

  const onClick = () => {
    const window = ensureTrayWindow();
    if (window.isVisible()) {
      window.hide();
      return;
    }
    const bounds = tray!.getBounds();
    positionTrayWindow(window, bounds);
    window.show();
    window.focus();
  };

  tray.on("click", onClick);
  tray.on("right-click", onClick);

  return tray;
}

export function disposeTray(): void {
  if (trayWindow && !trayWindow.isDestroyed()) {
    trayWindow.destroy();
    trayWindow = null;
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
