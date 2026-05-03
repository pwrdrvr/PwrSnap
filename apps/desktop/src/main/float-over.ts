import { BrowserWindow } from "electron";
import { createFloatOverWindow } from "./window";

let current: BrowserWindow | null = null;

export function showFloatOver(): BrowserWindow {
  // Stack policy: a fresh ⌘⇧P closes the in-flight toast and opens a new
  // one. Once we have real captures, the prior toast(s) collapse to chips
  // above the active one (see fo-stack styles); for now just replace.
  if (current && !current.isDestroyed()) {
    current.destroy();
    current = null;
  }
  const window = createFloatOverWindow();
  current = window;
  window.on("closed", () => {
    if (current === window) current = null;
  });
  return window;
}

export function dismissFloatOver(): void {
  if (current && !current.isDestroyed()) {
    current.destroy();
  }
  current = null;
}
