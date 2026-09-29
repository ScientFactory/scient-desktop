"""Behavioral smoke tests for the native parser (stdlib fixtures only)."""
import hashlib
import json
import os
import pathlib
import subprocess
import struct
import sys
import tempfile
import unittest
import zipfile


EXECUTABLE = pathlib.Path(sys.argv.pop(1)) if len(sys.argv) > 1 else None
MEDIA = b"application/vnd.scient.conversation+zip"


def package(path, *, text="Hello from conversation.json", archive_name="conversation.json",
            digest=True, overrides=None, extra_members=None, ensure_ascii=False,
            compression=zipfile.ZIP_STORED, mimetype_compression=zipfile.ZIP_STORED,
            streamed=False):
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
    snapshot = json.dumps(data, ensure_ascii=ensure_ascii).encode()
    sha = hashlib.sha256(snapshot).hexdigest() if digest else "0" * 64
    manifest = json.dumps({
        "format": "scient.conversation-file",
        "formatVersion": {"major": 1, "minor": 0},
        "entries": [
            {"path": archive_name, "byteLength": len(snapshot), "sha256": f"sha256:{sha}"},
            {"path": "conversation.md", "byteLength": 27, "sha256": "sha256:" + "0" * 64},
        ],
    }).encode()
    with zipfile.ZipFile(path, "w", compression=compression) as file:
        file.writestr("mimetype", MEDIA, compress_type=mimetype_compression)
        if streamed:
            file._seekable = False  # Match yazl's streamed members after stored mimetype.
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

    def test_accepts_stored_deflated_and_streamed_members(self):
        for compression in [zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED]:
            for streamed in [False, True]:
                with self.subTest(compression=compression, streamed=streamed):
                    package(self.path, compression=compression, streamed=streamed)
                    result = self.run_preview()
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn("Answer from JSON", result.stdout)

    def test_rejects_compressed_mimetype(self):
        for compression in [zipfile.ZIP_DEFLATED, zipfile.ZIP_LZMA, zipfile.ZIP_BZIP2]:
            with self.subTest(compression=compression):
                package(self.path, mimetype_compression=compression)
                self.assertNotEqual(self.run_preview().returncode, 0)

    def test_rejects_unsupported_methods_in_every_entry_including_skipped_data(self):
        for method in [1, 9, 12, 14, 93, 95, 256, 264, 65535]:
            for name in ["mimetype", "manifest.json", "conversation.json", "conversation.md"]:
                with self.subTest(method=method, member=name):
                    package(self.path)
                    with zipfile.ZipFile(self.path) as file:
                        offset = file.getinfo(name).header_offset
                    raw = bytearray(self.path.read_bytes())
                    struct.pack_into("<H", raw, offset + 8, method)
                    self.path.write_bytes(raw)
                    self.assertNotEqual(self.run_preview().returncode, 0)

    def test_rejects_real_lzma_and_bzip2_members(self):
        for compression in [zipfile.ZIP_LZMA, zipfile.ZIP_BZIP2]:
            with self.subTest(compression=compression):
                package(self.path, compression=compression)
                self.assertNotEqual(self.run_preview().returncode, 0)

    def test_blocks_symlink_decoder_during_header_parsing(self):
        # The xl extra field exposes Unix file type in the local header. Without
        # the pre-header gate libarchive attempts LZMA decoding before returning
        # the entry to our ordinary no-links check. Deliberately invalid data
        # ensures the policy error, not a decoder error, is the rejecting path.
        for method in [14, 270]:
            with self.subTest(method=method):
                package(self.path)
                with zipfile.ZipFile(self.path) as file:
                    offset = file.getinfo("manifest.json").header_offset
                raw = bytearray(self.path.read_bytes())
                name_length, extra_length = struct.unpack_from("<HH", raw, offset + 26)
                xl = struct.pack("<HHBHI", 0x6c78, 7, 5, 0x0314, 0xa1ff0000)
                end = offset + 30 + name_length + extra_length
                raw[end:end] = xl
                struct.pack_into("<H", raw, offset + 28, extra_length + len(xl))
                struct.pack_into("<H", raw, offset + 8, method)
                self.path.write_bytes(raw)
                result = self.run_preview()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Unsupported SCIC ZIP compression", result.stderr)

    def test_bidi_embeddings_and_overrides_are_visible_in_title_and_messages(self):
        controls = "".join(chr(code) for code in range(0x202a, 0x202f))
        markers = "".join(f"[U+{code:04X}]" for code in range(0x202a, 0x202f))
        for escaped in [False, True]:
            with self.subTest(escaped_json=escaped):
                package(self.path, text=f"שלום {controls} report",
                        overrides={"thread": {"title": f"Title {controls}"}},
                        ensure_ascii=escaped)
                before = self.path.read_bytes()
                result = self.run_preview()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"Title {markers}\n", result.stdout)
                self.assertIn(f"שלום {markers} report", result.stdout)
                for control in controls:
                    self.assertNotIn(control, result.stdout)
                self.assertEqual(self.path.read_bytes(), before)

    def test_preserves_natural_rtl_marks_and_isolates(self):
        text = "שלום العربية English 🙂 \u061c\u200e\u200f \u2066abc\u2069 \u2067שלום\u2069 \u2068العربية\u2069"
        package(self.path, text=text, overrides={"thread": {"title": text}})
        result = self.run_preview()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(result.stdout.startswith(text + "\n"))
        self.assertIn("USER\n" + text + "\n", result.stdout)

    def test_bidi_markers_respect_output_limits_without_partial_markers(self):
        for padding in [3992, 3993]:
            with self.subTest(padding=padding):
                package(self.path, text="a" * padding + "\u202etail")
                result = self.run_preview()
                self.assertEqual(result.returncode, 0, result.stderr)
                marker = "[U+202E]" if padding == 3992 else ""
                self.assertIn("a" * padding + marker + "\n[Message shortened for preview]",
                              result.stdout)
                self.assertNotIn("\u202e", result.stdout)
                self.assertNotIn("tail", result.stdout)
        package(self.path, text="\u202e" * 10000,
                overrides={"thread": {"title": "\u202e" * 10000}})
        result = self.run_preview()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(result.stdout.startswith("[U+202E]" * 512 + " [title shortened]\n"))
        self.assertIn("USER\n" + "[U+202E]" * 500 + "\n[Message shortened for preview]",
                      result.stdout)
        self.assertLess(len(result.stdout.encode()), 256 * 1024)

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
