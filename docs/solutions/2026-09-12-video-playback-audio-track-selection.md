# Which audio track a player actually takes, and what it costs to fix

**Date:** 2026-09-12
**Context:** finishing the `video:playback` rollout started in
[#496](https://github.com/pwrdrvr/PwrSnap/pull/496), and settling a review
question about whether the underlying mechanism was at the right altitude.

## The premise everyone was working from was wrong

`#496`, the `video:playback` protocol comment, and the docblock on
`videoPlaybackNeedsPreparation` all said the same thing:

> An HTML5 `<video>` plays the FIRST audio track and ignores the rest.

The first half of that is false. Chromium plays the track carrying the MP4
`track_enabled` flag — what ffmpeg calls `disposition:default` — and only
falls back to document order when several tracks carry it.

The distinction never showed up because AVAssetWriter marks **every** track
it writes as enabled, so on a PwrSnap recording the default track and the
first track are the same track. The symptom was identical; the cause was not.
That matters, because "first" is a property of the file you cannot change
without rewriting it, while "default" is one flag.

### How it was measured

A `<video>` is loaded under a Web Audio `AnalyserNode` (analyser only — not
connected to the destination, so nothing plays aloud) and the output is
sampled for 1.8s. Silence reads rms 0; a 440 Hz tone reads rms ~0.09. The
harness is ~30 lines and is reproduced at the bottom of this file.

Three fixtures, each with a silent track and a tone track:

| fixture | first audio track | `default` flag on | measured rms |
|---|---|---|---|
| `twotrack.mp4` | silence | silence | **0** |
| `disposition.mp4` | silence | tone | **0.088** |
| `toneFirst.mp4` | **tone** | silence | **0** |

`disposition.mp4` differs from `twotrack.mp4` in the flag alone — stream
order is byte-identical, verified with `volumedetect` per track. `toneFirst`
is the discriminator: the tone is physically first and it still played
silent. **Chromium follows the flag, not the order.**

Identical results in the shipped runtime (Electron 41 / Chrome 146) and in a
standalone Chrome 152, so this is not an Electron quirk.

### Confirmed against a real recording

A real two-track capture from the author's library — system audio armed with
nothing playing through it, in front of a live microphone:

```
a:0  mean_volume: -91.0 dB     <- system, silent
a:1  mean_volume: -32.8 dB     <- microphone, the actual narration
both streams: disposition:default=1
```

Loaded as-is in Electron: **rms 0.** The bug, on a real file, in the shipped
runtime. Both candidate fixes restored the microphone.

## What each mechanism actually costs

Measured on that recording (6.6s, 6.55 MB), `/usr/bin/time -p`:

| mechanism | output size | wall | handles "select" | handles "mix" |
|---|---|---|---|---|
| `-disposition:a:N default`, `-c copy` | 6,552,574 B (**100%**) | 0.08s | yes | **no** |
| today: video copy + AAC mix (`#496`) | 6,607,806 B (101%) | 0.11s | yes | yes |
| the mixed `.m4a` the waveform lane already builds | 113,277 B (**1.7%**) | 0.10s | yes | yes |

### Why the disposition rewrite was rejected

The review's hypothesis was that it "rewrites metadata, not bytes… replaces
a ~600MB copy with a near-instant operation." The first clause is true of the
container semantics and false of the operation: **ffmpeg has no in-place
mode.** Flipping one flag muxes a whole new file. Measured, a 2-byte semantic
change wrote 6,552,574 bytes — the same disk cost as the mechanism it was
meant to replace, for a 0.03s CPU saving that is the AAC encode.

And it is strictly less capable. A player takes one track, so disposition can
only ever *select*; it cannot *mix*. The genuinely-both-audible take — music
playing under narration — still needs a real mix. So the option costs the
same disk as today and handles fewer cases: dominated, not a trade-off.

Patching the source's `tkhd` in place would be genuinely free, and is not on
the table: it mutates the user's original recording, which the architecture
keeps untouched so exports can still select either stem.

### Why record-time was rejected

`main.swift` adds writer inputs system-first, mic-second, unconditionally.
The order is not the problem — a silent-but-armed track in front is, and
which source will stay silent is not knowable before the take. Deciding at
finalize time means a post-pass, which is a remux again. It also does nothing
for recordings that already exist, which is the whole affected set today.

### What was chosen

**Keep the prepared rendition.** It is the only listed option that handles
both shapes, it already ships, and the measurement removed the one reason to
replace it.

**The mixed-`.m4a` route (muted `<video>` + a synced `<audio>`) is the real
future move**, and the 1.7% above is why. It is not taken here because it
trades a correctness property for a disk property: two media elements against
a master clock can drift, and the surfaces that would adopt it are exactly
the ones where being wrong is worst — the post-capture toast is where a user
checks whether their narration recorded at all. `useReelPlayback.ts` already
drives that pattern in this codebase, so the machinery exists when the
disk cost justifies the sync risk.

## The reproduction harness

```bash
ffmpeg -y -f lavfi -i "testsrc=size=640x360:rate=30:duration=6" \
       -f lavfi -i "anullsrc=channel_layout=mono:sample_rate=48000:duration=6" \
       -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=6" \
       -map 0:v -map 1:a -map 2:a -t 6 \
       -c:v libx264 -pix_fmt yuv420p -c:a aac twotrack.mp4

ffmpeg -y -i twotrack.mp4 -map 0 -c copy \
       -disposition:a:0 0 -disposition:a:1 default disposition.mp4

ffmpeg -y -i twotrack.mp4 -map 0:v -map 0:a:1 -map 0:a:0 -c copy toneFirst.mp4
```

```js
// Analyser only — never connected to ctx.destination, so nothing is audible.
const v = document.createElement("video");
v.src = src; v.muted = false; v.volume = 1;
await new Promise((r) => { v.onloadedmetadata = r; });
const ctx = new AudioContext();
ctx.createMediaElementSource(v).connect(an = ctx.createAnalyser());
await ctx.resume(); await v.play();
// …sample an.getFloatTimeDomainData() for ~1.8s, report rms.
```

Serve over `http://127.0.0.1` rather than `file://` — a `file://` source
taints the media element and `createMediaElementSource` reads zeros, which
looks exactly like the bug.

Drive it under Electron with a throwaway `BrowserWindow` and
`app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required")`;
without that switch `play()` rejects and every fixture reads rms 0.

## Consequences recorded in code

- `videoPlaybackNeedsPreparation` moved to `packages/shared` so a renderer
  can answer "can this recording even need a rendition?" without dispatching
  a verb that may remux.
- Its docblock no longer claims "first track"; it says the player takes one
  track and points here.
- The rendition filename regained a content key (`computeVideoPlaybackCacheKey`)
  — see the PR for that half.
