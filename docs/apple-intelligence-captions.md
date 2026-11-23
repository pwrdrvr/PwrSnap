# Captions on Apple's on-device model

On a Mac running macOS 27 or later, PwrSnap can write a capture's title,
description, tags and file name with the language model built into macOS.
For still captures it can also save short snippets of visible text for
Library search. All processing stays on the Mac. There is no account, key or
bill.

Choose Apple Intelligence as the caption model or as a fallback in AI
Features. PwrSnap asks macOS whether the model can run when you open
**AI Providers** or **AI Features** in Settings, and while it is selected.
The check reads model availability without generating a response.

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

PwrSnap reads the state from the macOS Foundation Models framework.

| Settings shows | What macOS reported | What to do |
|---|---|---|
| **Ready** | The system model is available. | Nothing. |
| **Not ready** | The model is not available yet. | Wait. macOS downloads and prepares the model by itself. |
| **Off in macOS** | Apple Intelligence is not enabled. | Check the language, region and any device management on this Mac. |
| **Not supported** | This device does not support Apple Intelligence. | Check Apple's requirements; some can be changed, the chip cannot. |
| **Needs macOS 27** | This Mac runs an earlier version. | Update macOS, if this Mac can run macOS 27. |
| **Unavailable** | macOS reported an unrecognized availability state. | Check Apple Intelligence in System Settings. |
| **Check failed** | PwrSnap couldn't read availability. | Choose **Check again**. |

Settings offers a **prompt for your agent** to help check an unavailable model.

**Check again** re-reads the state. Nothing polls. A caption that fails for a
setup reason also makes the next read ask macOS again. A change is sent to every
open PwrSnap window, so after Check again shows Ready the Library and the
capture toast offer AI again without a restart.

If PwrSnap cannot ask at all, a Mac shows the provider as **Check failed** with
the error, and Check again stays available.

Apple's own pages, linked from the screen:

- [Apple Intelligence requirements](https://support.apple.com/en-us/121115)
- [Why a model can be unavailable](https://developer.apple.com/documentation/foundationmodels/detecting-available-apple-foundation-models)
- [Apple's Foundation Models](https://developer.apple.com/foundation-models-framework/)
- [Apple's acceptable use requirements for the model](https://developer.apple.com/support/terms/acceptable-use-requirements-for-the-foundation-models-framework/)

On Windows and Linux the provider does not appear anywhere.

## How captions are generated

- PwrSnap prepares a bounded image with a longest edge of 1024 px, or three
  sampled frames for a recording. For still images, Apple's Vision framework
  reads screen text on the Mac. The model sees the image, capture metadata,
  and a bounded amount of that text together. The model looks for distinctive
  search terms such as complete filenames, identifiers and error messages.
  Vision runs with language correction off to better preserve filenames and
  identifiers. PwrSnap saves up to five verbatim snippets of at most 120 UTF-8
  bytes each, alongside the caption fields. Each snippet must match text
  within a single line of the Vision evidence. PwrSnap discards the evidence
  after captioning. If Vision misses or misreads small text, the corresponding
  search term may be absent or misspelled.
- **Captions only.** It is not offered for Library chat or Sizzle Reel chat.
- **A small model.** Descriptions are shorter than a cloud model's, and it can
  misread small text. In testing it read `pnpm` in a terminal as `npm`.
- **It can decline a capture.** Apple's safety checks sometimes stop a request.
  That capture's caption fails and says so.
- **A failure stays a failure.** A declined capture or a model that is still
  downloading does not trigger a fallback to another provider.
- **It can be the offline fallback.** Behind a Codex primary, AI Features can
  name it as the caption fallback for connection failures where Codex
  receives no HTTP response.
- **One capture at a time**, in the order they were taken.
- **No usage or cost is recorded.** The request runs entirely on this Mac.

## Apple's terms

Apple publishes [acceptable use requirements for the Foundation Models framework](https://developer.apple.com/support/terms/acceptable-use-requirements-for-the-foundation-models-framework/).

## For contributors

The transport rules are in [the Apple caption helper guidance](agents/ai-backends.md#apples-on-device-caption-helper).
Development checkouts without the helper can use the guarded `/usr/bin/fm`
route. In that mode, **Agree to terms** and **Check fm config** apply to the
CLI. PwrSnap only opens an empty Terminal when asked. An administrator can
review and agree to the CLI terms separately.

To test the bundled path on an Apple Silicon Mac with macOS 27 and a ready
model, build the native helpers and run the opt-in synthetic caption and
search test.

```sh
pnpm build:native
PWRSNAP_APPLE_FM_NATIVE_REAL=1 pnpm exec vitest run apps/desktop/src/main/ai/apple-fm/__tests__/apple-fm-real.test.ts
```

The original CLI measurements are in
[docs/solutions/2026-11-17-apple-fm-cli-captions-feasibility.md](solutions/2026-11-17-apple-fm-cli-captions-feasibility.md).
