import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { installRendererDiagnostics } from "./renderer-diagnostics";
import { installGlobalRendererErrorHandlers } from "./lib/renderer-error-reporting";
import { startWindowFrameSync } from "./lib/window-frame";
import "./styles/app.css";

installRendererDiagnostics();
installGlobalRendererErrorHandlers();
// Linux windows are frameless and get no border, no rounded corners and (on
// X11) no drop shadow, so the app paints its own 1px edge — and has to know
// when the window is maximized and there is no edge left to draw. Every window
// kind starts this, including the ones that render no title bar of ours; it
// no-ops off Linux. Stamped before the first render so the edge is there on
// the first frame.
startWindowFrameSync();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
