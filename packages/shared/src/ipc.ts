// IPC channel name constants. Bare `<domain>:<verb>` — no `pwrsnap:`
// prefix (matches PwrAgnt convention).
//
// One central `cmd` channel carries every command-bus dispatch via
// ipcRenderer.invoke('cmd', name, req); transports pick the channel name
// out of the registry. Event channels (server → client broadcasts) use
// the typed map below.

export const IPC_CMD = "cmd" as const;

export const EVENT_CHANNELS = {
  capturesChanged: "events:captures:changed",
  overlaysChanged: "events:overlays:changed",
  uploadProgress: "events:upload:progress",
  aiRunUpdated: "events:ai-run:updated",
  renderProgress: "events:render:progress",
  recordingState: "events:recording:state",
  settingsChanged: "events:settings:changed"
} as const;

export type EventChannel = (typeof EVENT_CHANNELS)[keyof typeof EVENT_CHANNELS];
