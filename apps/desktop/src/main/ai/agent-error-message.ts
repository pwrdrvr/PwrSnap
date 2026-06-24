const MAX_ERROR_MESSAGE_LENGTH = 2_000;

function cleanMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function readStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function extractMessage(value: unknown, seen: Set<unknown>): string | null {
  if (typeof value === "string") return cleanMessage(value);
  if (value instanceof Error) return cleanMessage(value.message);
  if (typeof value !== "object" || value === null) return null;
  if (seen.has(value)) return null;
  seen.add(value);

  const record = value as Record<string, unknown>;
  for (const key of ["message", "reasonMessage", "error", "detail", "stderr"]) {
    const direct = readStringField(record, key);
    if (direct !== null) return cleanMessage(direct);
  }

  for (const key of ["error", "cause", "data", "response", "body"]) {
    const nested = extractMessage(record[key], seen);
    if (nested !== null) return nested;
  }

  const ineligibleTiers = record.ineligibleTiers;
  if (Array.isArray(ineligibleTiers)) {
    for (const tier of ineligibleTiers) {
      const nested = extractMessage(tier, seen);
      if (nested !== null) return nested;
    }
  }

  return null;
}

export function agentErrorMessage(error: unknown, fallback = "Agent request failed"): string {
  return extractMessage(error, new Set()) ?? fallback;
}
