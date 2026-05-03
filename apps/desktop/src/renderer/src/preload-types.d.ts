declare global {
  interface Window {
    pwrsnapApi?: {
      platform: string;
      versions: { chrome: string; electron: string; node: string };
      dismissFloatOver: () => Promise<void>;
    };
  }
}

export {};
