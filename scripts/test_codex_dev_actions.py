import os
from pathlib import Path
import subprocess
import tempfile
import tomllib
import unittest


ENVIRONMENT = Path(__file__).resolve().parents[1] / ".codex/environments/environment.toml"


@unittest.skipIf(os.name == "nt", "requires a POSIX shell")
class CodexEnvironmentTests(unittest.TestCase):
    def test_setup_runs_with_or_without_an_inherited_prefix(self):
        with ENVIRONMENT.open("rb") as config:
            setup = tomllib.load(config)["setup"]["script"]

        # Model nvm's exit 11 when the parent shell supplies a Git prefix.
        commands = r'''
nvm() {
    [ -z "${PREFIX:-}" ] || return 11
    printf 'nvm %s\n' "$*"
}
corepack() { printf 'corepack %s\n' "$*"; }
pnpm() { printf 'pnpm %s\n' "$*"; }
'''
        for prefix in (None, "", "/opt/PwrAgent/resources/git", "/opt/git with spaces"):
            with self.subTest(prefix=prefix):
                result = subprocess.run(
                    ["/bin/sh", "-ec", commands + setup],
                    env={} if prefix is None else {"PREFIX": prefix},
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(
                    result.stdout.splitlines(),
                    ["nvm install", "corepack enable", "pnpm install"],
                )

    def test_dev_runs_only_after_the_native_build_succeeds(self):
        with ENVIRONMENT.open("rb") as config:
            actions = tomllib.load(config)["actions"]
        dev_commands = {
            action["platform"]: action["command"]
            for action in actions
            if action["name"] == "Dev"
        }

        with tempfile.TemporaryDirectory() as directory:
            pnpm = Path(directory) / "pnpm"
            pnpm.write_text(
                '#!/bin/sh\n'
                'echo "$1"\n'
                'if [ "$1" = build:native ]; then exit "$BUILD_STATUS"; fi\n'
            )
            pnpm.chmod(0o755)

            for platform in ("darwin", "linux"):
                command = "nvm() { :; }; corepack() { :; };\n" + dev_commands[platform]
                for status in range(256):
                    with self.subTest(platform=platform, build_status=status):
                        result = subprocess.run(
                            ["/bin/sh", "-c", command],
                            env={"PATH": directory, "BUILD_STATUS": str(status)},
                            capture_output=True,
                            text=True,
                        )
                        expected = ["build:native"] if status else ["build:native", "dev"]
                        self.assertEqual(result.stdout.splitlines(), expected)
                        self.assertEqual(result.returncode, status)
