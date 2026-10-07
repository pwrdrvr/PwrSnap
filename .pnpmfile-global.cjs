// Replace any user-level global hook with a project-owned no-op. pnpm 12
// treats null as unset and resolves an empty workspace path to the root,
// so neither value disables a global pnpmfile from the user config.
"use strict";

module.exports = { hooks: {} };
