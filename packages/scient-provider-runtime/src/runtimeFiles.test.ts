// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the package's private filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import * as Tar from "tar";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { resolveReviewedCursorArtifact } from "./cursorManifest.ts";
import { resolveReviewedCodexArtifact } from "./codexManifest.ts";
import {
  canUnpackManagedRuntimeZstd,
  materializeManagedRuntimeArtifact,
  resolveManagedRuntimeArtifactPath,
  unpackManagedRuntimeZstd,
  verifyManagedRuntimeChecksum,
} from "./runtimeFiles.ts";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-runtime-files-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("managed runtime files", () => {
  it.each([
    { platform: "darwin", entries: 54, passes: true },
    { platform: "linux", entries: 128, passes: true },
    { platform: "linux", entries: 129, passes: false },
    { platform: "win32", entries: 51, passes: true },
    { platform: "win32", entries: 128, passes: true },
    { platform: "win32", entries: 129, passes: false },
  ] as const)(
    "enforces the Codex $platform budget at $entries entries",
    async ({ platform, entries, passes }) => {
      const root = await temporaryRoot();
      const source = NodePath.join(root, "source");
      const archive = NodePath.join(root, "codex-package.tar.gz");
      const policy = resolveReviewedCodexArtifact({ platform, arch: "arm64" })!;
      const executablePath = platform === "win32" ? "codex.exe" : "codex";
      const members = [
        executablePath,
        ...Array.from({ length: entries - 1 }, (_, i) => `voice-library-${i}`),
      ];
      await NodeFSP.mkdir(source);
      await Promise.all(members.map((name) => NodeFSP.writeFile(NodePath.join(source, name), "x")));
      await Tar.c({ cwd: source, file: archive, gzip: true }, members);
      const extraction = materializeManagedRuntimeArtifact({
        archivePath: archive,
        archiveFormat: "tar.gz",
        destination: NodePath.join(root, "destination"),
        executablePath,
        platform,
        extractionLimits: policy.extractionLimits,
        signal: new AbortController().signal,
      });
      if (passes)
        await expect(extraction).resolves.toBe(NodePath.join(root, "destination", executablePath));
      else
        await expect(extraction).rejects.toThrow(
          `${entries} entries (limit ${policy.extractionLimits?.maxEntries ?? 32})`,
        );
    },
  );

  it("keeps the shared Windows extraction default at 32 entries", async () => {
    const root = await temporaryRoot();
    const source = NodePath.join(root, "source");
    const archive = NodePath.join(root, "codex-package.tar.gz");
    const executablePath = "codex.exe";
    const members = [executablePath, ...Array.from({ length: 32 }, (_, i) => `voice-library-${i}`)];
    await NodeFSP.mkdir(source);
    await Promise.all(members.map((name) => NodeFSP.writeFile(NodePath.join(source, name), "x")));
    await Tar.c({ cwd: source, file: archive, gzip: true }, members);

    await expect(
      materializeManagedRuntimeArtifact({
        archivePath: archive,
        archiveFormat: "tar.gz",
        destination: NodePath.join(root, "destination"),
        executablePath,
        platform: "win32",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("33 entries (limit 32)");
  });

  it("verifies exact SHA-256 digests", async () => {
    const root = await temporaryRoot();
    const file = NodePath.join(root, "artifact");
    const content = "reviewed artifact";
    await NodeFSP.writeFile(file, content);
    const digest = NodeCrypto.createHash("sha256").update(content).digest("hex");

    await expect(
      verifyManagedRuntimeChecksum(file, { algorithm: "sha256", digest }),
    ).resolves.toBeUndefined();
    await expect(
      verifyManagedRuntimeChecksum(file, { algorithm: "sha256", digest: "0".repeat(64) }),
    ).rejects.toThrow("checksum mismatch");
  });

  it("verifies exact SHA-512 digests", async () => {
    const root = await temporaryRoot();
    const file = NodePath.join(root, "artifact");
    const content = "reviewed Antigravity artifact";
    await NodeFSP.writeFile(file, content);
    const digest = NodeCrypto.createHash("sha512").update(content).digest("hex");

    await expect(
      verifyManagedRuntimeChecksum(file, { algorithm: "sha512", digest }),
    ).resolves.toBeUndefined();
    await expect(
      verifyManagedRuntimeChecksum(file, { algorithm: "sha512", digest: "0".repeat(128) }),
    ).rejects.toThrow("checksum mismatch");
  });

  it("extracts a reviewed executable and makes it runnable on Unix", async () => {
    const root = await temporaryRoot();
    const source = NodePath.join(root, "source");
    const archive = NodePath.join(root, "codex.tar.gz");
    const destination = NodePath.join(root, "destination");
    await NodeFSP.mkdir(source);
    await NodeFSP.writeFile(NodePath.join(source, "codex"), "binary");
    await Tar.c({ cwd: source, file: archive, gzip: true }, ["codex"]);

    const executable = await materializeManagedRuntimeArtifact({
      archivePath: archive,
      archiveFormat: "tar.gz",
      destination,
      executablePath: "codex",
      platform: "darwin",
      signal: new AbortController().signal,
    });

    expect(await NodeFSP.readFile(executable, "utf8")).toBe("binary");
    expect((await NodeFSP.stat(executable)).mode & 0o111).not.toBe(0);
  });

  it("validates and makes reviewed companion executables runnable on Unix", async () => {
    const root = await temporaryRoot();
    const source = NodePath.join(root, "source");
    const archive = NodePath.join(root, "codex-package.tar.gz");
    const destination = NodePath.join(root, "destination");
    await NodeFSP.mkdir(NodePath.join(source, "bin"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(source, "bin/codex"), "codex");
    await NodeFSP.writeFile(NodePath.join(source, "bin/codex-code-mode-host"), "host");
    await Tar.c({ cwd: source, file: archive, gzip: true }, ["bin"]);

    await materializeManagedRuntimeArtifact({
      archivePath: archive,
      archiveFormat: "tar.gz",
      destination,
      executablePath: "bin/codex",
      auxiliaryExecutablePaths: ["bin/codex-code-mode-host"],
      platform: "darwin",
      signal: new AbortController().signal,
    });

    expect((await NodeFSP.stat(NodePath.join(destination, "bin/codex"))).mode & 0o111).not.toBe(0);
    expect(
      (await NodeFSP.stat(NodePath.join(destination, "bin/codex-code-mode-host"))).mode & 0o111,
    ).not.toBe(0);
  });

  it("rejects a package that omits a reviewed companion executable", async () => {
    const root = await temporaryRoot();
    const source = NodePath.join(root, "source");
    const archive = NodePath.join(root, "incomplete-codex-package.tar.gz");
    await NodeFSP.mkdir(NodePath.join(source, "bin"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(source, "bin/codex"), "codex");
    await Tar.c({ cwd: source, file: archive, gzip: true }, ["bin"]);

    await expect(
      materializeManagedRuntimeArtifact({
        archivePath: archive,
        archiveFormat: "tar.gz",
        destination: NodePath.join(root, "destination"),
        executablePath: "bin/codex",
        auxiliaryExecutablePaths: ["bin/codex-code-mode-host"],
        platform: "darwin",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("bin/codex-code-mode-host");
  });

  it("rejects links instead of extracting them into managed storage", async () => {
    const root = await temporaryRoot();
    const source = NodePath.join(root, "source");
    const archive = NodePath.join(root, "codex.tar.gz");
    await NodeFSP.mkdir(source);
    await NodeFSP.symlink("/tmp/not-codex", NodePath.join(source, "codex"));
    await Tar.c({ cwd: source, file: archive, gzip: true }, ["codex"]);

    await expect(
      materializeManagedRuntimeArtifact({
        archivePath: archive,
        archiveFormat: "tar.gz",
        destination: NodePath.join(root, "destination"),
        executablePath: "codex",
        platform: "darwin",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Unsupported archive entry");
  });

  it("supports the official raw-executable shape used on Windows", async () => {
    const root = await temporaryRoot();
    const archive = NodePath.join(root, "codex.exe.download");
    await NodeFSP.writeFile(archive, "windows-binary");

    const executable = await materializeManagedRuntimeArtifact({
      archivePath: archive,
      archiveFormat: "raw",
      destination: NodePath.join(root, "destination"),
      executablePath: "codex.exe",
      platform: "win32",
      signal: new AbortController().signal,
    });

    expect(NodePath.basename(executable)).toBe("codex.exe");
    expect(await NodeFSP.readFile(executable, "utf8")).toBe("windows-binary");
  });

  it("extracts a bounded ZIP payload without shelling out to a host tool", async () => {
    const root = await temporaryRoot();
    const archive = NodePath.join(root, "cursor.zip");
    const zip = new JSZip();
    zip.file("dist-package/cursor-agent.cmd", "@echo off\r\n");
    zip.file("dist-package/index.js", "process.stdout.write('cursor');\n");
    await NodeFSP.writeFile(
      archive,
      await zip.generateAsync({ type: "nodebuffer", platform: "DOS" }),
    );

    const executable = await materializeManagedRuntimeArtifact({
      archivePath: archive,
      archiveFormat: "zip",
      destination: NodePath.join(root, "destination"),
      executablePath: "dist-package/cursor-agent.cmd",
      platform: "win32",
      extractionLimits: { maxEntries: 8, maxExpandedBytes: 4_096 },
      signal: new AbortController().signal,
    });

    expect(await NodeFSP.readFile(executable, "utf8")).toContain("@echo off");
    expect(
      await NodeFSP.readFile(NodePath.join(root, "destination/dist-package/index.js"), "utf8"),
    ).toContain("cursor");
  });

  it("rejects ZIP payloads that exceed their reviewed entry budget", async () => {
    const root = await temporaryRoot();
    const archive = NodePath.join(root, "oversized.zip");
    const zip = new JSZip();
    zip.file("cursor-agent.cmd", "@echo off\r\n");
    zip.file("extra.js", "extra");
    await NodeFSP.writeFile(archive, await zip.generateAsync({ type: "nodebuffer" }));

    await expect(
      materializeManagedRuntimeArtifact({
        archivePath: archive,
        archiveFormat: "zip",
        destination: NodePath.join(root, "destination"),
        executablePath: "cursor-agent.cmd",
        platform: "win32",
        extractionLimits: { maxEntries: 1, maxExpandedBytes: 4_096 },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("2 entries (limit 1)");
  });

  it("rejects ZIP payloads that exceed their reviewed expanded-size budget", async () => {
    const root = await temporaryRoot();
    const archive = NodePath.join(root, "expanded.zip");
    const zip = new JSZip();
    zip.file("cursor-agent.cmd", "x".repeat(4_097));
    await NodeFSP.writeFile(archive, await zip.generateAsync({ type: "nodebuffer" }));

    await expect(
      materializeManagedRuntimeArtifact({
        archivePath: archive,
        archiveFormat: "zip",
        destination: NodePath.join(root, "destination"),
        executablePath: "cursor-agent.cmd",
        platform: "win32",
        extractionLimits: { maxEntries: 2, maxExpandedBytes: 4_096 },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("4097 expanded bytes (limit 4096)");
  });

  it("rejects ZIP symbolic links instead of materializing them", async () => {
    const root = await temporaryRoot();
    const archive = NodePath.join(root, "symlink.zip");
    const zip = new JSZip();
    zip.file("cursor-agent", "target", { unixPermissions: 0o120777 });
    await NodeFSP.writeFile(
      archive,
      await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" }),
    );

    await expect(
      materializeManagedRuntimeArtifact({
        archivePath: archive,
        archiveFormat: "zip",
        destination: NodePath.join(root, "destination"),
        executablePath: "cursor-agent",
        platform: "linux",
        extractionLimits: { maxEntries: 2, maxExpandedBytes: 4_096 },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Unsupported archive entry");
  });

  it("rejects case-insensitive duplicate ZIP paths on Windows", async () => {
    const root = await temporaryRoot();
    const archive = NodePath.join(root, "duplicate.zip");
    const zip = new JSZip();
    zip.file("Cursor-Agent.cmd", "first");
    zip.file("cursor-agent.cmd", "second");
    await NodeFSP.writeFile(archive, await zip.generateAsync({ type: "nodebuffer" }));

    await expect(
      materializeManagedRuntimeArtifact({
        archivePath: archive,
        archiveFormat: "zip",
        destination: NodePath.join(root, "destination"),
        executablePath: "cursor-agent.cmd",
        platform: "win32",
        extractionLimits: { maxEntries: 3, maxExpandedBytes: 4_096 },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("duplicate path");
  });

  it("honors cancellation before ZIP extraction begins", async () => {
    const root = await temporaryRoot();
    const archive = NodePath.join(root, "cancelled.zip");
    const zip = new JSZip();
    zip.file("cursor-agent.cmd", "@echo off\r\n");
    await NodeFSP.writeFile(archive, await zip.generateAsync({ type: "nodebuffer" }));
    const controller = new AbortController();
    controller.abort();

    await expect(
      materializeManagedRuntimeArtifact({
        archivePath: archive,
        archiveFormat: "zip",
        destination: NodePath.join(root, "destination"),
        executablePath: "cursor-agent.cmd",
        platform: "win32",
        extractionLimits: { maxEntries: 2, maxExpandedBytes: 4_096 },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects invalid, escaping, and Windows alternate-stream payload paths", async () => {
    const root = await temporaryRoot();

    expect(() => resolveManagedRuntimeArtifactPath(root, "../cursor-agent")).toThrow(
      "Unsafe archive path",
    );
    expect(() => resolveManagedRuntimeArtifactPath(root, "package/../cursor-agent")).toThrow(
      "Unsafe archive path",
    );
    expect(() => resolveManagedRuntimeArtifactPath(root, "/cursor-agent")).toThrow(
      "Unsafe archive path",
    );

    const archive = NodePath.join(root, "alternate-stream.zip");
    const zip = new JSZip();
    zip.file("cursor-agent.cmd", "@echo off\r\n");
    zip.file("cursor-agent.cmd:payload", "hidden");
    await NodeFSP.writeFile(archive, await zip.generateAsync({ type: "nodebuffer" }));
    await expect(
      materializeManagedRuntimeArtifact({
        archivePath: archive,
        archiveFormat: "zip",
        destination: NodePath.join(root, "destination"),
        executablePath: "cursor-agent.cmd",
        platform: "win32",
        extractionLimits: { maxEntries: 4, maxExpandedBytes: 4_096 },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Unsafe Windows archive path");
  });

  it("accepts Cursor's reviewed expanded budget independently of the download ceiling", async () => {
    const root = await temporaryRoot();
    const source = NodePath.join(root, "source");
    const policy = resolveReviewedCursorArtifact({ platform: "darwin", arch: "arm64" })!;
    await NodeFSP.mkdir(NodePath.join(source, "dist-package"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(source, policy.executablePath), "cursor fixture");
    const archive = NodePath.join(root, "cursor.tar.gz");
    await Tar.c({ cwd: source, file: archive, gzip: true }, ["dist-package"]);

    const executable = await materializeManagedRuntimeArtifact({
      archivePath: archive,
      archiveFormat: policy.archiveFormat,
      destination: NodePath.join(root, "destination"),
      executablePath: policy.executablePath,
      platform: policy.target.platform,
      extractionLimits: policy.extractionLimits,
      signal: new AbortController().signal,
    });
    expect(await NodeFSP.readFile(executable, "utf8")).toBe("cursor fixture");
  });

  it.each([
    { maxEntries: 0, maxExpandedBytes: 4_096 },
    { maxEntries: 4, maxExpandedBytes: 768 * 1024 * 1024 + 1 },
  ])("rejects invalid extraction limits before extraction: %j", async (extractionLimits) => {
    const root = await temporaryRoot();
    const archive = NodePath.join(root, "cursor.zip");
    const zip = new JSZip();
    zip.file("cursor-agent.cmd", "@echo off\r\n");
    await NodeFSP.writeFile(archive, await zip.generateAsync({ type: "nodebuffer" }));

    await expect(
      materializeManagedRuntimeArtifact({
        archivePath: archive,
        archiveFormat: "zip",
        destination: NodePath.join(root, "destination"),
        executablePath: "cursor-agent.cmd",
        platform: "win32",
        extractionLimits,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("invalid extraction limits");
  });
});

describe("compressed managed runtime downloads", () => {
  const binary = NodeCrypto.randomBytes(256 * 1024);

  async function unpack(compressed: Buffer, expectedSize = binary.length) {
    const root = await temporaryRoot();
    const source = NodePath.join(root, "binary.zst");
    const destination = NodePath.join(root, "binary");
    await NodeFSP.writeFile(source, compressed);
    const run = unpackManagedRuntimeZstd({
      source,
      destination,
      expectedSize,
      signal: new AbortController().signal,
    });
    return { run, destination };
  }

  /** As a release is made: streamed, so the frame states its window. */
  async function compress(bytes: Buffer, windowLog: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const stream = NodeZlib.createZstdCompress({
      params: { [NodeZlib.constants.ZSTD_c_windowLog]: windowLog },
    });
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    const ended = new Promise((resolve) => stream.on("end", resolve));
    stream.end(bytes);
    await ended;
    return Buffer.concat(chunks);
  }

  it("is available on the Node this app runs on", () => {
    expect(canUnpackManagedRuntimeZstd()).toBe(true);
  });

  it("unpacks a copy made with the release window", async () => {
    const { run, destination } = await unpack(await compress(binary, 27));
    await run;
    expect(await NodeFSP.readFile(destination)).toEqual(binary);
  });

  it.each([
    { name: "a window larger than the release's", window: 28, size: undefined, error: /unpacked/u },
    { name: "more bytes than the release", window: 27, size: 1_024, error: /more than/u },
    { name: "fewer bytes than the release", window: 27, size: 512 * 1024, error: /less than/u },
  ])("refuses $name and leaves nothing behind", async ({ window, size, error }) => {
    const { run, destination } = await unpack(await compress(binary, window), size);
    await expect(run).rejects.toThrow(error);
    await expect(NodeFSP.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a damaged copy", async () => {
    const compressed = await compress(binary, 27);
    compressed.fill(0, 0, 4);
    const { run, destination } = await unpack(compressed);
    await expect(run).rejects.toThrow(/could not be unpacked/u);
    await expect(NodeFSP.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
