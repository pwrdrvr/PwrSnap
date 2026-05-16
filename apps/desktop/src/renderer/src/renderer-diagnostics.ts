type ViteErrorPayload = {
  err?: {
    message?: string;
    stack?: string;
    id?: string;
    plugin?: string;
  };
};

type PreloadErrorEvent = Event & {
  payload?: unknown;
};

const OVERLAY_ID = "pwrsnap-renderer-diagnostics";

function detailFromUnknown(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ensureOverlay(): HTMLDivElement {
  const existing = document.getElementById(OVERLAY_ID);
  if (existing instanceof HTMLDivElement) return existing;

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.className = "renderer-diagnostics";
  overlay.hidden = true;

  const title = document.createElement("div");
  title.className = "renderer-diagnostics__title";
  title.dataset.role = "title";

  const message = document.createElement("div");
  message.className = "renderer-diagnostics__message";
  message.dataset.role = "message";

  const details = document.createElement("pre");
  details.className = "renderer-diagnostics__details";
  details.dataset.role = "details";

  const actions = document.createElement("div");
  actions.className = "renderer-diagnostics__actions";

  const reload = document.createElement("button");
  reload.type = "button";
  reload.className = "renderer-diagnostics__button";
  reload.textContent = "Reload window";
  reload.addEventListener("click", () => window.location.reload());

  actions.append(reload);
  overlay.append(title, message, details, actions);
  document.body.append(overlay);
  return overlay;
}

function showOverlay(title: string, message: string, detailsText: string): void {
  const overlay = ensureOverlay();
  const titleEl = overlay.querySelector<HTMLElement>('[data-role="title"]');
  const messageEl = overlay.querySelector<HTMLElement>('[data-role="message"]');
  const detailsEl = overlay.querySelector<HTMLElement>('[data-role="details"]');

  if (titleEl !== null) titleEl.textContent = title;
  if (messageEl !== null) messageEl.textContent = message;
  if (detailsEl !== null) {
    detailsEl.textContent = detailsText;
    detailsEl.hidden = detailsText.trim().length === 0;
  }
  overlay.hidden = false;
}

function hideOverlay(): void {
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay !== null) overlay.hidden = true;
}

export function installRendererDiagnostics(): void {
  window.addEventListener("vite:preloadError", (event) => {
    event.preventDefault();
    showOverlay(
      "Renderer chunk failed to load",
      "PwrSnap could not load part of the renderer. Reload the window after the dev server or packaged assets are available.",
      detailFromUnknown((event as PreloadErrorEvent).payload)
    );
  });

  if (!import.meta.hot) return;

  import.meta.hot.on("vite:error", (payload: ViteErrorPayload) => {
    const err = payload.err;
    const detailLines = [
      err?.message,
      err?.id === undefined ? undefined : `module: ${err.id}`,
      err?.plugin === undefined ? undefined : `plugin: ${err.plugin}`,
      err?.stack
    ].filter((line): line is string => line !== undefined && line.length > 0);

    showOverlay(
      "Dev renderer update failed",
      "Vite could not reload a renderer module. Fix the transform error, then reload the window.",
      detailLines.join("\n\n")
    );
  });

  import.meta.hot.on("vite:ws:disconnect", () => {
    showOverlay(
      "Dev server disconnected",
      "The renderer lost its Vite websocket connection. Restart the dev server if it does not reconnect.",
      ""
    );
  });

  import.meta.hot.on("vite:ws:connect", hideOverlay);
  import.meta.hot.on("vite:afterUpdate", hideOverlay);
}
