import { contextBridge, ipcRenderer } from "electron";

const IPC = {
  dismissFloatOver: "pwrsnap:float-over:dismiss"
} as const;

const pwrsnapApi = {
  platform: process.platform,
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node
  },
  dismissFloatOver: () => ipcRenderer.invoke(IPC.dismissFloatOver) as Promise<void>
};

export type PwrsnapApi = typeof pwrsnapApi;

contextBridge.exposeInMainWorld("pwrsnapApi", pwrsnapApi);
