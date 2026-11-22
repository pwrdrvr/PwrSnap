# Codex still sizing experiment

This study compares the 1,024 px PwrSnap WebP derivative with a display-point
candidate and larger controls. The experiment lives in the test project.
PwrSnap ships the same 1,024 px default and format routing.

## Reproduce the batch

Use the repository's Node version and build the native helpers in this
checkout. The recorded batch used macOS arm64, Codex 0.169.0, GPT-6-Luna and
Medium reasoning. The fixtures rasterize Verdana and Andale Mono via sharp.
Use those fonts to reproduce the recorded image hashes.

```sh
source ~/.nvm/nvm.sh
nvm use
pnpm install --frozen-lockfile
pnpm build:native

PWRSNAP_SIZING_LIVE=1 \
PWRSNAP_SIZING_AUTH_FILE="$HOME/.codex/auth.json" \
PWRSNAP_SIZING_RESULTS="$(mktemp -d)/results.jsonl" \
pnpm test --project desktop-main --silent=passed-only codex-still-sizing.experiment

node apps/desktop/src/main/ai/__tests__/still-sizing/report.mjs /path/to/results.jsonl
node apps/desktop/src/main/ai/__tests__/still-sizing/report.mjs /path/to/results.jsonl --blind
```

Use a currently signed-in Codex file profile with Luna access. The harness
uses a temporary copy of the auth file, a fresh configuration, scratch SQLite,
generated PNGs and a dedicated enrichment jail. The output path must be new.
The live run is opt-in and issues up to 22 sequential real model turns, or one
with `PWRSNAP_SIZING_SMOKE=1`. `PWRSNAP_SIZING_CODEX` selects the binary if needed.
The harness closes the app server and removes its private scratch, credentials
and raw trace in teardown. It writes only the measured fields and synthetic
captions to the results file.

The production `codex:enrich` handler runs through the command bus, reads the
capture record, prepares the still, calls the real pooled Codex client with
its normal jail and structured prompt, and persists the run. The harness
injects temporary settings and the real client configured for the isolated
profile. Its only image change is the long-edge override for each arm of the
existing sharp WebP Q75 encoder. The 1 MB encoded limit applies to all arms.
The same source PNG and metadata are used for every arm of a fixture. The
schedule interleaves fixtures and reverses the first round for the second.
The first turn includes app-server startup. A separate pilot requested Low,
but the Codex request carried Medium. The measured batch explicitly requested
Medium and checked the model and effort on the wire for each turn.

Codex's rollout trace captures the model-visible Responses request. Every
measured generation trace contained a WebSocket `response.create` payload with
one inline image and no explicit image `detail`. The harness decodes that
image, reads its dimensions and compares its digest with the prepared
derivative. All 22 upstream images were byte-identical, including the 2,880 px
arm. Each fixture had the same hash of emitted instruction and input text
across all arms after normalizing the local image path. This records
client-side delivery. It does not expose the provider's internal raster.
[Codex inference trace](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/core/src/client.rs#L2267-L2337)

## Candidate policy and stored DPR

- Start with the normalized source raster's actual dimensions. New stills
  store the decoded raster dimensions in SQLite. Region selection maps
  logical coordinates through the display factor and clamps the crop to the
  captured image. A stitched canvas uses the composite scale. Neither crop
  dimensions nor parity establish DPR.
- Pass DPR only where the source's density is known. The record generally
  holds a display or composite scale, with 1 as a default when unavailable.
  Older/legacy data can have the SQL default of 1 or a nominal 2 for pixels
  measured at 1×. Imported bundles use 1 because the bundle does not
  preserve density. A stored value of 1 can therefore represent a native 1×
  screen or missing information. Even a stored 2 alone is insufficient
  proof of a 2× source across the existing library.
- Divide the long edge by trusted DPR and round it down to a whole pixel.
  The other dimension follows the same scale, rounded to nearest with a
  minimum of 1 px. Even 2× fixtures halve exactly when they fit. The
  1,351 × 1,801 crop produces 675 × 900. Trusted fractional DPR is supported.
  Missing or invalid DPR uses a divisor of 1 under the same bounds.
- Limit to **1,400,000 pixels**, a **2,048 px long edge** and **1,000,000
  encoded bytes**. Never upscale. If the point-size raster exceeds the
  area or edge limit, search for the largest fitting integer long edge
  using the rounded raster dimensions. An additional integer divisor
  would downsample a 2,416 × 2,416 2× source to about 805² instead of
  1,183². Encode from the source in one resize pass. The existing encoder
  rejects byte overruns and cleans scratch. A shipping follow-up should
  validate the encoded dimensions too and define how to handle rare byte
  overruns using real captures.
- Keep **Balanced** at today's 1,024 px. If a larger study justifies a
  separately reviewable **Higher detail** setting, use the bounded policy
  and retain at least the Balanced dimensions for small 2× crops. Use
  a bounded raster-only mode where density provenance is unavailable.
  Leave pixel, edge and byte caps internal. Full resolution and the
  near-point arm are controls. The study does not establish a shipping
  opt-in, and changes to version routing or Apple's offline JPEG would
  need separate evidence.

Source audit in [capture handlers](../../../handlers/capture-handlers.ts),
[bundle persistence](../../../persistence/bundle-store.ts),
[import](../../../import/pwrsnap-import-service.ts),
[original schema](../../../persistence/migrations/0001_init.sql) and
[historical density notes](../../../../../../../packages/shared/src/annotation-scale.ts).

## Quality scoring

The source fixtures are a 2× 2,880 × 1,866 release console, an odd 2×
1,351 × 1,801 crop of a replication dashboard, and a native 1×
1,900 × 803 retention monitor. They use different layouts and 9-point
exception text. The per-fixture status and four secondary facts come
from the text rendered into the source. Exact recall matches phrases
in the generated title, description, OCR or anchors after punctuation
and case normalization. This is a measure of what the caption surfaced,
not a test of exhaustive OCR.

For the qualitative review, shuffle the answers by opaque ID and omit
the arm, dimensions, tokens and timing. Score a title as useful if it
identifies the subject and specific gate, exception or state. Score a
description as useful if it accurately explains the panel and decisive
state. Count each unsupported concrete claim once. Review against the
source and its fixture facts. No external judge was needed.

The review marked **22/22 titles** and **20/22 descriptions** useful.
Both incomplete descriptions came from the 1× baseline and omitted
that purge was deferred. One full-size crop response called replica
`Q4-M7` a checkpoint. The title and decisive state in that response
remained useful. The three exceptions are reproducible in blind output
as `c29dac75a9`, `4ef99722d2` and `9dbcf145aa`, respectively.
The release console read the same decisive status and surfaced the
same two secondary facts on all five arms. The near-point arm
(1,434 × 929) uses the same 45 × 30 patch grid as the exact half-size
arm and about 0.84% fewer pixels. With two repeats per arm there is no
evidence of a pixel-alignment advantage.

## Measurements

[results.jsonl](results.jsonl) contains all 22 observations. Medians are
shown with min–max in brackets. Prep is time inside the derivative
encoder. Model is the pooled client call, including the one-shot app-server
work. Upstream is the time between the trace's request and response
events. Wall is command dispatch to an observed terminal run, including
up to 25 ms of polling. Bytes are decoded WebP bytes. Base64 counts and
total tokens including output are in the data.

Patch estimates assume `ceil(width/32) × ceil(height/32)` and a 1.2×
multiplier with ceiling, using the observed upstream dimensions and
assuming no further resize. The measured usage has total prompt, cached
input, output, reasoning and cache-write counts. It has no image-only
field. For the release fixture, 1,440 × 933 is 1,350 raw patches and
1,620 modeled tokens. Full is 5,310 raw patches and 6,372 modeled tokens.
Relative to baseline, the median prompt deltas were +813 and +5,566
tokens, within one token of the modeled deltas of +813 and +5,565.
The near-point arm differs from the exact half-size arm by about one
input token. The patch model fits this batch, while a flat 1,300/5,248
token assumption underestimates these inputs. The public vision guide
lists the multiplier for related models. The absolute Luna image counts
remain estimates.
[OpenAI patch calculation](https://developers.openai.com/api/docs/guides/images-vision#patch-based-image-tokenization)

Dollar values estimate Standard API-equivalent usage at $0.10/$0.01/$0.125
per million uncached/cached/cache-write input tokens and $0.50 per million
output tokens. No cache writes were reported. The PwrSnap pricing catalog
had no Luna entry. These are estimates using observed token counts, and
the ChatGPT subscription charge was not observable. Cached input varied
between zero and 4,352 tokens and can outweigh size in the per-turn cost.
The matched uncached input premium over baseline on the 2× release
console was approximately $0.000081 for points or $0.000557 for full.
[GPT-6-Luna pricing](https://developers.openai.com/api/docs/models/gpt-6-luna)

| Fixture / arm | Prepared px / B | Upstream px / B | Patches × 1.2 | Input | Cached | Output | Est. USD × 1,000 | Prep ms | Model s | Upstream s | Wall s | Exact status | Exact facts |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| release/baseline | 1024×663 / 24728 | 1024×663 / 24728 | 807 | 7143 [7142–7143] | 4352 [4352–4352] | 185 [150–219] | 0.415 [0.398–0.432] | 94.8 [51.4–138.2] | 6.73 [5.63–7.82] | 5.42 [4.51–6.33] | 6.84 [5.79–7.89] | 2/2 | 4/8 |
| replica/baseline | 768×1024 / 44954 | 768×1024 / 44954 | 922 | 7258 [7257–7258] | 2176 [0–4352] | 171 [145–196] | 0.615 [0.407–0.824] | 52.2 [39.4–65.1] | 5.36 [4.68–6.03] | 4.46 [3.81–5.12] | 5.42 [4.75–6.10] | 2/2 | 2/8 |
| retention/baseline | 1024×433 / 13978 | 1024×433 / 13978 | 538 | 6873 [6873–6873] | 4352 [4352–4352] | 228 [219–236] | 0.409 [0.405–0.414] | 30.3 [30.0–30.6] | 6.11 [5.92–6.31] | 5.12 [5.07–5.17] | 6.15 [5.95–6.35] | 0/2 | 1/8 |
| release/points | 1440×933 / 42826 | 1440×933 / 42826 | 1620 | 7956 [7955–7956] | 2176 [0–4352] | 180 [151–209] | 0.690 [0.508–0.871] | 64.4 [64.2–64.6] | 5.30 [4.72–5.89] | 4.26 [3.62–4.90] | 5.37 [4.79–5.96] | 2/2 | 4/8 |
| replica/points | 675×900 / 39238 | 675×900 / 39238 | 766 | 7103 [7103–7103] | 0 [0–0] | 178 [156–200] | 0.799 [0.788–0.810] | 35.2 [34.0–36.3] | 5.44 [4.83–6.05] | 4.43 [3.75–5.10] | 5.49 [4.87–6.10] | 2/2 | 3/8 |
| retention/points | 1820×769 / 34334 | 1820×769 / 34334 | 1710 | 8047 [8046–8048] | 4352 [4352–4352] | 209 [201–216] | 0.517 [0.514–0.521] | 55.2 [48.1–62.3] | 5.64 [5.59–5.70] | 4.73 [4.62–4.85] | 5.71 [5.65–5.76] | 2/2 | 2/8 |
| release/near-points | 1434×929 / 40966 | 1434×929 / 40966 | 1620 | 7957 [7957–7957] | 2176 [0–4352] | 170 [150–190] | 0.685 [0.499–0.871] | 69.8 [61.3–78.3] | 5.08 [4.72–5.44] | 4.18 [3.86–4.51] | 5.16 [4.80–5.53] | 2/2 | 4/8 |
| replica/full | 1351×1801 / 89510 | 1351×1801 / 89510 | 2942 | 9277 [9277–9277] | 2176 [0–4352] | 210 [191–229] | 0.837 [0.632–1.042] | 81.5 [74.8–88.3] | 6.16 [5.57–6.75] | 4.96 [4.63–5.30] | 6.26 [5.68–6.84] | 2/2 | 4/8 |
| retention/full | 1900×803 / 37570 | 1900×803 / 37570 | 1872 | 8209 [8208–8209] | 0 [0–0] | 187 [157–216] | 0.914 [0.899–0.929] | 54.0 [53.7–54.3] | 5.46 [5.16–5.75] | 4.57 [4.27–4.86] | 5.53 [5.24–5.82] | 2/2 | 3/8 |
| release/large | 1920×1244 / 62058 | 1920×1244 / 62058 | 2808 | 9145 [9144–9145] | 2176 [0–4352] | 159 [151–167] | 0.798 [0.598–0.998] | 91.2 [81.9–100.6] | 5.38 [4.90–5.86] | 4.37 [3.97–4.77] | 5.48 [4.99–5.97] | 2/2 | 4/8 |
| release/full | 2880×1866 / 101438 | 2880×1866 / 101438 | 6372 | 12709 [12708–12709] | 2176 [0–4352] | 157 [155–159] | 1.154 [0.959–1.348] | 133.6 [132.3–135.0] | 5.18 [5.10–5.27] | 4.28 [4.26–4.29] | 5.33 [5.24–5.41] | 2/2 | 4/8 |

Total equivalent standard API cost for 22 turns: $0.01567.
