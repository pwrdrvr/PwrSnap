# Captions on Apple's on-device model

On a Mac running macOS 27 or later, PwrSnap can write a capture's title,
description, tags and file name with the language model built into macOS. The
capture is read on the Mac. It is not sent to a server, and there is no
account, key or bill.

It is off until you choose it. Nothing about it runs, and macOS is not asked
anything, until you open its Settings screen or set captions to it.

## Turning it on

1. Open **Settings → AI Providers → Apple Intelligence**. The screen says what
   macOS reports about the model.
2. When it reads **Ready**, choose **Use for captions**. That sets
   *Capture captions, tags & OCR* in **AI Features → Default agents** to
   *Apple Intelligence · on this Mac*. Library chat and Sizzle Reel chat are
   unchanged.

**Test** on that screen sends one short text prompt to the model and times the
answer. It uses no capture.

## What each state means

PwrSnap reads the state from macOS through `/usr/bin/fm`, the Foundation Models
command-line tool that ships with macOS 27. The tool being present does not
mean the model can run: it also ships on Macs that cannot run it.

| Settings shows | What macOS reported | What to do |
|---|---|---|
| **Ready** | The system model is available. | Nothing. |
| **Agree to terms** | Apple's Legal Notice & Terms for the tool have not been agreed to on this Mac. | An administrator agrees once per Mac, in Terminal. The tool names the command itself. PwrSnap never agrees for you. |
| **Not ready** | The model is not available yet. | Wait. macOS downloads and prepares the model by itself. |
| **Off in macOS** | Apple Intelligence is not enabled. | Check the language, region and any device management on this Mac. |
| **Not supported** | This device does not support Apple Intelligence. | Check Apple's requirements; some can be changed, the chip cannot. |
| **Needs macOS 27** | The tool is not on this Mac. | Update macOS, if this Mac can run macOS 27. |
| **Check fm config** | The tool is configured with a default model provider. | PwrSnap will not run a capture through the tool while one is set. |
| **Unavailable** | A reason this version of PwrSnap does not recognise. | Read macOS's own sentence, shown on the screen. |
| **Check failed** | The tool did not answer, or not readably. | Choose **Check again**. |

Under every state that is not Ready, the screen shows macOS's own sentence and
a **prompt for your agent**. Paste it into the coding agent you already use:
it can look at this Mac, which PwrSnap cannot, and walk you through the step
that is missing. Each prompt tells the agent to check before it advises, not to
install anything, not to change settings for you, not to bypass a macOS
protection, and never to agree to Apple's terms on your behalf.

**Check again** re-reads the state. Nothing polls. A caption that fails for a
setup reason also makes the next read ask macOS again.

Apple's own pages, linked from the screen:

- [Apple Intelligence requirements](https://support.apple.com/en-us/121115)
- [Why a model can be unavailable](https://developer.apple.com/documentation/foundationmodels/detecting-available-apple-foundation-models)
- [Apple's Foundation Models and the fm tool](https://developer.apple.com/foundation-models-framework/)

On Windows and Linux the provider does not appear anywhere.

## What it does and does not do

- **It reads images.** PwrSnap sends the same bounded copy of the capture it
  prepares for every provider (longest edge 1024 px), or the sampled frames of
  a recording.
- **Captions only.** It is not offered for Library chat or Sizzle Reel chat.
- **A small model.** Descriptions are shorter than a cloud model's, and it can
  misread small text. In testing it read `pnpm` in a terminal as `npm`.
- **It can decline a capture.** Apple's safety checks sometimes stop a request.
  That capture's caption fails and says so.
- **A failure stays a failure.** A declined capture, missing terms or a model
  that is still downloading never sends the capture to another provider. The
  caption fallback in AI Features does not act on any of them.
- **One capture at a time**, in the order they were taken.
- **No usage or cost is recorded.** The tool reports no token counts.

## Apple's terms

The tool's terms, which you agree to with Apple, restrict programmatic access
to Apple's models "except as expressly permitted". Apple documents the tool
for scripts and automation. PwrSnap runs the tool on your Mac, at your choice,
with a fixed command line. Read Apple's terms (`fm license --show`) and decide
whether that use suits you before turning this on.

## For contributors

The transport rules and the invariants that keep this path inside the
enrichment safety contract are in [AGENTS.md](../AGENTS.md) §"Apple's on-device
model runs through a fixed fm command line". The measurements behind it are in
[docs/solutions/2026-11-17-apple-fm-cli-captions-feasibility.md](solutions/2026-11-17-apple-fm-cli-captions-feasibility.md).
