// Public reads only. gh obtains GH_TOKEN from the calling step's environment;
// neither credentials nor raw subprocess/API errors enter the report or logs.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isCliEntrypoint } from "../lib/cli-entrypoint.mjs";

const execFileAsync = promisify(execFile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stable = /^v?(\d+)\.(\d+)\.(\d+)$/;

export function compareVersions(a, b) {
  const left = stable.exec(a)?.slice(1).map(Number);
  const right = stable.exec(b)?.slice(1).map(Number);
  if (!left || !right) throw new Error("Expected bare stable SemVer");
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

export async function ghRequest(path) {
  let output;
  try {
    output = (await execFileAsync("gh", ["api", "--include", path], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 45_000,
      env: { ...process.env, GH_DEBUG: "" },
    })).stdout;
  } catch (error) {
    // gh includes the HTTP response on stdout even for non-2xx responses.
    output = error.stdout ?? "";
  }
  const split = /\r?\n\r?\n/.exec(output);
  const status = Number(/^HTTP\/[\d.]+\s+(\d+)/.exec(output)?.[1] ?? 0);
  if (!split || !status) return { status: 0, headers: {}, body: null };
  const headers = Object.fromEntries(output.slice(0, split.index).split(/\r?\n/)
    .slice(1).map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
    }));
  let body;
  try {
    body = JSON.parse(output.slice(split.index + split[0].length));
  } catch {
    return { status: 0, headers: {}, body: null };
  }
  return { status, headers, body };
}

export function makeApi({ request = ghRequest, sleep = pause, now = Date.now } = {}) {
  return async (path, { allow404 = false, search = false } = {}) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { status, headers, body } = await request(path);
      const incomplete = search && status === 200 && body?.incomplete_results !== false;
      if (status === 200 && !incomplete) return body;
      if (status === 404 && allow404) return null;
      const limited = status === 429 || (status === 403 &&
        (headers["retry-after"] || headers["x-ratelimit-remaining"] === "0" ||
          /rate limit|secondary|abuse/i.test(body?.message ?? "")));
      const transient = status === 0 || status >= 500;
      const reason = incomplete ? "incomplete search" : limited ? "throttled" : `HTTP ${status || "unavailable"}`;
      if ((!limited && !incomplete && !transient) || attempt === 2) {
        throw new Error(`Audit blocked: ${reason} at ${path.split("?")[0]}; no absence conclusion`);
      }
      let delay = (limited || incomplete) ? 60_000 * (attempt + 1) : 1_000 * (attempt + 1);
      const retryAfter = Number(headers["retry-after"]);
      const reset = Number(headers["x-ratelimit-reset"]);
      if (Number.isFinite(retryAfter) && retryAfter > 0) delay = Math.max(delay, retryAfter * 1000);
      if (headers["x-ratelimit-remaining"] === "0" && Number.isFinite(reset)) {
        delay = Math.max(delay, reset * 1000 - now());
      }
      if (delay > 120_000) throw new Error(`Audit blocked: retry delay exceeds 120s budget; ${reason}; no absence conclusion`);
      await sleep(delay);
    }
  };
}

export async function searchAll(api, kind, query) {
  const items = [];
  const seen = new Set();
  let total;
  for (let page = 1; page <= 10; page++) {
    const result = await api(`search/${kind}?q=${encodeURIComponent(query)}&per_page=100&page=${page}`, { search: true });
    if (!Number.isInteger(result.total_count) || result.total_count < 0 || !Array.isArray(result.items) || result.total_count > 1000) {
      throw new Error("Audit blocked: malformed or truncated search; narrow the query; no absence conclusion");
    }
    total ??= result.total_count;
    if (result.total_count !== total) throw new Error("Audit blocked: search changed during pagination; rerun; no absence conclusion");
    for (const item of result.items) {
      const key = item.html_url ?? item.id ?? item.path;
      if (key === undefined || seen.has(key)) throw new Error("Audit blocked: duplicate or malformed search page; rerun; no absence conclusion");
      seen.add(key);
    }
    items.push(...result.items);
    if (items.length === total) return items;
    if (!result.items.length || items.length > total) break;
  }
  throw new Error("Audit blocked: incomplete search pagination; no absence conclusion");
}

async function allReleases(api) {
  const releases = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await api(`repos/pwrdrvr/PwrSnap/releases?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error("Audit blocked: malformed releases response");
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
  throw new Error("Audit blocked: release pagination limit reached");
}

const summary = (release) => release && ({
  version: release.tag_name, prerelease: release.prerelease, url: release.html_url,
  assets: (release.assets ?? []).filter((asset) => /\.dmg$|-setup\.exe$|SHA256SUMS$/.test(asset.name))
    .map((asset) => ({ name: asset.name, url: asset.browser_download_url, digest: asset.digest, bytes: asset.size })),
});
const matches = (items) => items.map((item) => ({ path: item.path, title: item.title, url: item.html_url, state: item.state }));
const content = (file) => {
  if (file?.encoding !== "base64" || typeof file.content !== "string") throw new Error("Audit blocked: missing source content");
  return Buffer.from(file.content, "base64").toString("utf8");
};

export async function auditChannels(api = makeApi()) {
  // Prove each search target is a readable public repository before searching.
  for (const repo of ["pwrdrvr/PwrSnap", "microsoft/winget-pkgs", "pwrdrvr/homebrew-tap", "Homebrew/homebrew-cask", "Homebrew/homebrew-core"]) {
    const metadata = await api(`repos/${repo}`);
    if (metadata.private !== false) throw new Error(`Audit blocked: ${repo} is not confirmed public`);
  }
  const latest = await api("repos/pwrdrvr/PwrSnap/releases/latest");
  const promoted = (await allReleases(api)).filter((release) => !release.draft && !release.prerelease && stable.test(release.tag_name))
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name));
  const wingetPath = "manifests/p/PwrDrvr/PwrSnap";
  const versions = await api(`repos/microsoft/winget-pkgs/contents/${wingetPath}?ref=master`, { allow404: true });
  if (versions !== null && !Array.isArray(versions)) throw new Error("Audit blocked: malformed Winget directory");
  const code = await searchAll(api, "code", "PwrSnap repo:microsoft/winget-pkgs");
  const submissions = await searchAll(api, "issues", "PwrSnap repo:microsoft/winget-pkgs is:pr");
  const publishedVersions = (versions ?? []).filter((entry) => entry.type === "dir" && stable.test(entry.name))
    .map((entry) => entry.name).sort((a, b) => compareVersions(b, a));
  if (versions !== null && !publishedVersions.length) throw new Error("Audit blocked: Winget directory contains no recognizable stable versions");
  let installer;
  if (publishedVersions.length) {
    const path = `${wingetPath}/${publishedVersions[0]}/PwrDrvr.PwrSnap.installer.yaml`;
    const text = content(await api(`repos/microsoft/winget-pkgs/contents/${path}?ref=master`));
    installer = {
      source: `https://github.com/microsoft/winget-pkgs/blob/master/${path}`,
      urls: [...text.matchAll(/^\s*InstallerUrl:\s*(\S+)/gm)].map((match) => match[1]),
      sha256: [...text.matchAll(/^\s*InstallerSha256:\s*(\S+)/gm)].map((match) => match[1]),
    };
    if (!installer.urls.length || !installer.sha256.length) throw new Error("Audit blocked: unrecognized Winget installer metadata");
  }
  const caskPath = "repos/pwrdrvr/homebrew-tap/contents/Casks/pwrsnap.rb?ref=main";
  const text = content(await api(caskPath));
  const version = /^\s*version "([^"]+)"/m.exec(text)?.[1];
  const sha256 = /^\s*sha256 "([a-f0-9]{64})"/m.exec(text)?.[1];
  const url = /^\s*url "([^"]+)"/m.exec(text)?.[1]?.replaceAll("#{version}", version);
  if (!version || !stable.test(version) || !sha256 || !url?.startsWith("https://github.com/pwrdrvr/PwrSnap/releases/download/")) {
    throw new Error("Audit blocked: cask layout changed; inspect authoritative source");
  }
  // Search sequentially: code search has a separate low rate limit.
  const officialCasks = await searchAll(api, "code", "PwrSnap repo:Homebrew/homebrew-cask");
  const officialFormulae = await searchAll(api, "code", "PwrSnap repo:Homebrew/homebrew-core");
  const tapSubmissions = await searchAll(api, "issues", "pwrsnap repo:pwrdrvr/homebrew-tap is:pr is:open");
  return {
    status: "complete", checkedAt: new Date().toISOString(),
    github: { latest: summary(latest), highestPromotedStable: summary(promoted[0]) },
    winget: {
      packageId: "PwrDrvr.PwrSnap", repository: "microsoft/winget-pkgs", path: wingetPath,
      status: versions === null ? (code.length ? "identity-needs-review" : "not-published-at-known-path") : "published",
      publishedVersions, installer, identities: matches(code), submissions: matches(submissions),
    },
    homebrew: {
      packageId: "pwrdrvr/tap/pwrsnap", repository: "pwrdrvr/homebrew-tap", version, sha256, url,
      officialCasks: matches(officialCasks), officialFormulae: matches(officialFormulae), submissions: matches(tapSubmissions),
    },
  };
}

if (isCliEntrypoint(import.meta.url)) {
  const output = process.argv[2];
  let report;
  try {
    report = await auditChannels();
  } catch (error) {
    // Errors above contain fixed audit context, never credential values or raw gh output.
    report = { status: "blocked", checkedAt: new Date().toISOString(), error: error.message };
    process.exitCode = 1;
  }
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (output) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, json);
  }
  console.log(json);
}
