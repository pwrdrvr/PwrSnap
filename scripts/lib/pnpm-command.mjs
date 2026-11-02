// Reuse the package manager that launched this script. In pnpm 12 this is a
// native executable (including on Windows), so .cmd shims and shell quoting
// are unnecessary. Older JS launchers still need Node.
export function pnpmCommand(args, cli = process.env.npm_execpath) {
  if (!cli) throw new Error("Run this command through the repository's pnpm script");
  return /\.(?:[cm]?js)$/.test(cli)
    ? { command: process.execPath, args: [cli, ...args] }
    : { command: cli, args };
}
