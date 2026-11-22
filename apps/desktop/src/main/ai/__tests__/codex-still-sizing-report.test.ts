import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const script = fileURLToPath(new URL("./still-sizing/report.mjs", import.meta.url));
const measured = new URL("./still-sizing/balanced-results.jsonl", import.meta.url);

test.each(["resize", "recode"])("isolates usage when a later repeat has an upstream %s", async (change) => {
  const root = await mkdtemp(join(tmpdir(), "pwrsnap-sizing-report-"));
  try {
    const samples = (await readFile(measured, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const transformed = samples.find((row) => row.fixture === "routing" && row.arm === "balanced" && row.round === 2);
    // A digest-only change must also split the report even at identical size.
    transformed.transport.sha256 = "1".repeat(64);
    if (change === "resize") {
      transformed.transport.width = 2048;
      transformed.transport.height = 1152;
      transformed.transport.decodedBytes = 51_000;
    }
    transformed.tokens.inputTokens = 99_999;
    const path = join(root, "transformed.jsonl");
    await writeFile(path, samples.map((row) => JSON.stringify(row)).join("\n"));
    const report = execFileSync(process.execPath, [script, path], { encoding: "utf8" });
    const routingRows = report.split("\n").filter((line) => line.startsWith("| routing/balanced"));
    expect(routingRows).toHaveLength(2);
    expect(routingRows[0]).toContain("2400×1350 / 73852 | 3870 | 10208 [10208–10208]");
    expect(routingRows[1]).toContain(change === "resize" ? "2048×1152 / 51000 | 2765" : "2400×1350 / 73852 | 3870");
    expect(routingRows[1]).toContain("99999 [99999–99999]");
    expect(report).toMatch(/routing\/balanced round 2.*upstream image differs/i);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
