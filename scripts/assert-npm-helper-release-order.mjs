let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;

let release;
try {
  release = JSON.parse(input);
} catch {
  console.error("Refusing npm helper publication: GitHub latest-release metadata was not valid JSON.");
  process.exit(1);
}

const tag =
  typeof release === "object" && release !== null && typeof release.tag_name === "string"
    ? release.tag_name
    : "";
const isStable11 =
  /^v1\.1\.\d+$/.test(tag) && release.draft === false && release.prerelease === false;

if (!isStable11) {
  console.error(
    `Refusing npm helper publication while GitHub latest is '${tag || "unknown"}'. ` +
      "A non-draft, non-prerelease v1.1.x release must be GitHub latest first."
  );
  process.exit(1);
}

console.log(`GitHub latest is stable PwrSnap ${tag}; npm helper publication may proceed.`);
