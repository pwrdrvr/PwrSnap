// Side-effect bootstrap for the startup profiling harness.
//
// This MUST stay the first import in src/main/index.ts: rollup preserves
// side-effect import order, so importing it first means the main-process
// CPU profiler (PWRSNAP_STARTUP_PROFILE=1) is sampling before the rest of
// the main bundle evaluates — bundle-eval cost shows up in the profile.
// No-op when the env flag is absent.
import { beginMainProcessProfile } from "./startup-profiler";

beginMainProcessProfile();
