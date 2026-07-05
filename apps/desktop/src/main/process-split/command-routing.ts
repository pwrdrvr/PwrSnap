// Command ownership for the two-process split (plan 2026-06-12-001
// §D4). In split mode each command registers in exactly one process;
// the other side's bus forwards it over the process bridge via the
// RemoteCommandForwarder fallback. This table is the single source of
// truth for who owns what — boot wires each role's forwarder as
// "claim everything the OTHER role owns".
//
// Commands absent from the table register in BOTH processes and
// answer locally — the forwarder is never consulted when a local
// handler exists. That covers the app:* trivia verbs AND the entire
// library:* data surface (list/byId/search/delete/tags/...): the
// agent's tray + float-over read and mutate captures too, and a tray
// preview asking library:byId must NOT resurrect the library process.
// Both sides hit the shared WAL database; the captures-changed relay
// keeps the other side's windows fresh.
//
// Known Phase 3 follow-ups, deliberately accepted for now:
//   • capture:prepareDrag / clipboard:copy from the Library grid hop
//     to the agent (render cache is shared, so the work is a cache
//     read; revisit if drag-start latency shows up).
//   • cancellationKeys don't propagate across the bridge yet — a
//     forwarded codex:enrich can't be aborted from the other process.

import type { ProcessRole } from "../process-role";

export type CommandOwner = "agent" | "library";

/** Exact names that override prefix rules. */
const EXACT_OWNERS: Readonly<Record<string, CommandOwner>> = {
  // Window verbs live with the windows they open. Forwarding one of
  // these from the agent is precisely what spawns the library process
  // on demand.
  "settings:open": "library",
  "app:openDocumentWindow": "library",
  "library:focus": "library",
  "library:openInLibrary": "library",
  "library:export": "library",
  // Library-surface-only utility registered alongside its callers.
  "clipboard:copyText": "library"
};

/**
 * Prefix rules, longest match wins (so codex:libraryChat:* routes to
 * the library while the rest of codex:* routes to the agent).
 */
const PREFIX_OWNERS: ReadonlyArray<readonly [string, CommandOwner]> = [
  // Agent: capture surface, recording, system-wide input/output,
  // settings + secrets substrate (§D8), AI enrichment + discovery,
  // permissions (TCC prompts originate with the capture owner),
  // auto-update (the always-resident process).
  ["capture:", "agent"],
  ["recording:", "agent"],
  // video:* (export/presetMetrics/prepareDrag/setDefaultRange) lives
  // in recording-handlers with the recorder that produced the file —
  // the library grid forwards its video chips' work to the agent.
  ["video:", "agent"],
  ["clipboard:", "agent"],
  ["float-over:", "agent"],
  ["settings:", "agent"],
  ["permissions:", "agent"],
  ["acp:", "agent"],
  ["codex:", "agent"],
  ["app:update:", "agent"],
  // Library: everything that renders, edits, or organizes captures in
  // the Library/Settings/Sizzle windows — including the chat surfaces,
  // which are windows-with-state, not background pipelines.
  ["codex:libraryChat:", "library"],
  ["codex:sizzleChat:", "library"],
  ["diagnostics:", "library"],
  ["editor:", "library"],
  ["layers:", "library"],
  ["render:", "library"],
  ["bundle:", "library"],
  ["sizzle:", "library"],
  ["cart:", "library"],
  ["storage:", "library"]
];

/** The role that registers `name` in split mode, or null when the
 *  command registers in both processes (or doesn't exist). */
export function commandOwner(name: string): CommandOwner | null {
  const exact = EXACT_OWNERS[name];
  if (exact !== undefined) return exact;
  let best: { prefix: string; owner: CommandOwner } | null = null;
  for (const [prefix, owner] of PREFIX_OWNERS) {
    if (!name.startsWith(prefix)) continue;
    if (best === null || prefix.length > best.prefix.length) {
      best = { prefix, owner };
    }
  }
  return best?.owner ?? null;
}

/** True when `name` belongs to the peer of `selfRole` — the forwarder
 *  gate each role installs on its bus. Combined mode owns everything
 *  locally and never forwards. */
export function peerOwnsCommand(selfRole: ProcessRole, name: string): boolean {
  if (selfRole === "combined") return false;
  const owner = commandOwner(name);
  return owner !== null && owner !== selfRole;
}
