---
name: release-download-stats
description: Check and summarize PwrSnap GitHub Release asset download statistics. Use when the user asks for download counts, bytes served, DMG stats, mac updater ZIP traffic, Windows installer traffic, per-release stats such as beta.20/beta.18, or whether GitHub release downloads show any traffic.
---

# Release Download Stats

Use this skill to inspect GitHub Release asset metadata for `pwrdrvr/PwrSnap`.
It reports cumulative GitHub `download_count` values for release assets; it
does not identify users and it does not count update-check polls.

## Workflow

1. Run the bundled script from the repo root:

   ```bash
   python3 .agents/skills/release-download-stats/scripts/release_download_stats.py
   ```

2. For specific releases, pass exact tags or PwrSnap shorthand:

   ```bash
   python3 .agents/skills/release-download-stats/scripts/release_download_stats.py beta.20 beta.18 beta.17
   ```

3. For the latest N releases:

   ```bash
   python3 .agents/skills/release-download-stats/scripts/release_download_stats.py --latest 5
   ```

4. Summarize the results in the response. Prefer:
   - mac updater ZIP downloads separately from DMG downloads.
   - `PwrSnap.dmg` stable alias separately from versioned DMG assets.
   - Total DMG as `stable alias + versioned DMG` only when useful.
   - Windows setup EXE downloads separately from macOS assets.
   - GiB totals for approximate transfer volume.

## Interpretation Rules

- Treat GitHub values as cumulative per asset, not per day.
- State that GitHub does not distinguish manual downloads, bots, CI, or
  auto-updater downloads.
- State that update-check polls against files such as `latest-mac.yml` are not
  represented by these asset counts unless those files are reported as assets.
- When both `PwrSnap.dmg` and a versioned `.dmg` are present, do not collapse
  them unless the user asks for total DMG traffic.
- Use UTC timestamps unless the user asks for a local timezone conversion.

## Common Commands

Print markdown tables:

```bash
python3 .agents/skills/release-download-stats/scripts/release_download_stats.py beta.20 beta.18 beta.17
```

Emit JSON for further processing:

```bash
python3 .agents/skills/release-download-stats/scripts/release_download_stats.py --json --latest 10
```
