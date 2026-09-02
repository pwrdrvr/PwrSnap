export type StartupAutomationPolicy = {
  acquireSingleInstanceLock: boolean;
  installTray: boolean;
  runStartupCodexProbe: boolean;
  registerGlobalHotkeys: boolean;
  syncLaunchAtLogin: boolean;
  initializeAppUpdater: boolean;
  startLocalAgentLifecycle: boolean;
};

/**
 * Decide which production startup surfaces an automated launch may exercise.
 *
 * Ordinary desktop E2E keeps its long-standing broad suppression because its
 * parallel dev launches must coexist with a real PwrSnap session. The
 * installed-artifact smoke is different: its controller has already refused
 * any existing PwrSnap process/install, so it can safely exercise the real
 * first-instance lock and packaged tray/icon/prewarm path. Host-global or
 * networked services stay disabled explicitly.
 */
export function resolveStartupAutomationPolicy(input: {
  isE2E: boolean;
  isPackagedWindowsSmoke: boolean;
}): StartupAutomationPolicy {
  const exerciseSafePackagedStartup = !input.isE2E || input.isPackagedWindowsSmoke;
  const allowHostOrNetworkSideEffects = !input.isE2E && !input.isPackagedWindowsSmoke;

  return {
    acquireSingleInstanceLock: exerciseSafePackagedStartup,
    installTray: exerciseSafePackagedStartup,
    runStartupCodexProbe: allowHostOrNetworkSideEffects,
    registerGlobalHotkeys: allowHostOrNetworkSideEffects,
    syncLaunchAtLogin: allowHostOrNetworkSideEffects,
    initializeAppUpdater: allowHostOrNetworkSideEffects,
    startLocalAgentLifecycle: allowHostOrNetworkSideEffects
  };
}
