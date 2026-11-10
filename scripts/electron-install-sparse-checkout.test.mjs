import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = "apps/desktop/scripts/ensure-electron-runtime.mjs";
const read = (file) => readFileSync(join(root, file), "utf8");

function localImports(source) {
  const { program, errors } = parseSync("module.mjs", source);
  expect(errors).toEqual([]);
  const imports = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(node.type)) {
      if (typeof node.source?.value === "string" && node.source.value.startsWith(".")) imports.add(node.source.value);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(program);
  return [...imports];
}

// Discover dependencies, not a second hand-maintained helper-name list.
function importClosure(file, files = new Map()) {
  if (files.has(file)) return files;
  const source = read(file);
  files.set(file, source);
  for (const specifier of localImports(source)) importClosure(posix.join(posix.dirname(file), specifier), files);
  return files;
}

const files = importClosure(entry);
const workflows = readdirSync(join(root, ".github/workflows")).filter((name) => /\.ya?ml$/.test(name));
const checkouts = workflows.flatMap((name) => {
  const workflow = `.github/workflows/${name}`;
  const source = read(workflow);
  const jobs = [...source.matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|$(?![\s\S]))/gm)];
  return jobs.filter((job) => /uses: pwrdrvr\/configure-nodejs@/.test(job[2])).flatMap((job) => {
    const lines = job[2].split("\n");
    return lines.flatMap((line, index) => {
      if (!/uses: actions\/checkout@/.test(line)) return [];
      const indent = line.search(/\S/) - (line.trimStart().startsWith("- ") ? 0 : 2);
      let end = index + 1;
      while (end < lines.length && (!lines[end].trim() || lines[end].search(/\S/) > indent)) end++;
      const block = lines.slice(index, end).join("\n");
      const sparse = block.match(/^(\s*)sparse-checkout: \|\n((?:\1  .+\n?)+)/m);
      // A new sparse representation must not silently look like a full checkout.
      if (/sparse-checkout:/.test(block)) expect(sparse, `${workflow}:${job[1]}: unsupported sparse syntax`).not.toBeNull();
      if (sparse) expect(block, "Extend the oracle for cone-mode patterns before using them").toMatch(/sparse-checkout-cone-mode: ["']?false/);
      return [{ workflow, job: job[1], patterns: sparse ? sparse[2].trim().split("\n").map((value) => value.trim()) : null }];
    });
  });
});

// Same Git oracle as PwrAgent #3580 / 84721056b. Full checkouts remain part
// of the audit, so zero current sparse lists cannot make the test vacuous.
function missingAfterCheckout(patterns) {
  const directory = mkdtempSync(join(tmpdir(), "pwrsnap-sparse-install-"));
  try {
    const git = (args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    git(["init", "--quiet"]);
    for (const [file, source] of files) {
      mkdirSync(dirname(join(directory, file)), { recursive: true });
      writeFileSync(join(directory, file), source);
    }
    git(["add", "--force", "."]);
    const tree = git(["write-tree"]).trim();
    if (patterns) {
      mkdirSync(join(directory, ".git/info"), { recursive: true });
      writeFileSync(join(directory, ".git/info/sparse-checkout"), `${patterns.join("\n")}\n`);
    }
    git(["-c", `core.sparseCheckout=${Boolean(patterns)}`, "-c", "core.sparseCheckoutCone=false", "read-tree", "-mu", tree]);
    return [...files.keys()].filter((file) => !existsSync(join(directory, file)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it("discovers future static, side-effect, re-export and literal dynamic local imports", () => {
  expect(localImports(`import { x } from "./a.mjs"; import "./b.mjs"; export * from "./c.mjs"; const d = import("./d.mjs"); // from "./comment.mjs"`))
    .toEqual(["./a.mjs", "./b.mjs", "./c.mjs", "./d.mjs"]);
});

it("audits all dependency-install workflows, including full checkouts", () => {
  const installWorkflows = workflows.filter((name) => read(`.github/workflows/${name}`).includes("uses: pwrdrvr/configure-nodejs@"));
  expect(installWorkflows.length).toBeGreaterThan(0);
  expect([...new Set(checkouts.map(({ workflow }) => workflow))].sort()).toEqual(installWorkflows.map((name) => `.github/workflows/${name}`).sort());
});

it.each(checkouts)("Git oracle: $workflow / $job retains the installer import closure", ({ patterns }) => {
  expect(missingAfterCheckout(patterns)).toEqual([]);
});

it("Git oracle rejects the donor's former installer-only sparse pattern", () => {
  expect(missingAfterCheckout([entry])).toEqual([...files.keys()].filter((file) => file !== entry));
  expect(missingAfterCheckout([entry]).length).toBeGreaterThan(0);
  expect(missingAfterCheckout([...files.keys()])).toEqual([]);
});

it("completed dependency-cache inputs cover the installer's transitive local imports", () => {
  const inputs = read(".github/workflows/ci.yml").match(/PWRSNAP_DEPENDENCY_CACHE_INPUTS: \|\n((?:    .+\n)+)/)[1]
    .trim().split("\n").map((line) => line.trim());
  for (const file of files.keys()) expect(inputs, `Completed cache key omits ${file}`).toContain(file);
});
