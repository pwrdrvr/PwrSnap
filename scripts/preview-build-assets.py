#!/usr/bin/env python3
"""Restore hash-pinned preview dependencies from retained release build artifacts.

Release URLs are identifiers only. Read JSON metadata, then use the shared
artifact acquirer; never fetch published release assets, even on cache misses.
"""

import argparse
import importlib.util
import re
from pathlib import Path

spec = importlib.util.spec_from_file_location("build_artifact", Path(__file__).with_name("build-artifact.py"))
artifact = importlib.util.module_from_spec(spec)
spec.loader.exec_module(artifact)


def acquire(url, sha256, output, read=artifact.api, restore=artifact.acquire):
    match = re.fullmatch(r"https://github\.com/pwrdrvr/PwrSnap/releases/download/(v\d+\.\d+\.\d+)/([^/]+)", url)
    if not match or not re.fullmatch(r"[a-f0-9]{64}", sha256):
        raise ValueError("Expected a hash-pinned PwrSnap stable release asset")
    tag, name = match.groups()
    release = read(f"repos/pwrdrvr/PwrSnap/releases/tags/{tag}")
    if release.get("tag_name") != tag or release.get("draft") or release.get("prerelease"):
        raise ValueError("Expected published stable release metadata")
    assets = [row for row in release.get("assets", [])
              if row.get("name") == name and row.get("browser_download_url") == url]
    if len(assets) != 1 or assets[0].get("digest") != f"sha256:{sha256}":
        raise ValueError("Pinned asset SHA-256 disagrees with release metadata")
    size = assets[0].get("size")
    if type(size) is not int or size <= 0:
        raise ValueError("Missing positive release asset size")
    return restore(url, sha256, size, Path(output))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    print(acquire(args.url, args.sha256, args.output))
