import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { finished } from "node:stream/promises";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");

export function windowsE2EEnvironment(baseEnvironment = process.env) {
  return {
    ...baseEnvironment,
    CI: "1",
    // Windows PowerShell 5.1 preserves ANSI escape sequences in redirected
    // output. Keep logs plain without changing Playwright's reporter globally.
    FORCE_COLOR: "0"
  };
}

export function windowsE2ECommand(
  platform = process.platform,
  environment = process.env
) {
  if (platform === "win32") {
    return {
      command: environment.ComSpec || "cmd.exe",
      arguments: ["/d", "/s", "/c", "pnpm.cmd run test:desktop-e2e"]
    };
  }

  return {
    command: "pnpm",
    arguments: ["run", "test:desktop-e2e"]
  };
}

export async function runUtf8Tee({
  command,
  arguments: commandArguments,
  cwd,
  environment,
  logPath,
  stdout = process.stdout,
  stderr = process.stderr
}) {
  let logStream;
  if (logPath) {
    const absoluteLogPath = resolve(cwd, logPath);
    await mkdir(dirname(absoluteLogPath), { recursive: true });
    logStream = createWriteStream(absoluteLogPath, {
      encoding: "utf8",
      flags: "w"
    });
  }

  const child = spawn(command, commandArguments, {
    cwd,
    env: environment,
    stdio: ["inherit", "pipe", "pipe"],
    windowsHide: false
  });

  const tee = (source, destination) => {
    source.setEncoding("utf8");
    source.on("data", (text) => {
      destination.write(text);
      logStream?.write(text);
    });
  };

  tee(child.stdout, stdout);
  tee(child.stderr, stderr);

  let result;
  try {
    result = await new Promise((resolveResult, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        resolveResult({ code, signal });
      });
    });
  } finally {
    if (logStream) {
      logStream.end();
      await finished(logStream);
    }
  }

  if (result.signal) {
    stderr.write(`Windows E2E command terminated by ${result.signal}.\n`);
    return 1;
  }
  return result.code ?? 1;
}

function parseArguments(argv) {
  let logPath;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--log" && argv[index + 1]) {
      logPath = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown Windows E2E launcher argument: ${argument}`);
  }
  return { logPath };
}

export async function main(argv = process.argv.slice(2)) {
  const { logPath } = parseArguments(argv);
  const environment = windowsE2EEnvironment();
  const { command, arguments: commandArguments } = windowsE2ECommand(
    process.platform,
    environment
  );
  return runUtf8Tee({
    command,
    arguments: commandArguments,
    cwd: repositoryRoot,
    environment,
    logPath
  });
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  process.exitCode = await main();
}
