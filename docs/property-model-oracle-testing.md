# Property, model and oracle tests

Most PwrSnap tests are **example tests**: pick one input, write down the
output you expect. They check only the cases someone thought of, and they
check what the author *believed*. Twice in this repo's history, the expected
output was itself the bug, and the tests kept it in place:

- **#604.** Six `expect(selected.betaLatest).toBeUndefined()`-style
  assertions said a Beta follower should see no update once their beta was
  promoted to Stable. The app then told those users "You're up to date",
  across 17 tagged releases. This is the same bug, in the same
  `selectChannelReleases` function, that PwrGit fixed in its #280.
- **#715.** A test named *"a finished snap does not wait, and an empty dock
  goes away"* asserted that a capture whose AI run finished quickly gets
  dismissed with no dock tab. That is the behavior #715 fixed: a fast answer,
  or a fast failure, left the user nothing on the screen edge. The test
  shipped with the dock itself (#660) and pinned it for 8 days.

The three ideas below let the computer choose the inputs. They run on
[fast-check](https://fast-check.dev/) inside the repo's vitest workspace.
fast-check is not a dependency yet: the first PR that adds a test adds it
(see the last section).

## The three words

**Property.** A rule that must hold for *every* input, written as code.
fast-check generates hundreds of inputs. When one breaks the rule, it
*shrinks* that input to the smallest one that still fails, and prints it with
a seed so you can replay it.

> *"Normalizing a video edit never drops kept footage."* Against the pre-#662
> code, this shrank to exactly 201 kept spans: `normalizeVideoSegments`
> silently cut everything after span 200. Nobody told the test about the
> 200-span cap.

**Model.** For code with state or concurrency, a small stand-in that is
obviously correct. The test generates random sequences of commands
(`fc.commands`) or random orderings of async work (`fc.scheduler`). It runs
each one on the real code and on the model, and checks that they agree after
every step.

> The undo model draws, deletes and multi-deletes layers, lets time pass,
> then presses ⌘Z. Its fake bus refuses a duplicate or missing layer id, as
> SQLite's `layers.id` constraint does. Rule: every ⌘Z lands on a document the
> user actually saw. Against the pre-#532 hook, it shrank to *open a delete
> bracket, an async create lands inside it, tagged delete*. The delete was
> silently dropped, and the deleted layers could not be brought back.

**Oracle.** Whatever tells the test what the right answer is. It can be:

- **A real tool.** The settings JSON file on disk, a real SQLite database
  (better-sqlite3 loads in plain Node), real FFmpeg via `resolveFfmpegPath()`,
  sharp for pixels.
- **A slow, obviously correct version** of the function, such as a plain
  interval union for video spans.
- **A second code path** that must give the same answer. Comparing two paths
  is called a *differential* test. The editor's preview and the bake
  (`compose-tree.ts`) are such a pair.

> *"An export never contains footage the request excluded."* The oracle is a
> plain union of the requested spans. Against the pre-#662 code, this shrank
> to a 1-second recording and one zero-length span. The old code then exported
> the whole recording.

The three work together. A property needs an oracle to say what "correct"
means, and a model test checks the real code against its model.

## What the history showed

Each test below ran against the code from just before the fix, extracted with
`git show <fix>^:<path>` beside the current module. Each was run five times
with fresh seeds. Current `main` passed every one (100–300 runs each), except
the last row.

| Fix | Bug | Test | Found in |
| --- | --- | --- | --- |
| #604 | Beta followers stuck on "up to date" after a promotion. Six assertions asserted it; 17 tagged releases shipped it. | Property: no update track offers less than Stable Latest | Runs 1–3; shrunk to a feed with one release, `v1.0.0` |
| #667 | Running an older build deleted newer settings, including Direct API connections. | Property: an unrelated write keeps every field it doesn't recognize. Oracle: the JSON file | Run 1; shrunk to one unknown top-level key holding `{}` |
| #662 | An explicit export whose spans all normalized away exported the whole recording. | Property: export ⊆ requested spans. Oracle: interval union | Runs 1–4; shrunk to one zero-length span |
| #662 | An edit with more than 200 kept spans silently dropped the rest. | Property: normalizing keeps total kept duration | Runs 1–4; shrunk to exactly 201 spans |
| #532 | Undo coalescing dropped a delete; the layers were unrecoverable. | Model: random edit sessions, strict fake bus | Runs 24–54 (89–227 ms); shrunk to `begin, create, delete` |
| open #794 | On `main` today: a double-tapped ⌘Z replays one entry twice. | Same model, plus double-taps from one render | Runs 1–3 (10–26 ms); shrunk to `create; ⌘Z ⌘Z` |

The last row is not a historical fix: the model found it on current `main`.
PR #794's version of `useUndoRedo.ts` (head `60a37585`) passed 3,000 runs of
the same model.

The history has longer fix tails that no generated test has been run against
yet. These are **sketches**, not results:

- **Auto-updater:** 11 shipped fixes (#296 through #767). A held-update
  `fc.commands` model would cover them: commands for check, feed publishes,
  download completes or fails, channel switch, restart. Rules: every check
  settles, and at most one install owner exists. `selectChannelReleases` and
  the held-update flow are shared across the Pwr family. PwrGit is committing
  `selectChannelReleases` properties and a held-update model now. Port them
  rather than writing a second set.
- **Stale async completions:** a late result overwrites newer work (#589,
  #780, #785, #789; open #781, #783, #787, #788). Use one `fc.scheduler`
  oracle: the final state equals some serial order of the requests issued.
- **Lost one-shot events:** #653, #654 and #723, within 10 days. Rule: for any
  ordering of send, load events and subscriber mount, the subscriber gets the
  latest intent exactly once.
- **Editor preview vs export:** seven fixes (#142, #148, #201, #249, #253,
  #271, #520). Use a differential test: render random layer trees through both
  paths and diff the pixels within a tolerance.
- **Quit:** `electron-quit-model.ts` is already a model, checked against real
  Electron by `probe:quit-reentry`. Generating quit sequences from it, instead
  of hand-picking cases, is the missing step (#677, #792).

## When to write one

- **Fixing a bug.** Write the rule the bug broke as a property or model
  invariant, and confirm it fails on the pre-fix code before you fix it. Also
  keep the shrunk counterexample as a plain example test, so the regression
  has a name.
- **Pure logic with rules:** release-slot selection, video span math, export
  presets, annotation sizing, popover sizing, crop and coordinate transforms,
  hotkey parsing, settings parsing. Write a property.
- **State and concurrency:** undo/redo, the updater, quit, recording start
  and stop, the region selector, float-over state, chat turns, cache
  writers and deleters. Write a model (`fc.commands`, `fc.scheduler`).
- **Anything that reads or writes persisted state:** `settings.json`,
  `pwrsnap-secrets.bin`, SQLite migrations, `.pwrsnap` bundles. The file or
  database is the oracle. Generate the shapes real installs produce: fields
  from a newer build, a migration run twice, a bundle repacked after a crop.
- **Two places answer the same question,** such as the editor preview and the
  bake, or `video:export` and the clipboard copy resolving the same spans.
  Write a differential test that they agree.
- **Before an `expect` pins a refusal, an empty result or an order,** say the
  rule in words. If the rule and the output disagree, the output is the bug.

## How to write them

- **Name the file `__tests__/<module>.property.test.ts`** (or
  `.model.test.ts`), beside the module. The vitest workspace only collects
  tests under `__tests__/` in `packages/shared/src/` and
  `apps/desktop/src/main/`. The renderer project also collects
  `*.test.{ts,tsx}` anywhere under `apps/desktop/src/renderer/src/`.
- **Make fakes as strict as the real thing.** A stub that accepts every
  operation hides exactly the bugs a model exists to find. The undo model
  only finds #532 and #794 because its fake bus refuses a duplicate or
  missing id. The eraser bug in #685 passed its jsdom test because the
  dispatch stub accepted ids the bundle schema rejects. Validate fake writes
  against the real schema (`BundleLayerNode`).
- **Renderer models go through `act`.** The act-warning guard fails a renderer
  test on any warning, so await each command inside `act(async () => …)`. Give
  each run a fresh root, and unmount it when the run ends. To model a
  double-press before React re-renders, call the same API object twice inside
  one `act`.
- **Build inputs the way users do.** Generate a list of operations (draw,
  delete, crop, ⌘Z, trim, publish a release) and replay it, not random
  structs. Don't generate states the app can't produce: a suffixed tag stays
  a GitHub Pre-release, and only a final tag is promoted to Latest, for
  example. Impossible states give false failures.
- **Take the property from a promise:** the code's comment, AGENTS.md, the
  design, or what the user wants. Never take it from today's output.
- **Narrow, don't weaken.** A counterexample may be a case the code handles
  on purpose. If so, restrict the generator or add `fc.pre(...)`, with a
  comment saying why. Don't loosen the assertion until it passes.
- **Budget the runs.** Unit tests run on `ubuntu-latest` and `windows-latest`
  in CI, under vitest's default 5 s per-test timeout.
  - Pure properties: the default `numRuns` (100), in well under a second.
  - jsdom models: about 3 ms per run, so about 300 runs per test.
  - Real file system or SQLite: temp dirs from `mkdtempSync(tmpdir())`, about
    100 runs.
  - Real FFmpeg: a handful of runs, an explicit timeout, and
    `describe.skipIf(resolveFfmpegPath() === null)`, as the existing FFmpeg
    tests do.
- **Don't pin a seed in committed tests.** On failure, fast-check prints
  `seed` and `path`. Replay with `fc.assert(prop, { seed, path })`.
- **A property failure on an unrelated PR is a real bug.** Reproduce it from
  the printed seed and fix it or file it. Never re-run CI to get green.
- **Use the scheduler for time and ordering,** not real sleeps or timers.
  Where code reads `performance.now()`, mock it and advance it as a command.
- **fast-check goes in the root `package.json` devDependencies,** beside
  vitest. It is MIT, which is on the always-allowed list. As a devDependency,
  it stays out of `THIRD_PARTY_LICENSES`. Run `pnpm lint` anyway, since it
  includes `licenses:check`. The 7-day `minimumReleaseAge` cooldown in
  `pnpm-workspace.yaml` applies. 4.10.2 was published 2026-09-19, so it
  clears it.
