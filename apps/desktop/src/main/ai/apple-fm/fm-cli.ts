// The one place PwrSnap runs Apple's Foundation Models command-line tool.
//
// Every invocation is a fixed, app-built argv to a fixed absolute path. This
// is the transport-level half of the enrichment safety contract for the
// on-device model (AGENTS.md §"Apple's on-device model runs through a fixed
// fm command line"):
//
//   - The binary is `/usr/bin/fm`, never a PATH lookup. /usr/bin is on the
//     sealed system volume; a `fm` planted earlier on PATH is never run.
//   - `--model system` is always explicit. The tool has a user-level default
//     model provider (`~/.fm/config.json`) that can point at a network
//     endpoint, and `pcc` is Apple's cloud model; neither is ever selected.
//   - `--tool`, `--model-provider`, `--model-provider-header`, `--resume` and
//     `--save-transcript` are never passed. The model therefore has no tool,
//     no second destination, and no transcript carried between captures.
//   - No shell. Arguments are an array; the prompt that carries capture
//     metadata travels on stdin, not in argv.
//   - The child gets a minimal environment and the scratch jail as its cwd.
//   - Output and run time are bounded; an abort or a timeout kills the child.
//
// `assertAppleFmArgs` enforces the argv rules at the spawn site, so a caller
// added later cannot pass a forbidden flag by accident.

import { spawn } from "node:child_process";

export const APPLE_FM_BINARY = "/usr/bin/fm";

/** Largest stdout + stderr PwrSnap will read from one run. A caption is a
 *  few hundred bytes; this is a runaway bound, not a budget. */
export const APPLE_FM_MAX_OUTPUT_BYTES = 256 * 1024;

/** First arguments PwrSnap may pass. Anything else is refused. */
const ALLOWED_COMMANDS: ReadonlySet<string> = new Set(["respond", "models", "license", "config"]);

/** Flags that would give the model a tool, a different destination, or
 *  state that outlives the run. Never passed, for any command. */
export const APPLE_FM_FORBIDDEN_FLAGS: readonly string[] = [
  "--tool",
  "--model-provider",
  "--model-provider-header",
  "--resume",
  "--save-transcript",
  "--guardrails",
  "--host",
  "--port",
  "--socket"
];

export class AppleFmArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppleFmArgsError";
  }
}

/** Refuse an argv that breaks the transport rules. Throws; never repairs. */
export function assertAppleFmArgs(args: readonly string[]): void {
  const command = args[0];
  if (command === undefined || !ALLOWED_COMMANDS.has(command)) {
    throw new AppleFmArgsError(`fm command ${JSON.stringify(command)} is not one PwrSnap runs`);
  }
  for (const arg of args) {
    if (APPLE_FM_FORBIDDEN_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`))) {
      throw new AppleFmArgsError(`fm flag ${arg.split("=")[0]} is never passed by PwrSnap`);
    }
  }
  if (command === "license" && (args.length !== 2 || args[1] !== "--status")) {
    // `fm license` alone PROMPTS to agree. PwrSnap only ever reads the status.
    throw new AppleFmArgsError("PwrSnap only reads fm's license status; it never agrees to the terms");
  }
  if (command === "config" && args[1] !== "get") {
    throw new AppleFmArgsError("PwrSnap only reads fm's configuration; it never changes it");
  }
  if (command === "respond") {
    const model = args.indexOf("--model");
    if (model === -1 || args[model + 1] !== "system" || args.lastIndexOf("--model") !== model) {
      throw new AppleFmArgsError("fm respond must name the on-device model exactly once (--model system)");
    }
  }
}

export type FmRunResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

export type FmRunOptions = {
  /** Written to the child's stdin, which is then closed. Omitted → closed
   *  immediately, so the tool can never wait on a terminal. */
  stdin?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  cwd?: string;
};

export type FmRunner = (args: readonly string[], options: FmRunOptions) => Promise<FmRunResult>;

export class AppleFmTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`fm did not finish within ${timeoutMs} ms`);
    this.name = "AppleFmTimeoutError";
  }
}

export class AppleFmOutputLimitError extends Error {
  constructor() {
    super("fm produced more output than PwrSnap reads");
    this.name = "AppleFmOutputLimitError";
  }
}

/** The child's whole environment. Nothing of the app's own env is inherited:
 *  no proxy settings, no API keys an operator exported for something else. */
export function appleFmEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", NO_COLOR: "1", TERM: "dumb" };
  for (const key of ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG"] as const) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  return env;
}

// oxlint-disable-next-line no-control-regex -- Intentionally strips terminal escape sequences.
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** fm colours its errors even under NO_COLOR. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** Run `/usr/bin/fm` once. Resolves with whatever it printed and how it
 *  exited; rejects only for an abort, a timeout, an output overrun, or a
 *  spawn failure. A non-zero exit is an ANSWER, not an error: `fm models`
 *  exits 1 whenever any model (including the cloud one) is unavailable. */
export const runAppleFm: FmRunner = createFmRunner(APPLE_FM_BINARY);

/** The runner behind `runAppleFm`. `binary` is a parameter only so tests can
 *  stand a script in for the tool; production never passes anything else. */
export function createFmRunner(binary: string): FmRunner {
  return createAppleCaptionProcessRunner(binary, assertAppleFmArgs);
}

/** Both local caption transports use the same bounded child-process lifecycle.
 * The caller supplies its own fixed command allowlist. */
export function createAppleCaptionProcessRunner(
  binary: string,
  assertArgs: (args: readonly string[]) => void
): FmRunner {
  return (args, options) => {
    assertArgs(args);
    return new Promise<FmRunResult>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new DOMException("fm run cancelled", "AbortError"));
        return;
      }
      const child = spawn(binary, [...args], {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        env: appleFmEnv(),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
      const out: Buffer[] = [];
      const errOut: Buffer[] = [];
      let bytes = 0;
      let failure: Error | null = null;
      let settled = false;
      let exited = false;

      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        action();
      };
      // A stopped run settles as soon as the process is gone. Waiting for
      // `close` would hang for as long as any descendant kept the pipes
      // open, which is the one situation a stop exists to end.
      const rejectStopped = (reason: Error): void => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(() => reject(reason));
      };
      const stop = (reason: Error): void => {
        if (failure === null) failure = reason;
        // Already exited with its pipes still held open: there is nothing
        // left to kill and no `exit` left to wait for.
        if (exited) {
          rejectStopped(failure);
          return;
        }
        child.kill("SIGKILL");
      };
      const onAbort = (): void => stop(new DOMException("fm run cancelled", "AbortError"));
      const timer = setTimeout(
        () => stop(new AppleFmTimeoutError(options.timeoutMs)),
        options.timeoutMs
      );
      options.signal?.addEventListener("abort", onAbort, { once: true });

      const collect = (sink: Buffer[]) => (chunk: Buffer): void => {
        bytes += chunk.length;
        if (bytes > APPLE_FM_MAX_OUTPUT_BYTES) {
          stop(new AppleFmOutputLimitError());
          return;
        }
        sink.push(chunk);
      };
      child.stdout.on("data", collect(out));
      child.stderr.on("data", collect(errOut));

      child.once("error", (error) => finish(() => reject(failure ?? error)));
      child.once("exit", () => {
        exited = true;
        if (failure !== null) rejectStopped(failure);
      });
      child.once("close", (code, signal) =>
        finish(() => {
          if (failure !== null) {
            reject(failure);
            return;
          }
          resolve({
            code,
            signal,
            stdout: stripAnsi(Buffer.concat(out).toString("utf8")),
            stderr: stripAnsi(Buffer.concat(errOut).toString("utf8"))
          });
        })
      );

      // A closed pipe (the tool exited before reading) must not crash main.
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.stdin ?? "");
    });
  };
}
