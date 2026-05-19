#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = join(repoRoot, "THIRD_PARTY_LICENSES");
const desktopFilter = "@pwrsnap/desktop";
const supplementalMacArm64Records = [
  {
    name: "@img/sharp-darwin-arm64",
    version: "0.34.5",
    declaredLicense: "Apache-2.0",
    source: "https://github.com/lovell/sharp",
    description: "Prebuilt sharp for use with macOS 64-bit ARM",
  },
  {
    name: "@img/sharp-libvips-darwin-arm64",
    version: "1.2.4",
    declaredLicense: "LGPL-3.0-or-later",
    source: "https://github.com/lovell/sharp-libvips",
    description: "Prebuilt libvips and dependencies for use with sharp on macOS 64-bit ARM",
  },
];

export function runPnpmLicenses(args, options = {}) {
  const result = spawnSync(
    "pnpm",
    ["licenses", "list", "--json", "--filter", desktopFilter, ...args],
    {
      cwd: options.cwd ?? repoRoot,
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    const error = new Error(details || "pnpm licenses list failed");
    error.status = result.status ?? 1;
    throw error;
  }
  try {
    return JSON.parse(result.stdout);
  } catch (cause) {
    const error = new Error(
      `pnpm licenses list returned invalid JSON:\n${result.stdout.slice(0, 2000)}`,
    );
    error.cause = cause;
    throw error;
  }
}

export function flattenLicenseReport(report) {
  const records = [];
  for (const [declaredLicense, entries] of Object.entries(report)) {
    for (const entry of entries) {
      const versions = entry.versions?.length ? entry.versions : [""];
      const paths = entry.paths?.length ? entry.paths : [undefined];
      for (let index = 0; index < versions.length; index += 1) {
        records.push({
          name: entry.name,
          version: versions[index] ?? versions[0] ?? "",
          declaredLicense,
          packagePath: paths[index] ?? paths[0],
          homepage: entry.homepage,
          author: entry.author,
          description: entry.description,
        });
      }
    }
  }
  return records;
}

export function normalizeRepository(repository) {
  const raw =
    typeof repository === "string"
      ? repository
      : repository && typeof repository.url === "string"
        ? repository.url
        : undefined;
  if (!raw) return undefined;
  return raw
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@github\.com\//, "https://github.com/")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "")
    .replace(/#readme$/i, "");
}

export function normalizeSourceUrl(source) {
  return typeof source === "string" ? source.replace(/#readme$/i, "") : source;
}

export function npmPackageUrl(name) {
  return `https://www.npmjs.com/package/${encodeURIComponent(name).replace(
    "%40",
    "@",
  )}`;
}

export function findLicenseFile(packagePath) {
  if (!packagePath || !existsSync(packagePath)) return undefined;
  const candidates = readdirSync(packagePath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^(licen[cs]e|copying|copyright|notice)(?:[.-].*)?$/i.test(name))
    .sort((a, b) => a.localeCompare(b));
  return candidates[0] ? join(packagePath, candidates[0]) : undefined;
}

export function formatAuthor(author) {
  if (!author) return undefined;
  if (typeof author === "string") return author;
  if (typeof author.name === "string") return author.name;
  return undefined;
}

export function stableRecordKey(record) {
  return `${record.name}@${record.version}`;
}

export function declaredLicenseFallbackText(record, packageJson) {
  if (record.declaredLicense === "MIT") {
    const holder = formatAuthor(packageJson?.author) ?? record.name;
    return `The installed package does not include a separate license file. Its package metadata declares MIT.

MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
  }

  return [
    `No license text file was found in the installed package for ${stableRecordKey(
      record,
    )}.`,
    `The package declares license: ${record.declaredLicense}.`,
  ].join("\n");
}

export function normalizeLicenseText(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

export function compareRecords(a, b) {
  return (
    a.name.localeCompare(b.name) ||
    a.version.localeCompare(b.version) ||
    a.declaredLicense.localeCompare(b.declaredLicense)
  );
}

function readPackageJson(packagePath) {
  if (!packagePath) return undefined;
  const packageJsonPath = join(packagePath, "package.json");
  if (!existsSync(packageJsonPath)) return undefined;
  return JSON.parse(readFileSync(packageJsonPath, "utf8"));
}

function enrichRecord(record) {
  const packageJson = readPackageJson(record.packagePath);
  const licensePath = findLicenseFile(record.packagePath);
  const licenseText = licensePath
    ? normalizeLicenseText(readFileSync(licensePath, "utf8"))
    : declaredLicenseFallbackText(record, packageJson);
  return {
    ...record,
    source: normalizeSourceUrl(
      normalizeRepository(packageJson?.repository) ??
      packageJson?.homepage ??
      record.source ??
      record.homepage ??
      npmPackageUrl(record.name),
    ),
    licenseFile: licensePath
      ? relative(record.packagePath, licensePath)
      : "package metadata",
    licenseText,
    licenseTextHash: createHash("sha256").update(licenseText).digest("hex"),
  };
}

export function buildThirdPartyLicenseNotice({
  productionReport,
  allReport,
  supplementalRecords = supplementalMacArm64Records,
  productName = "PwrSnap",
  packageFilter = desktopFilter,
}) {
  const productionRecords = flattenLicenseReport(productionReport);
  const allRecords = flattenLicenseReport(allReport);
  const recordsByKey = new Map();

  for (const record of productionRecords) {
    recordsByKey.set(stableRecordKey(record), record);
  }
  for (const record of allRecords) {
    if (record.name === "electron") {
      recordsByKey.set(stableRecordKey(record), record);
    }
  }
  for (const record of supplementalRecords) {
    recordsByKey.set(stableRecordKey(record), record);
  }

  const records = Array.from(recordsByKey.values()).sort(compareRecords).map(enrichRecord);

  const recordsByLicense = new Map();
  for (const record of records) {
    const group = recordsByLicense.get(record.declaredLicense) ?? [];
    group.push(record);
    recordsByLicense.set(record.declaredLicense, group);
  }

  const textGroups = new Map();
  for (const record of records) {
    const group = textGroups.get(record.licenseTextHash) ?? {
      declaredLicenses: new Set(),
      records: [],
      text: record.licenseText,
      representative: record,
    };
    group.declaredLicenses.add(record.declaredLicense);
    group.records.push(record);
    textGroups.set(record.licenseTextHash, group);
  }

  const lines = [];
  lines.push(`${productName} Third-Party Licenses`);
  lines.push("=".repeat(`${productName} Third-Party Licenses`.length));
  lines.push("");
  lines.push("Generated by scripts/generate-third-party-licenses.mjs.");
  lines.push("Do not edit this file manually; run `pnpm licenses:generate`.");
  lines.push("");
  lines.push("Scope");
  lines.push("-----");
  lines.push("");
  lines.push(
    `This notice covers npm production dependencies for ${packageFilter} plus the Electron runtime package.`,
  );
  lines.push(
    "Electron includes Chromium and Node.js runtime components. PwrSnap includes Electron's MIT runtime license here; Chromium's generated credits are maintained upstream by Chromium/Electron and are intentionally not appended to this text notice because Electron's generated LICENSES.chromium.html is large for the pinned runtime.",
  );
  lines.push(
    "For Chromium runtime credits, see https://source.chromium.org/chromium and Electron's packaged LICENSES.chromium.html in the corresponding Electron release.",
  );
  lines.push(
    "Codex App Server Rust dependency disclosures are maintained by the Codex distribution; PwrSnap invokes a local Codex App Server and does not vendor those Rust crates into this npm notice.",
  );
  lines.push("");
  lines.push("Bundled Asset Notes");
  lines.push("-------------------");
  lines.push("");
  lines.push(
    "The renderer build emits Geist Sans and Geist Mono webfont assets from @fontsource/geist-sans and @fontsource/geist-mono. Those packages are listed below under OFL-1.1, and their SIL Open Font License text is included in the License Texts section.",
  );
  lines.push(
    "Build-time-only assets that are rendered into images, such as the DMG background image, do not distribute the font software itself and are not listed separately here.",
  );
  lines.push(
    "PwrSnap's macOS arm64 release also bundles sharp's native optional runtime packages for macOS: @img/sharp-darwin-arm64 and @img/sharp-libvips-darwin-arm64. They are listed below explicitly so this notice remains deterministic when checked on Linux CI.",
  );
  lines.push("");
  lines.push("Dependency Summary");
  lines.push("------------------");
  lines.push("");

  for (const [declaredLicense, group] of Array.from(recordsByLicense.entries()).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    lines.push(`${declaredLicense}`);
    lines.push("~".repeat(declaredLicense.length));
    for (const record of group.sort(compareRecords)) {
      lines.push(`- ${stableRecordKey(record)} | ${record.source}`);
    }
    lines.push("");
  }

  lines.push("License Texts");
  lines.push("-------------");
  lines.push("");

  const sortedTextGroups = Array.from(textGroups.values()).sort((a, b) => {
    const aFirst = a.records.slice().sort(compareRecords)[0];
    const bFirst = b.records.slice().sort(compareRecords)[0];
    return compareRecords(aFirst, bFirst);
  });

  for (const group of sortedTextGroups) {
    const appliesTo = group.records.slice().sort(compareRecords);
    const licenses = Array.from(group.declaredLicenses).sort().join(", ");
    const heading = `${stableRecordKey(group.representative)} (${licenses})`;
    lines.push(heading);
    lines.push("-".repeat(heading.length));
    lines.push("");
    lines.push("Applies to:");
    for (const record of appliesTo) {
      lines.push(`- ${stableRecordKey(record)} (${record.declaredLicense})`);
    }
    lines.push("");
    lines.push(
      `Representative file: ${stableRecordKey(group.representative)}/${group.representative.licenseFile}`,
    );
    lines.push("");
    lines.push(group.text);
    lines.push("");
  }

  return `${lines.join("\n").replace(/[ \t]+$/gm, "").trimEnd()}\n`;
}

export function generateNotice() {
  return buildThirdPartyLicenseNotice({
    productionReport: runPnpmLicenses(["--prod", "--no-optional"]),
    allReport: runPnpmLicenses(["--no-optional"]),
  });
}

function runCli() {
  const check = process.argv.includes("--check");
  let output;
  try {
    output = generateNotice();
  } catch (error) {
    if (error && typeof error.status === "number") {
      process.stderr.write(error.message);
      process.exit(error.status);
    }
    throw error;
  }

  if (check) {
    const current = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
    if (current !== output) {
      console.error(
        "THIRD_PARTY_LICENSES is out of date. Run `pnpm licenses:generate` and commit the result.",
      );
      process.exit(1);
    }
    console.log("third-party license notice check passed");
    return;
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, output);
  const count = flattenLicenseReport(runPnpmLicenses(["--prod"])).length;
  console.log(`wrote ${relative(repoRoot, outputPath)} (${count} production package records plus Electron)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli();
}
