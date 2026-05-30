# Sizzle Sequence Scenes

## What Shipped

Sizzle scenes now support two shapes:

- Simple scenes keep the existing one capture plus one script line model.
- Sequence scenes keep one continuous narration block and an ordered list of visual beats.

Sequence beats can point at images or videos, use explicit second offsets or phrase anchors, choose a beat transition, and declare a video fit policy. The renderer still persists the same project JSON through `sizzle:update`; the store normalizes old simple scenes without forcing a migration.

## Render Notes

The render path lowers a sequence scene into normal composer visual inputs. Each beat uses the same narration audio file with an `audioStartSec` offset, so the composer trims the right slice of narration for each visual segment instead of restarting the voiceover on every beat.

Short video beats no longer have to freeze by accident. `smart-fit` prefers bounded speed adjustment when the mismatch is small, loops short clips when repeat count is reasonable, and falls back to freeze-end with diagnostics when the safer options are outside limits.

## Manual Verification Flow

Use a Telegram setup reel as the smoke test:

1. Create or open a Sizzle Reel with captures for the onboarding wizard, Settings, Messaging settings, Telegram enablement, code generation, Telegram send, and approval.
2. Ask Sizzle chat to add one sequence scene with narration like: "To configure Telegram, start from the Wizard or open Settings, choose Messaging, enable Telegram, generate the code, send it from Telegram, approve the pairing, and you're set."
3. Confirm the sequence scene appears as one narration field with multiple beats in the editor.
4. Change one beat from phrase timing to offset timing, set one short video beat to `Loop`, and set one beat transition to `Push left`.
5. Render the reel.
6. Inspect that narration plays continuously while visuals advance beat-by-beat, and short clips do not hold the final frame unless their policy is `Freeze`.

## Follow-Up Edges

The compact editor is intentionally not a full timeline. A future pass can add waveform/timeline preview, beat thumbnails for every capture, and richer diagnostics display from the planner without changing the stored sequence scene contract.
