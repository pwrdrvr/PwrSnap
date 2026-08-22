#!/usr/bin/env node
// Schema-check the winget manifests in this directory against the published
// winget JSON schemas for their declared ManifestVersion.
//
// This is the cross-platform pre-check. It is NOT a substitute for
// `winget validate` + `Tools\SandboxTest.ps1`, which need Windows — see
// README.md in this directory.
//
// Usage (from anywhere):  node docs/windows/winget/validate-manifests.mjs

import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const SCHEMA_BASE =
  "https://raw.githubusercontent.com/microsoft/winget-cli/master/schemas/JSON/manifests";

const MANIFESTS = [
  { file: "PwrDrvr.PwrSnap.yaml", schema: "version" },
  { file: "PwrDrvr.PwrSnap.installer.yaml", schema: "installer" },
  { file: "PwrDrvr.PwrSnap.locale.en-US.yaml", schema: "defaultLocale" },
];

/** pnpm's store is not resolvable from the repo root, so find the package
 *  directory by name under node_modules/.pnpm and require it directly. */
function resolveFromPnpmStore(pkg) {
  const require_ = createRequire(import.meta.url);
  try {
    return require_(pkg);
  } catch {
    /* fall through to the store scan */
  }
  const store = join(REPO_ROOT, "node_modules", ".pnpm");
  let entries;
  try {
    entries = readdirSync(store);
  } catch {
    throw new Error(
      `cannot find "${pkg}" — run \`pnpm install\` from the repo root first`,
    );
  }
  const match = entries
    .filter((name) => name.startsWith(`${pkg}@`))
    .sort()
    .pop();
  if (match === undefined) {
    throw new Error(
      `cannot find "${pkg}" — run \`pnpm install\` from the repo root first`,
    );
  }
  return createRequire(join(store, match, "node_modules", pkg, "package.json"))(
    pkg,
  );
}

const yaml = resolveFromPnpmStore("js-yaml");
const Ajv = resolveFromPnpmStore("ajv").default ?? resolveFromPnpmStore("ajv");

/** js-yaml resolves a bare YAML 1.1 timestamp to a Date; winget's parser reads
 *  it as a string, and upstream manifests write it unquoted. Coerce it back so
 *  the schema check reflects winget's behavior rather than js-yaml's. */
function normalizeDates(doc) {
  return JSON.parse(
    JSON.stringify(doc, (key, value) =>
      key === "ReleaseDate" && typeof value === "string"
        ? value.slice(0, 10)
        : value,
    ),
  );
}

const ajv = new Ajv({
  strict: false,
  allErrors: true,
  logger: false,
  formats: { date: true, url: true, uri: true, "uri-reference": true, long: true },
});

let failures = 0;

for (const { file, schema } of MANIFESTS) {
  const doc = normalizeDates(yaml.load(readFileSync(join(HERE, file), "utf8")));
  const version = doc.ManifestVersion;
  if (typeof version !== "string") {
    console.log(`FAIL  ${file}\n      missing ManifestVersion`);
    failures += 1;
    continue;
  }
  const url = `${SCHEMA_BASE}/v${version}/manifest.${schema}.${version}.json`;
  const response = await fetch(url);
  if (!response.ok) {
    console.log(
      `FAIL  ${file}\n      no published schema for ManifestVersion ${version} (${response.status} on ${url})`,
    );
    failures += 1;
    continue;
  }
  const validate = ajv.compile(await response.json());
  if (validate(doc)) {
    console.log(`PASS  ${file}  (schema ${version})`);
    continue;
  }
  failures += 1;
  console.log(`FAIL  ${file}  (schema ${version})`);
  for (const error of validate.errors ?? []) {
    console.log(`      ${error.instancePath || "/"} ${error.message}`);
  }
}

if (failures > 0) {
  console.log(`\n${failures} manifest(s) failed schema validation.`);
  process.exit(1);
}
console.log("\nAll manifests match their declared winget schema version.");
