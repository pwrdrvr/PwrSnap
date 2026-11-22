import os
from pathlib import Path
import subprocess
import tempfile
import tomllib
import unittest


ENVIRONMENT = Path(__file__).resolve().parents[1] / ".codex/environments/environment.toml"


@unittest.skipIf(os.name == "nt", "requires a POSIX shell")
class CodexDevActionTests(unittest.TestCase):
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
