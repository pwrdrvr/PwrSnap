# Getting help with PwrSnap

PwrSnap is built by [PwrDrvr LLC](https://pwrdrvr.com). Support is public,
best-effort, and happens here on GitHub — there is no ticket queue and no SLA.
Asking in the open is deliberate: an answered question stays searchable for the
next person who hits the same thing.

## Where to go

| You want to… | Go here |
| --- | --- |
| Ask a question, or check whether something is expected behavior | [Discussions → Q&A](https://github.com/pwrdrvr/PwrSnap/discussions/categories/q-a) |
| Report something broken | [New bug report](https://github.com/pwrdrvr/PwrSnap/issues/new?template=bug_report.md) |
| Request a specific capability | [New feature request](https://github.com/pwrdrvr/PwrSnap/issues/new?template=feature_request.md) |
| Float a rough idea before it's a request | [Discussions → Ideas](https://github.com/pwrdrvr/PwrSnap/discussions/categories/ideas) |
| Show an annotation, workflow, or agent setup | [Discussions → Show and tell](https://github.com/pwrdrvr/PwrSnap/discussions/categories/show-and-tell) |
| Report a security vulnerability | **Not** in public — follow [SECURITY.md](SECURITY.md) |

Not sure between Q&A and a bug report? **Start in Q&A.** A discussion can be
converted into an issue in one click and keeps its history; a misfiled issue
just adds noise to the tracker.

## Before you ask

- **Check the docs** — [docs.pwrsnap.com](https://docs.pwrsnap.com) covers
  capture modes, hotkeys, settings, and AI configuration. Windows specifics
  (install locations, Controlled Folder Access, FFmpeg, troubleshooting) are in
  [docs/windows/README.md](docs/windows/README.md).
- **Search first** — both
  [Discussions](https://github.com/pwrdrvr/PwrSnap/discussions) and
  [Issues](https://github.com/pwrdrvr/PwrSnap/issues?q=is%3Aissue).
- **Update** — Help → Check for Updates, or grab the
  [latest release](https://github.com/pwrdrvr/PwrSnap/releases/latest).

## What makes a question answerable

1. **A picture.** You have a screenshot tool right there: capture the problem,
   click the **Med** copy button in the float-over toast, and paste (⌘V / Ctrl+V)
   straight into the box. Annotate it first if that makes the problem clearer.
2. **Your version and OS** — Help → About, plus macOS or Windows version.
3. **What you expected vs. what happened**, and the exact steps to get there.
4. **Logs, if it's a crash or a failure** — Help → Logs. Skim before pasting;
   log paths can include file and folder names.

## Things that come up a lot

- **PwrSnap works fully without AI.** Capture, annotation, the library, and
  export need no account and no provider. AI features are optional and ride the
  Codex CLI / Codex Desktop you already have — PwrSnap holds no API key of its
  own and never calls a model provider directly.
- **No telemetry, no PwrSnap account, no PwrSnap server.** If something needs
  to leave your machine, you asked for it.
- **Where your stuff lives:** captures and chat threads in
  `~/Documents/PwrSnap` (macOS) or `%USERPROFILE%\Documents\PwrSnap` (Windows),
  with a `~/PwrSnap` / `%USERPROFILE%\PwrSnap` fallback if Documents is denied.
  Database, settings, and encrypted secrets live in
  `~/Library/Application Support/PwrSnap` or `%APPDATA%\PwrSnap`.
  **Don't move capture files by hand** — the database stores their paths.

## Response expectations

Small team, public queue. Questions usually get a reply within a few days.
Security reports are triaged as a priority through the private channel in
[SECURITY.md](SECURITY.md).

Contributing code instead? See [CONTRIBUTING.md](CONTRIBUTING.md).
