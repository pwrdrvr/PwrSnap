# Agent rules: Attaching PR screenshots with gh

This file holds rules that used to live in the root
[AGENTS.md](../../AGENTS.md), moved here verbatim so the root file stays
under Codex's 32 KiB project-doc cap. The root keeps a one-line summary of
each rule below and says when to read this file. The rules here bind
exactly as they did there. A reference to a section that is not in this file
("see Workflow above", a heading quoted in a code comment) means the root
AGENTS.md or one of the other files in `docs/agents/`.

## Pull Requests — attaching images and videos

- GitHub CLI 2.99+ (`gh` v2.99.0) can attach images and videos with the repeatable `--attach` flag on `gh pr create`, `gh pr edit`, and `gh pr comment`.
  - Reference the local path in the Markdown body so `gh` rewrites it to the uploaded URL in place. Unreferenced attachments are appended at the end.
  - Example:

    ```bash
    gh pr create \
      --title "fix(desktop): tighten composer padding" \
      --body-file /tmp/pr-body.md \
      --attach ./before.png \
      --attach ./after.png
    ```

    With this body:

    ```markdown
    ## Before
    ![composer before](./before.png)

    ## After
    ![composer after](./after.png)
    ```

  - Alt text can also follow the path after `#`, as in `--attach './after.png#composer after'`. Update `gh` to v2.99.0 or later before using `--attach`.
  - `gh` rewrites a link only when its target equals an `--attach` path byte-for-byte. The `#alt` suffix is not compared. On a mismatch, `gh` appends the upload at the end instead.
  - The rewrite exists only in the uploaded body. The local body file keeps the local paths.
  - For every later body edit, run `gh pr view <n> --json body -q .body > <file>` and edit that copy. Never re-send the original draft. It replaces the live `user-attachments` URLs with dead local paths.
  - To add an image later, pass `--attach` for the new file only. Existing `user-attachments` URLs match no `--attach` path, so `gh` leaves them alone.
  - `gh` exits 0 in each of these cases. Verify that every body image link is a `user-attachments` URL, and that each asset fetches with HTTP 200 and the local file's byte count.
