# Authoring Sizzle reels through MCP

The canonical agent workflow is the [PwrSnap Sizzle Reels skill](../.agents/skills/pwrsnap-sizzle-reels/SKILL.md).
Its [timeline reference](../.agents/skills/pwrsnap-sizzle-reels/references/timeline.md)
covers the tool sequence, editable timeline format, narration alignment, music,
rendering and QA.

The desktop advertises the [MCP Skills extension (SEP-2640)](https://skills.extensions.modelcontextprotocol.io/specification/beta/skills)
as `io.modelcontextprotocol/skills`. `skills/list` and `skills/get` return the
skill's complete frontmatter and raw-byte SHA-256/size manifest. All three
files, including agent UI metadata, are individually readable through
`resources/read`; the skill URI is `skill://pwrsnap-sizzle-reels/SKILL.md`.
The official SDK supplies the extension's methods and manifest validation.
Hosts that discover
only tools can call `pwrsnap_sizzle_skill` without arguments, then pass
`path: "references/timeline.md"` for the detailed reference. These reads require
an approved live MCP session, but no media or composition permission. They do
not perform inference, render media or spend capture-read budgets.
Reading Markdown with a generic resource/tool reader does not activate a skill;
the host verifies its manifest and applies its own approval/loading policy.

The files are embedded in the desktop build from the repo skill, so an
installed PwrSnap serves guidance matching its own tool interface without a
checkout or an online documentation fetch. Read the connected desktop's tool
schemas before authoring; reconnect and rediscover after upgrading PwrSnap.
