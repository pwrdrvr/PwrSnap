"""Remove only this job's signing material, including after an interrupted Node process."""

import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys


def cleanup(root):
    runner_temp = Path(os.environ["RUNNER_TEMP"]).resolve()
    if root.is_symlink() or root.parent.resolve() != runner_temp or not root.name.startswith("pwrsnap-signing."):
        raise ValueError("Refusing a signing directory outside this job's temporary root")
    if not root.exists():
        return

    failures = []

    def security(arguments):
        result = subprocess.run(["security", *arguments], capture_output=True, check=False)
        if result.returncode:
            failures.append("macOS keychain cleanup failed")

    try:
        # Snapshot is taken before either architecture's signing process starts.
        # Restore it even when Node never ran its own exit handler.
        original = shlex.split((root / "keychains-before.txt").read_text())
        security(["list-keychains", "-d", "user", "-s", *original])
        for keychain in root.glob("pwrsnap-codesign-*.keychain-db"):
            if keychain.is_symlink():
                failures.append("Refusing a symbolic-link keychain")
            else:
                security(["delete-keychain", str(keychain)])
    finally:
        # Decoded certificates and App Store Connect keys must be removed even
        # if security fails. Never sweep a home directory or another job's keys.
        shutil.rmtree(root)

    if failures:
        raise RuntimeError("; ".join(failures))


if __name__ == "__main__":
    cleanup(Path(sys.argv[1]))
