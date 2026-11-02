// Number and time formatting shared by the AI Providers and AI Features
// pages — secret "last set" stamps, the enrichment budget line, and the
// usage panel's costs and token counts.

export function formatLastSetAt(iso: string | null): string {
  if (iso === null || iso.length === 0) return "—";
  const then = parseTimestampMs(iso);
  if (Number.isNaN(then)) return iso;
  const now = Date.now();
  const deltaMs = Math.max(0, now - then);
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min${min === 1 ? "" : "s"} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} day${day === 1 ? "" : "s"} ago`;
  return new Date(then).toISOString().slice(0, 10);
}

export function formatCostMicros(micros: number | null): string {
  if (micros === null) return "—";
  const dollars = micros / 1_000_000;
  if (dollars > 0 && dollars < 0.001) return "<$0.001";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: dollars > 0 && dollars < 0.1 ? 3 : dollars < 10 ? 2 : 0,
    maximumFractionDigits: dollars > 0 && dollars < 0.1 ? 3 : dollars < 10 ? 2 : 0
  }).format(dollars);
}

export function formatTokenCount(tokens: number | null): string {
  if (tokens === null) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(tokens);
}

export function formatUsageTokenBreakdown(tokens: {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
}): string {
  const inputTokens = tokens.inputTokens ?? 0;
  const cachedInputTokens = tokens.cachedInputTokens ?? 0;
  const outputTokens = tokens.outputTokens ?? 0;
  const reasoningOutputTokens = tokens.reasoningOutputTokens ?? 0;
  const output = reasoningOutputTokens > 0
    ? `${formatTokenCount(outputTokens)} out (${formatTokenCount(reasoningOutputTokens)} reasoning)`
    : `${formatTokenCount(outputTokens)} out`;
  return `${formatTokenCount(uncachedInputTokens(inputTokens, cachedInputTokens))} uncached in · ${formatTokenCount(cachedInputTokens)} cached · ${output}`;
}

export function uncachedInputTokens(inputTokens: number | null, cachedInputTokens: number | null): number {
  return Math.max(0, (inputTokens ?? 0) - (cachedInputTokens ?? 0));
}


export function formatNextTokenAt(iso: string | null): string {
  if (iso === null || iso.length === 0) return "soon";
  const then = parseTimestampMs(iso);
  if (Number.isNaN(then)) return iso;
  const deltaMs = then - Date.now();
  if (deltaMs <= 0) return "now";
  const sec = Math.ceil(deltaMs / 1000);
  if (sec < 60) return `in ${sec}s`;
  const min = Math.ceil(sec / 60);
  if (min < 60) return `in ${min} min${min === 1 ? "" : "s"}`;
  const hr = Math.ceil(min / 60);
  return `in ${hr} hour${hr === 1 ? "" : "s"}`;
}

function parseTimestampMs(value: string): number {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return Date.parse(`${value.replace(" ", "T")}Z`);
  }
  return Date.parse(value);
}
