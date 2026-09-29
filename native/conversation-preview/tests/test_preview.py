"""Behavioral smoke tests for the native parser (stdlib fixtures only)."""
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
import zipfile


EXECUTABLE = pathlib.Path(sys.argv.pop(1)) if len(sys.argv) > 1 else None
MEDIA = b"application/vnd.scient.conversation+zip"


def package(path, *, text="Hello from conversation.json", archive_name="conversation.json",
            digest=True, overrides=None, extra_members=None):
    data = {
        "format": "scient.conversation-snapshot",
        "version": 1,
        "thread": {"title": "A careful preview"},
        "messages": [
            {"role": "user", "text": text},
            {"role": "assistant", "text": "Answer from JSON"},
        ],
    }
    data.update(overrides or {})
    snapshot = json.dumps(data, ensure_ascii=False).encode()
    sha = hashlib.sha256(snapshot).hexdigest() if digest else "0" * 64
    manifest = json.dumps({
        "format": "scient.conversation-file",
        "formatVersion": {"major": 1, "minor": 0},
        "entries": [
            {"path": archive_name, "byteLength": len(snapshot), "sha256": f"sha256:{sha}"},
            {"path": "conversation.md", "byteLength": 27, "sha256": "sha256:" + "0" * 64},
        ],
    }).encode()
    with zipfile.ZipFile(path, "w") as file:
        file.writestr("mimetype", MEDIA, compress_type=zipfile.ZIP_STORED)
        file.writestr("manifest.json", manifest)
        file.writestr(archive_name, snapshot)
        file.writestr("conversation.md", "Malicious Markdown? <script>x")
        for name, content in extra_members or []:
            file.writestr(name, content)


class NativePreviewTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="scic-preview-test-")
        self.path = pathlib.Path(self.directory.name) / "fixture.scic"

    def tearDown(self):
        self.directory.cleanup()

    def run_preview(self):
        return subprocess.run([str(EXECUTABLE), str(self.path)], capture_output=True,
                              text=True, encoding="utf-8")

    def test_authoritative_json_and_inert_markdown(self):
        package(self.path, text="שלום <script>alert(1)</script>")
        result = self.run_preview()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("A careful preview\nRead-only preview.", result.stdout)
        self.assertIn("USER\nשלום", result.stdout)
        self.assertIn("ASSISTANT\nAnswer from JSON", result.stdout)
        self.assertNotIn("Malicious Markdown", result.stdout)

    def test_rejects_digest_mismatch(self):
        package(self.path, digest=False)
        result = self.run_preview()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("digest mismatch", result.stderr)

    def test_rejects_unsafe_member(self):
        package(self.path, archive_name="../conversation.json")
        result = self.run_preview()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Unsafe ZIP entry", result.stderr)

    def test_rejects_oversized_snapshot_before_decompression(self):
        package(self.path, text="a" * (17 * 1024 * 1024))
        result = self.run_preview()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("too large for preview", result.stderr)

    def test_utf8_truncation_keeps_complete_codepoints(self):
        package(self.path, text="a" * 3996 + "🙂" + "tail")
        result = self.run_preview()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("a" * 3996 + "🙂\n[Message shortened for preview]", result.stdout)
        self.assertNotIn("🙂tail", result.stdout)

    def test_rejects_case_colliding_member(self):
        package(self.path, extra_members=[("CONVERSATION.JSON", b"forged")])
        result = self.run_preview()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Duplicate ZIP entry", result.stderr)

    def test_rejects_malformed_snapshot_fields(self):
        cases = [
            {"format": "other"},
            {"thread": {}},
            {"messages": [{"role": "tool", "text": "x"}]},
            {"messages": [{"role": "user"}]},
            {"messages": "not an array"},
        ]
        for changed in cases:
            with self.subTest(changed=changed):
                package(self.path, overrides=changed)
                self.assertNotEqual(self.run_preview().returncode, 0)

    @unittest.skipUnless(hasattr(os, "mkfifo"), "POSIX FIFO test")
    def test_rejects_fifo_and_symlink_without_following(self):
        os.mkfifo(self.path)
        result = self.run_preview()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("regular conversation file", result.stderr)
        self.path.unlink()
        actual = pathlib.Path(self.directory.name) / "actual.scic"
        package(actual)
        self.path.symlink_to(actual)
        result = self.run_preview()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Cannot open conversation file", result.stderr)


if __name__ == "__main__":
    if EXECUTABLE is None:
        raise SystemExit("Pass the scic-preview executable path")
    unittest.main()
