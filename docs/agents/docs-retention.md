# Agent rules: Docs retention policy

This file holds rules that used to live in the root
[AGENTS.md](../../AGENTS.md), moved here verbatim so the root file stays
under Codex's 32 KiB project-doc cap. The root keeps a one-line summary of
each rule below and says when to read this file. The rules here bind
exactly as they did there. A reference to a section that is not in this file
("see Workflow above", a heading quoted in a code comment) means the root
AGENTS.md or one of the other files in `docs/agents/`.

## Workflow — docs retention policy

- **Retention policy for docs (replaces the former blanket "never delete"
  rule).** The old rule read: *"Do not delete or 'clean up' files in
  `docs/brainstorms/`, `docs/plans/`, or `docs/solutions/`."* It was written
  to stop drive-by tidying of decision artifacts, and it worked — but it also
  preserved ~40 phase plans and requirements docs long past the point where
  they described the product. They accumulated `status: active` front matter
  and unchecked task lists over features that had shipped months earlier, and
  agents reading them were reliably misled. The policy now:
  - **`docs/solutions/` is still never deleted.** Post-incident notes stay
    true whether or not the code moved on; they record how a class of bug
    was found. Same for the top-level shipped-behavior docs in `docs/`.
  - **`docs/architecture.md` is amended, not archived.** When a decision in
    it stops holding, fix it in the PR that changed it.
  - **Plan-shaped documents are deleted once the work lands.** A plan's value
    expires when the code exists — the code, its comments, and AGENTS.md are
    truer sources. Keep one only if it is the sole written statement of a
    still-live contract — and then move it out of plan-shaped naming into
    `docs/`, and say at the top of the file what it is and why it survived.
    `docs/architecture-bundle-format.md` and `docs/windows/port-status.md`
    are the two that qualified.
  - Git history retains everything. "It might be useful someday" is not a
    reason to keep a document that is currently wrong.
