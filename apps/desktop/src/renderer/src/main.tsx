import React from "react";
import ReactDOM from "react-dom/client";
import { App, IS_WINDOW_CHROME } from "./App";
import { installRendererDiagnostics } from "./renderer-diagnostics";
import { installGlobalRendererErrorHandlers } from "./lib/renderer-error-reporting";
import { startWindowFrameSync } from "./lib/window-frame";
import "./styles/app.css";

installRendererDiagnostics();
installGlobalRendererErrorHandlers();
// Linux windows are frameless and get no border, no rounded corners and (on
// X11) no drop shadow, so the app paints its own 1px edge — and has to know
// when the window is maximized and there is no edge left to draw. No-op off
// Linux, and skipped entirely on the popover surfaces (tray, float-over,
// region selector, recording HUD and frame): none of them paints an edge or a
// caption button, so the IPC round trip and the listener would buy nothing —
// and the tray popover is kept resident precisely to protect first-click
// latency. Stamped before the first render so the edge is there on the first
// frame.
if (IS_WINDOW_CHROME) startWindowFrameSync();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
