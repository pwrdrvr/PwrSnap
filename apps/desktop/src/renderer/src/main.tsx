import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { installRendererDiagnostics } from "./renderer-diagnostics";
import "./styles/app.css";

installRendererDiagnostics();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
