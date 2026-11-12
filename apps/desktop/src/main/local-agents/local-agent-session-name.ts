import { randomUUID } from "node:crypto";
import type { LocalAgentClientGrant } from "@pwrsnap/shared";

/** A Session Name no active Session uses: `name`, then `name 2`, `name 3`, ... */
export function uniqueSessionName(
  requestedName: string,
  grants: readonly Pick<LocalAgentClientGrant, "name" | "revokedAt">[]
): string {
  const activeNames = grants
    .filter((grant) => grant.revokedAt === null)
    .map((grant) => grant.name);
  const base = requestedName.trim().slice(0, 200) || "Local Agent";
  if (!activeNames.some((name) => namesMatch(name, base))) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const label = ` ${suffix}`;
    const candidate = `${base.slice(0, 200 - label.length)}${label}`;
    if (!activeNames.some((name) => namesMatch(name, candidate))) return candidate;
  }
  return `Local Agent ${randomUUID()}`.slice(0, 200);
}

function namesMatch(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}
