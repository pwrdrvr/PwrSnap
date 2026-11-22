# PwrSnap CPU capture rules

[PwrSnap CPU Capture Rules.html](PwrSnap%20CPU%20Capture%20Rules.html) is the exported visual reference for Settings → Developer → Hot CPU profiling.

High CPU remembers Spike or Sustained, and Slow burn can run alongside either or on its own. Each rule keeps its own 1–400% threshold and duration. At least one rule stays enabled in Settings. Start Capture and Stop Capture control recording. The main process and Library renderer evaluate the same saved rules independently.

The shipped defaults are Sustained at 50% for 4 s, Spike at 50% for 2 s, and Slow burn at 15% for 4 s. Fresh settings enable Sustained as the only rule. The normally 2 s cadence changes to 1 s for an enabled 1 s Spike. Valid environment overrides can change the effective mode, cadence, thresholds or number of samples. Settings shows the effective per-target rules when an override is active.

Both rules can match on the same sample. The profile and notice record those matches in High CPU, Slow burn order. CPU sampling pauses while the profile records its follow-up. The optional Chromium trace freezes at detection and saves a filtered companion in the renderer's existing diagnostics session.
