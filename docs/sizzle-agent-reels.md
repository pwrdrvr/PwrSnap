# Authoring Sizzle reels through MCP

The canonical agent workflow is the [PwrSnap Sizzle Reels skill](../.agents/skills/pwrsnap-sizzle-reels/SKILL.md).
Its [timeline reference](../.agents/skills/pwrsnap-sizzle-reels/references/timeline.md)
covers the tool sequence, editable timeline format, narration alignment, music,
rendering and QA.

Connected agents can discover the same bundled files with MCP `resources/list`
and read `pwrsnap://skills/pwrsnap-sizzle-reels/SKILL.md`. Hosts that discover
only tools can call `pwrsnap_sizzle_skill` without arguments, then pass
`path: "references/timeline.md"` for the detailed reference. These reads require
an approved live MCP session, but no media or composition permission. They do
not perform inference, render media or spend capture-read budgets.

The files are embedded in the desktop build from the repo skill, so an
installed PwrSnap serves guidance matching its own tool interface without a
checkout or an online documentation fetch. Read the connected desktop's tool
schemas before authoring; reconnect and rediscover after upgrading PwrSnap.
