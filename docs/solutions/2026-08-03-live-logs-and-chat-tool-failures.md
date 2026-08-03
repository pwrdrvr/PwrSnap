---
title: Live logs and Codex chat-tool failure visibility
date: 2026-08-03
area: desktop-diagnostics
---

# Live logs and Codex chat-tool failure visibility

## Problem

PwrSnap wrote `main.log` (and `library.log` in the split-process library role),
but had no in-app viewer. Renderer failures only reached DevTools, and the
shared chat-tool dispatcher deliberately converted tool exceptions and command
errors to `success: false` responses without writing a log. Codex could see and
recover from a failed tool call while the user had no diagnostic trail.

## Implementation

- `electron-log` remains the durable source of truth. Its file hook compacts
  structured payloads and appends the formatted line to a bounded 5,000-entry
  in-memory ring.
- Help → Logs opens a singleton renderer with snapshot + live-event delivery,
  search, level filters, follow/pause, optional debug collection, and the exact
  durable file path with Copy and Reveal controls.
- React error boundaries, `window.error`, and `unhandledrejection` report over
  the command bus and are validated before reaching the main logger.
- The shared library/sizzle chat-tool dispatcher logs `success: false` at warn
  level with namespace, tool, call/thread/turn ids, principal, duration, and the
  returned text error. It logs successful calls only at debug level. Arguments,
  results, and image data are intentionally excluded.

## Split-process ownership

The Logs window is library-owned because editor and sizzle chat run in the
library process. It therefore displays the live `library.log` tail when the
two-process split is active. The always-resident capture/agent process keeps its
separate `main.log`, preventing two Electron processes from racing one file's
rotation. Combined mode uses `main.log` as before.
