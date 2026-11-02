"""Preview dependency pins fail closed before any artifact download."""
import copy
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("preview", Path(__file__).with_name("preview-build-assets.py"))
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)


class PreviewAssetTests(unittest.TestCase):
    def setUp(self):
        self.url = "https://github.com/pwrdrvr/PwrSnap/releases/download/v1.1.19/ffmpeg-8.1.1.tar.xz"
        self.sha = "a" * 64
        self.release = dict(tag_name="v1.1.19", draft=False, prerelease=False, assets=[
            dict(name="ffmpeg-8.1.1.tar.xz", browser_download_url=self.url,
                 digest=f"sha256:{self.sha}", size=42)])
        self.reads = []
        self.restores = []

    def read(self, endpoint):
        self.reads.append(endpoint)
        self.assertEqual(endpoint, "repos/pwrdrvr/PwrSnap/releases/tags/v1.1.19")
        return self.release

    def restore(self, *args):
        self.restores.append(args)
        return "build-artifact"

    def acquire(self, url=None, sha=None):
        return preview.acquire(url or self.url, sha or self.sha, "payload", self.read, self.restore)

    def test_only_json_metadata_then_verified_shared_artifact_acquirer(self):
        self.assertEqual(self.acquire(), "build-artifact")
        self.assertEqual(self.restores, [(self.url, self.sha, 42, Path("payload"))])

    def test_untrusted_urls_and_invalid_pins_never_make_requests(self):
        for url in [self.url.replace("PwrSnap", "PwrAgent"), self.url.replace("v1.1.19", "v1.1.0-alpha.4"),
                    self.url.replace("github.com", "attacker.example"), self.url + "/extra"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                self.acquire(url=url)
        with self.assertRaises(ValueError):
            self.acquire(sha="bad")
        self.assertEqual(self.reads, [])
        self.assertEqual(self.restores, [])

    def test_replaced_ambiguous_missing_or_unpublished_assets_never_restore(self):
        original = copy.deepcopy(self.release)
        cases = [dict(tag_name="v2.0.0"), dict(draft=True), dict(prerelease=True), dict(assets=[]),
                 dict(assets=original["assets"] * 2)]
        for key, value in [("digest", "sha256:" + "b" * 64), ("size", 0), ("size", True),
                           ("size", None), ("browser_download_url", "https://attacker.example/asset")]:
            asset = dict(original["assets"][0], **{key: value})
            cases.append(dict(assets=[asset]))
        for changes in cases:
            self.release = dict(original, **changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.acquire()
        self.assertEqual(self.restores, [])

    def test_expired_artifact_failure_propagates_without_release_fallback(self):
        def expired(*args):
            raise ValueError("No retained artifact; fallback is prohibited")
        with self.assertRaisesRegex(ValueError, "fallback is prohibited"):
            preview.acquire(self.url, self.sha, "payload", self.read, expired)
        self.assertEqual(len(self.reads), 1)


if __name__ == "__main__":
    unittest.main()
