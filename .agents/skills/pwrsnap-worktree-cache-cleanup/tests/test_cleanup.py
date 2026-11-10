import importlib.util
import hashlib
import json
import os
from pathlib import Path
import plistlib
import random
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
SKILL = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("cleanup", SKILL / "scripts/cleanup_worktree_caches.py")
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)
IDLE = ([], [])


def private(path):
    info = path.stat()
    return {"private_bytes": info.st_blocks * 512, "clone_id": info.st_ino, "sharing_flags": 0}


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), "-c", "user.name=Fixture", "-c",
        "user.email=fixture@example.test", "-c", "commit.gpgsign=false", *args], stderr=subprocess.PIPE)


def runtime(root, suffix=""):
    package = root / f"node_modules/.pnpm/electron@44.10.1{suffix}/node_modules/electron"
    contents = package / "dist/Electron.app/Contents"
    (contents / "MacOS").mkdir(parents=True)
    (package / "package.json").write_text(json.dumps({"name": "electron", "version": "44.10.1"}))
    (package / "dist/version").write_text("44.10.1\n")
    (contents / "Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier": "com.github.Electron"}))
    (contents / "MacOS/Electron").write_bytes(os.urandom(8192))
    return package / "dist"


def cache(root, path="node_modules/.vitest-cache"):
    target = root / path
    target.mkdir(parents=True)
    (target / "entry").write_bytes(os.urandom(8192))
    return target


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pwrsnap-cleanup-test-")
        self.base = Path(self.temp.name).resolve()
        self.project = self.base / "project"
        self.project.mkdir()
        git(self.project, "init", "-b", "main")
        (self.project / "package.json").write_text('{"name":"fixture"}')
        (self.project / "source.txt").write_text("unique source")
        (self.project / ".gitignore").write_text("node_modules/\n.local/\napps/desktop/out/\n")
        git(self.project, "add", ".")
        git(self.project, "commit", "-m", "fixture")
        self.linked = self.base / "linked space \u2603"
        git(self.project, "worktree", "add", "-b", "linked", str(self.linked))

    def tearDown(self):
        self.temp.cleanup()

    def audit(self, metadata=private, snapshot=IDLE, for_sharing=False):
        return cleanup.audit(self.project, snapshot, metadata, for_sharing=for_sharing)

    def clean(self, report, snapshot_fn=lambda: IDLE, metadata=private):
        return cleanup.clean(report, snapshot_fn, metadata)

    def test_tracked_workspace_packages_supply_cache_and_physical_runtime_paths(self):
        app = self.linked / "apps/desktop"
        app.mkdir(parents=True)
        (app / "package.json").write_text('{"name":"@pwrsnap/desktop"}')
        git(self.linked, "add", "apps/desktop/package.json")
        target = cache(self.linked, "apps/desktop/node_modules/.vite/vitest")
        sibling = target.parent / "unique.txt"
        sibling.write_text("preserve sibling")
        original = runtime(self.linked)
        direct = app / "node_modules/electron"
        shutil.move(str(original.parent), direct)
        cache_plan = self.audit()
        self.assertEqual([item["path"] for item in cache_plan["candidates"]], [str(target)])
        sharing_plan = cleanup.audit(self.project, IDLE, private, for_sharing=True)
        self.assertEqual([item["path"] for item in sharing_plan["candidates"]], [str(direct / "dist")])
        self.clean(cache_plan)
        self.assertFalse(target.exists())
        self.assertEqual(sibling.read_text(), "preserve sibling")
        self.assertTrue((direct / "dist").exists())

    def test_clean_preserves_modified_runtime_and_unique_nested_data(self):
        dist = runtime(self.linked)
        unique = dist / "Electron.app/Contents/operator-data"
        unique.write_text("unique")
        cache(self.linked)
        self.clean(self.audit())
        self.assertEqual(unique.read_text(), "unique")
        self.assertTrue(dist.exists())

    @unittest.skipUnless(sys.platform == "darwin", "macOS CLI ownership guard")
    def test_cli_rejects_another_git_project_without_a_report_or_mutation(self):
        target = cache(self.linked)
        report = self.base / "report.json"
        result = subprocess.run([sys.executable, str(SKILL / "scripts/cleanup_worktree_caches.py"),
            "audit", "--project", str(self.project), "--report", str(report)], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("registered Git project", result.stderr)
        self.assertFalse(report.exists())
        self.assertTrue(target.exists())

    def test_cli_fails_closed_outside_macos(self):
        report = self.base / "not-created.json"
        with mock.patch.object(sys, "platform", "linux"), mock.patch.object(sys, "argv", [
                "cleanup", "audit", "--project", str(self.project), "--report", str(report)]), \
                mock.patch.object(cleanup, "process_snapshot", side_effect=AssertionError("Must not inspect")):
            with self.assertRaises(SystemExit) as stopped:
                cleanup.main()
        self.assertEqual(stopped.exception.code, 2)
        self.assertFalse(report.exists())

    @unittest.skipUnless(sys.platform == "darwin" and os.environ.get("PWRSNAP_CLEANUP_TEST_ELECTRON_ZIP"),
                         "Opt-in real cached Electron ZIP, macOS only")
    def test_real_runtime_uses_measured_architecture_and_production_cache_preparation(self):
        archive = Path(os.environ["PWRSNAP_CLEANUP_TEST_ELECTRON_ZIP"]).resolve(strict=True)
        project = SKILL.parents[2]
        discover = """
          const { createRequire } = require('node:module');
          const electron = createRequire(require.resolve('./apps/desktop/node_modules/electron/package.json'));
          console.log(JSON.stringify({ version: electron('./package.json').version,
            checksums: electron('./checksums.json') }));
        """
        pinned = json.loads(subprocess.check_output(["node", "-e", discover], cwd=project))
        version = pinned["version"]
        digest = hashlib.sha256()
        with archive.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        self.assertIn(digest.hexdigest(), [pinned["checksums"].get(
            f"electron-v{version}-darwin-{arch}.zip") for arch in ("arm64", "x64")])
        package = self.linked / f"node_modules/.pnpm/electron@{version}/node_modules/electron"
        downloader = package / "node_modules/@electron/get"
        downloader.mkdir(parents=True)
        (package / "package.json").write_text(json.dumps({"name": "electron", "version": version}))
        (package / "checksums.json").write_text(json.dumps(pinned["checksums"]))
        # Supply only an existing ZIP; the real helper/installer still verify
        # its package-pinned checksum and prepare a fully verified extraction.
        (downloader / "index.js").write_text("exports.downloadArtifact = async () => " + json.dumps(str(archive)) + ";")
        dist = package / "dist"
        dist.mkdir()
        subprocess.run(["unzip", "-qo", str(archive), "-d", str(dist)], check=True)
        (package / "electron.d.ts").write_text("preserve root declarations")
        before = cleanup.content_inventory(dist)
        arch = cleanup.runtime_arch(dist)  # Read the real installed Mach-O.
        original_inode = dist.stat().st_ino
        original_state = cleanup.tree_state(dist)
        self.assertGreater(original_state["private_bytes"], 0)
        home = self.base / "isolated-shared-home"
        with mock.patch.dict(os.environ, {"PWRAGENT_HOME": str(home)}):
            report = cleanup.audit(self.project, IDLE, for_sharing=True)
            result = cleanup.share(report, snapshot_fn=lambda: IDLE)
        self.assertEqual(result["preserved"], [])
        self.assertEqual(len(result["shared"]), 1)
        self.assertEqual(result["shared"][0]["arch"], arch)
        self.assertEqual(result["shared"][0]["version"], version)
        source = Path(result["shared"][0]["cache"])
        self.assertTrue(source.is_relative_to(home / "cache/electron-runtime/v1"))
        cleanup.clone_oracle(source, dist)
        shared_state = cleanup.tree_state(dist)
        self.assertEqual(shared_state["private_bytes"], 0)
        self.assertNotEqual(dist.stat().st_ino, original_inode)
        self.assertEqual(cleanup.content_inventory(dist), before)
        self.assertEqual((package / "electron.d.ts").read_text(), "preserve root declarations")
        self.assertTrue((self.linked / "source.txt").exists())
        self.assertFalse((package / ".pwragent-runtime-lock").exists())
        print(json.dumps({"real_runtime_fixture": {"version": version, "arch": arch,
            "regular_files": shared_state["regular_files"], "before_private_bytes": original_state["private_bytes"],
            "after_private_bytes": shared_state["private_bytes"], "old_witness": original_state["witness"],
            "shared_witness": shared_state["witness"], "cache_witness": cleanup.tree_state(source)["witness"]}}),
            file=sys.stderr)

    def test_git_is_the_discovery_oracle(self):
        extra = self.base / "unregistered-project"
        extra.mkdir()
        cache(extra)
        report = self.audit()
        self.assertEqual({item["path"] for item in report["worktrees"]}, {str(self.project), str(self.linked)})
        self.assertEqual(report["candidates"], [])

    def test_property_only_approved_cache_classes_are_removed(self):
        rng = random.Random(3580)
        for case in range(12):
            root = rng.choice([self.project, self.linked])
            target = cache(root)
            dist = runtime(root, f"-case-{case}")
            unique = root / ".local/unique.txt"
            unique.parent.mkdir(exist_ok=True)
            unique.write_bytes(rng.randbytes(40))
            out = root / "apps/desktop/out/build.js"
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(rng.randbytes(40))
            source_before = (root / "source.txt").read_bytes()
            unique_before, out_before = unique.read_bytes(), out.read_bytes()
            report = self.audit()
            self.assertEqual({item["kind"] for item in report["candidates"]}, {"vitest"})
            result = self.clean(report)
            self.assertEqual(len(result["removed"]), 1)
            self.assertFalse(target.exists())
            self.assertTrue(dist.exists())
            self.assertEqual((root / "source.txt").read_bytes(), source_before)
            self.assertEqual(unique.read_bytes(), unique_before)
            self.assertEqual(out.read_bytes(), out_before)
            self.assertTrue((dist.parent / "package.json").exists())

    def test_partial_clone_is_preserved_even_with_private_bytes(self):
        dist = runtime(self.linked)
        def partial(path):
            return {**private(path), "sharing_flags": cleanup.SHARING_FLAGS}
        report = self.audit(partial, for_sharing=True)
        self.assertEqual(report["candidates"], [])
        self.assertEqual(len(report["preserved"]), 1)
        self.clean(report, metadata=partial)
        self.assertTrue(dist.exists())

    def test_zero_private_bytes_alone_do_not_classify_a_runtime_as_cloned(self):
        runtime(self.linked)
        def snapshot_retained(path):
            return {**private(path), "private_bytes": 0}
        report = cleanup.audit(self.project, IDLE, snapshot_retained, for_sharing=True)
        self.assertEqual(len(report["candidates"]), 1)
        self.assertFalse(report["candidates"][0]["shares_blocks"])

    def test_busy_worktree_does_not_prevent_sharing_an_unused_runtime(self):
        runtime(self.linked)
        cache(self.linked)
        busy = ([(123, str(self.linked))], [])
        report = cleanup.audit(self.project, busy, private, for_sharing=True)
        self.assertEqual([item["kind"] for item in report["candidates"]], ["electron"])
        self.assertEqual(report["worktrees"][1]["status"], "scanned")
        self.assertEqual(cleanup.summary(report)["active_worktrees"], 1)

    def test_loaded_runtime_is_never_a_sharing_candidate(self):
        dist = runtime(self.linked)
        busy = ([(123, str(dist / "Electron.app/Contents/MacOS/Electron"))], [])
        report = cleanup.audit(self.project, busy, private, for_sharing=True)
        self.assertEqual(report["candidates"], [])
        self.assertTrue(dist.exists())

    @unittest.skipUnless(sys.platform == "darwin", "macOS APFS sharing oracle")
    def test_sharing_preserves_content_and_isolates_inodes_in_a_busy_worktree(self):
        dist = runtime(self.linked)
        cache_root = self.base / "runtime-cache"
        shutil.copytree(dist, cache_root / "dist", symlinks=True)
        identity = {"version": "44.10.1", "platform": "darwin", "arch": "arm64", "checksum": "fixture"}
        manifest = {"identity": identity, "files": cleanup.content_inventory(cache_root / "dist")}
        (cache_root / "runtime.json").write_text(json.dumps(manifest))
        busy = ([(123, str(self.linked))], [])
        before = cleanup.content_inventory(dist)
        original_inode = (dist / "Electron.app/Contents/MacOS/Electron").stat().st_ino
        report = cleanup.audit(self.project, busy, for_sharing=True)
        result = cleanup.share(report, snapshot_fn=lambda: busy,
            prepare_fn=lambda _package, _arch: {"cache": str(cache_root), "identity": identity},
            arch_fn=lambda _path: "arm64")
        self.assertEqual(result["preserved"], [])
        self.assertEqual(len(result["shared"]), 1)
        self.assertEqual(cleanup.content_inventory(dist), before)
        self.assertNotEqual((dist / "Electron.app/Contents/MacOS/Electron").stat().st_ino, original_inode)
        cleanup.clone_oracle(cache_root / "dist", dist)
        cached_file = cache_root / "dist/Electron.app/Contents/MacOS/Electron"
        cached_bytes = cached_file.read_bytes()
        (dist / "Electron.app/Contents/MacOS/Electron").write_bytes(b"worktree-private modification")
        self.assertEqual(cached_file.read_bytes(), cached_bytes)
        self.assertTrue((self.linked / "source.txt").exists())
        self.assertEqual(list(dist.parent.glob(".sharing-install-*")), [])

    @unittest.skipUnless(sys.platform == "darwin", "macOS APFS sharing oracle")
    def test_sharing_restores_original_when_runtime_starts_during_publication(self):
        dist = runtime(self.linked)
        cache_root = self.base / "runtime-cache"
        shutil.copytree(dist, cache_root / "dist", symlinks=True)
        identity = {"version": "44.10.1", "platform": "darwin", "arch": "arm64", "checksum": "fixture"}
        (cache_root / "runtime.json").write_text(json.dumps({"identity": identity,
            "files": cleanup.content_inventory(cache_root / "dist")}))
        original_inode = (dist / "Electron.app/Contents/MacOS/Electron").stat().st_ino
        snapshots = iter([IDLE, IDLE, IDLE, ([(123, str(dist / "Electron.app/Contents/MacOS/Electron"))], [])])
        report = cleanup.audit(self.project, IDLE, for_sharing=True)
        result = cleanup.share(report, snapshot_fn=lambda: next(snapshots),
            prepare_fn=lambda _package, _arch: {"cache": str(cache_root), "identity": identity},
            arch_fn=lambda _path: "arm64")
        self.assertEqual(result["shared"], [])
        self.assertEqual((dist / "Electron.app/Contents/MacOS/Electron").stat().st_ino, original_inode)
        self.assertEqual(list(dist.parent.glob(".sharing-install-*")), [])

    @unittest.skipUnless(sys.platform == "darwin", "macOS APFS sharing oracle")
    def test_original_backup_requires_explicit_post_publication_safety(self):
        for outcome in ("filesystem_error", "snapshot_error", "activity", "safe"):
            with self.subTest(outcome=outcome):
                dist = runtime(self.linked, "-" + outcome)
                cache_root = self.base / ("cache-" + outcome)
                shutil.copytree(dist, cache_root / "dist", symlinks=True)
                identity = {"version": "44.10.1", "platform": "darwin", "arch": "arm64", "checksum": "fixture"}
                (cache_root / "runtime.json").write_text(json.dumps({"identity": identity,
                    "files": cleanup.content_inventory(cache_root / "dist")}))
                relative = "Electron.app/Contents/MacOS/Electron"
                original_directory_inode = dist.stat().st_ino
                original_inode = (dist / relative).stat().st_ino
                original_bytes = (dist / relative).read_bytes()
                def published():
                    return dist.exists() and (dist / relative).stat().st_ino != original_inode
                def snapshot():
                    if published():
                        if outcome == "snapshot_error":
                            raise cleanup.Unsafe("Injected final process inspection failure")
                        if outcome == "activity":
                            return ([(123, str(dist / relative))], [])
                    return IDLE
                original_state = cleanup.tree_state
                def state(path, *args, **kwargs):
                    if path == dist and published() and outcome == "filesystem_error":
                        raise OSError("Injected post-publication filesystem failure")
                    return original_state(path, *args, **kwargs)
                report = cleanup.audit(self.project, IDLE, for_sharing=True)
                with mock.patch.object(cleanup, "tree_state", side_effect=state):
                    result = cleanup.share(report, snapshot_fn=snapshot,
                        prepare_fn=lambda _package, _arch: {"cache": str(cache_root), "identity": identity},
                        arch_fn=lambda _path: "arm64")
                backups = list(dist.parent.glob(".sharing-install-*/previous-dist"))
                self.assertTrue(dist.exists())
                if outcome == "safe":
                    self.assertEqual(backups, [])
                    self.assertEqual(result["preserved"], [])
                else:
                    self.assertEqual(len(backups), 1)
                    self.assertEqual((backups[0] / relative).stat().st_ino, original_inode)
                    self.assertEqual((backups[0] / relative).read_bytes(), original_bytes)
                    retained = next(item for item in result["preserved"] if item["path"] == str(backups[0]))
                    self.assertEqual(retained["inode"], original_directory_inode)
                    self.assertEqual(retained["witness"]["inode"], original_inode)

    @unittest.skipUnless(sys.platform == "darwin", "macOS runtime preparation")
    def test_cache_root_follows_configured_home_or_explicit_override(self):
        subprocess.run(["node", "--test", str(SKILL / "tests/prepare-runtime-cache-root.test.mjs")],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def test_sharing_rejects_content_that_differs_from_pinned_artifact(self):
        dist = runtime(self.linked)
        cache_root = self.base / "runtime-cache"
        shutil.copytree(dist, cache_root / "dist", symlinks=True)
        identity = {"version": "44.10.1", "platform": "darwin", "arch": "arm64", "checksum": "fixture"}
        (cache_root / "runtime.json").write_text(json.dumps({"identity": identity,
            "files": cleanup.content_inventory(cache_root / "dist")}))
        unique = dist / "Electron.app/Contents/unique-user-data"
        unique.write_text("preserve")
        report = cleanup.audit(self.project, IDLE, for_sharing=True)
        result = cleanup.share(report, snapshot_fn=lambda: IDLE,
            prepare_fn=lambda _package, _arch: {"cache": str(cache_root), "identity": identity},
            arch_fn=lambda _path: "arm64")
        self.assertEqual(result["shared"], [])
        self.assertIn("differs", result["preserved"][0]["reason"])
        self.assertEqual(unique.read_text(), "preserve")

    def test_current_process_activity_preserves_the_entire_worktree(self):
        target = cache(self.linked)
        report = self.audit(snapshot=([(123, str(self.linked))], []))
        self.assertEqual(report["candidates"], [])
        self.assertEqual(report["worktrees"][1]["status"], "active")
        self.assertTrue(target.exists())

    def test_stale_and_tampered_plans_do_not_delete_replacements_or_other_paths(self):
        target = cache(self.linked)
        report = self.audit()
        (target / "later").write_text("new data")
        self.assertEqual(self.clean(report)["removed"], [])
        self.assertTrue(target.exists())
        fresh = self.audit()
        fresh["candidates"][0]["path"] = str(self.project)
        self.assertEqual(self.clean(fresh)["removed"], [])
        self.assertTrue((self.project / "source.txt").exists())

    def test_symlink_escapes_and_tracked_cache_files_are_preserved(self):
        outside = self.base / "outside"
        outside.mkdir()
        (outside / "unique").write_text("keep")
        target = self.linked / "node_modules/.vitest-cache"
        target.parent.mkdir()
        target.symlink_to(outside, target_is_directory=True)
        self.assertEqual(self.audit()["candidates"], [])
        self.assertEqual((outside / "unique").read_text(), "keep")
        target.unlink()
        cache(self.linked)
        git(self.linked, "add", "--force", "node_modules/.vitest-cache/entry")
        self.assertEqual(self.audit()["candidates"], [])

    def test_racing_activity_restores_the_quarantined_directory(self):
        target = cache(self.linked)
        report = self.audit()
        snapshots = iter([IDLE, IDLE, ([(123, str(self.linked))], [])])
        result = self.clean(report, snapshot_fn=lambda: next(snapshots))
        self.assertEqual(result["removed"], [])
        self.assertTrue((target / "entry").exists())
        self.assertEqual(list(target.parent.glob(".cache-cleanup-*")), [])

    def test_installer_lock_and_unknown_or_modified_bundle_are_preserved(self):
        dist = runtime(self.linked)
        lock = dist.parent / ".pwragent-runtime-lock"
        lock.mkdir()
        self.assertEqual(self.audit(for_sharing=True)["candidates"], [])
        lock.rmdir()
        (dist / "unique.txt").write_text("keep")
        self.assertEqual(self.audit(for_sharing=True)["candidates"], [])

    def test_missing_metadata_fails_closed(self):
        cache(self.linked)
        def unavailable(_path):
            raise OSError("APFS metadata unavailable")
        self.assertEqual(self.audit(unavailable)["candidates"], [])

    def test_worktree_path_prefixes_do_not_imply_process_ownership(self):
        self.assertEqual(cleanup.active_pids(self.linked, ([(123, str(self.linked) + "-other")], [])), [])

    @unittest.skipUnless(sys.platform == "darwin", "macOS APFS oracle")
    def test_actual_apfs_clone_is_preserved_and_private_runtime_only_offered_for_conversion(self):
        original = runtime(self.linked)
        shared = original.parent.parent.parent.parent / "electron@44.10.1-shared/node_modules/electron"
        shared.mkdir(parents=True)
        (shared / "package.json").write_text((original.parent / "package.json").read_text())
        subprocess.run(["/bin/cp", "-cRpP", str(original), str(shared / "dist")], check=True)
        original_file = original / "Electron.app/Contents/MacOS/Electron"
        clone_file = shared / "dist/Electron.app/Contents/MacOS/Electron"
        self.assertNotEqual(original_file.stat().st_ino, clone_file.stat().st_ino)
        self.assertEqual(original_file.read_bytes(), clone_file.read_bytes())
        original_attrs, clone_attrs = cleanup.apfs_metadata(original_file), cleanup.apfs_metadata(clone_file)
        self.assertEqual(original_attrs["clone_id"], clone_attrs["clone_id"])
        self.assertEqual(clone_attrs["private_bytes"], 0)
        self.assertTrue(clone_attrs["sharing_flags"] & cleanup.SHARING_FLAGS)
        # Both clone participants must survive, including the original inode.
        report = cleanup.audit(self.project, IDLE, cleanup.apfs_metadata, for_sharing=True)
        self.assertEqual(report["candidates"], [])
        self.assertEqual(len(report["preserved"]), 2)
        independent = runtime(self.project)
        report = cleanup.audit(self.project, IDLE, cleanup.apfs_metadata, for_sharing=True)
        self.assertEqual(len(report["candidates"]), 1)
        self.clean(report, metadata=cleanup.apfs_metadata)
        self.assertTrue(independent.exists())
        self.assertTrue(original.exists())
        self.assertTrue((shared / "dist").exists())

    @unittest.skipUnless(sys.platform == "darwin", "macOS process oracle")
    def test_actual_live_process_cwd_is_detected(self):
        target = cache(self.linked)
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], cwd=self.linked)
        try:
            report = cleanup.audit(self.project)
            self.assertEqual(report["candidates"], [])
            self.assertTrue(target.exists())
        finally:
            child.terminate()
            child.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
