import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fixtures } from "./fixtures.ts";

const [path, mode] = process.argv.slice(2);
if (!path || (mode !== undefined && mode !== "--blind")) {
  throw new Error("Usage: node report.mjs RESULTS.jsonl [--blind]");
}
const rows = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const fixtureById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
const blindId = (row) => createHash("sha256").update(JSON.stringify([row.fixture, row.arm, row.round]))
  .digest("hex").slice(0, 10);

if (mode === "--blind") {
  for (const row of rows.toSorted((a, b) => blindId(a).localeCompare(blindId(b)))) {
    const { panel, surface, status, facts } = fixtureById.get(row.fixture);
    console.log(JSON.stringify({ id: blindId(row), panel, surface, status, facts, caption: row.caption }));
  }
  process.exit(0);
}

function stats(values, digits = 0) {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return `${median.toFixed(digits)} [${sorted[0].toFixed(digits)}–${sorted.at(-1).toFixed(digits)}]`;
}

const normalize = (text) => ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
function includesFact({ caption }, fact) {
  return [caption.title, caption.description, caption.ocrText, ...(caption.textAnchors ?? [])]
    .some((text) => normalize(text ?? "").includes(normalize(fact)));
}

const patchCount = ({ width, height }) => Math.ceil(width / 32) * Math.ceil(height / 32);
const apiDollars = ({ transport: { providerUsage } }) => {
  const { input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens } = providerUsage;
  return ((input_tokens - cached_input_tokens - cache_write_input_tokens) * 0.10 +
    cached_input_tokens * 0.01 + cache_write_input_tokens * 0.125 + output_tokens * 0.50) / 1_000_000;
};
const groups = Map.groupBy(rows, ({ fixture, arm }) => `${fixture}/${arm}`);
const headers = [
  "Fixture / arm", "Prepared px / B", "Upstream px / B", "Patches × 1.2", "Input", "Cached",
  "Output", "Est. USD × 1,000", "Prep ms", "Model s", "Upstream s", "Wall s", "Exact status", "Exact facts"
];
const tableRow = (cells) => `| ${cells.join(" | ")} |`;
console.log(tableRow(headers));
console.log(tableRow(headers.map((_, index) => index < 3 ? "---" : "---:")));
for (const [group, samples] of groups) {
  const [{ fixture, prepared, transport }] = samples;
  const { status, facts } = fixtureById.get(fixture);
  const statusHits = samples.filter((row) => includesFact(row, status)).length;
  const factHits = samples.reduce((sum, row) => sum + facts.filter((fact) => includesFact(row, fact)).length, 0);
  const patches = patchCount(transport);
  const seconds = (metric) => stats(samples.map((row) => metric(row) / 1000), 2);
  console.log(tableRow([
    group,
    `${prepared.width}×${prepared.height} / ${prepared.bytes}`,
    `${transport.width}×${transport.height} / ${transport.decodedBytes}`,
    Math.ceil(patches * 1.2),
    stats(samples.map((row) => row.tokens.inputTokens)),
    stats(samples.map((row) => row.tokens.cachedInputTokens)),
    stats(samples.map((row) => row.tokens.outputTokens)),
    stats(samples.map((row) => apiDollars(row) * 1000), 3),
    stats(samples.map((row) => row.prepMs), 1),
    seconds((row) => row.modelMs),
    seconds((row) => row.transport.upstreamMs),
    seconds((row) => row.wallMs),
    `${statusHits}/${samples.length}`,
    `${factHits}/${samples.length * facts.length}`
  ]));
}
console.log(`\nTotal equivalent standard API cost for ${rows.length} turns: $${rows.reduce((total, row) => total + apiDollars(row), 0).toFixed(5)}.`);
