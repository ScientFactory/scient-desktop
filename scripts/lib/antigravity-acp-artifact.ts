// @effect-diagnostics nodeBuiltinImport:off -- CI-only artifact discovery streams into an isolated temporary file.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Yauzl from "yauzl";

const MAX_BYTES = 4 * 1024 ** 3;

/** Hash the complete download and inspect its two ZIP members without buffering it in memory. */
export async function inspectAntigravityAcpArtifact(
  response: Response,
  executableName: string,
  harnessName: string,
) {
  if (!response.body) throw new Error("Antigravity ACP archive has no response body.");
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-acp-discovery-"));
  const archivePath = NodePath.join(root, "runtime.zip");
  try {
    const output = await NodeFSP.open(archivePath, "wx", 0o600);
    const reader = response.body.getReader();
    const hash = NodeCrypto.createHash("sha256");
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_BYTES)
          throw new Error("Antigravity ACP archive exceeds the approved size limit.");
        hash.update(chunk.value);
        await output.writeFile(chunk.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
      await output.close();
    }
    if (size === 0) throw new Error("Antigravity ACP archive is empty.");
    const zip = await new Promise<Yauzl.ZipFile>((resolve, reject) => {
      Yauzl.open(archivePath, { lazyEntries: true, strictFileNames: true }, (error, archive) => {
        if (error || !archive)
          reject(error ?? new Error("Could not open Antigravity ACP archive."));
        else resolve(archive);
      });
    });
    try {
      const members = await new Promise<Map<string, number>>((resolve, reject) => {
        const sizes = new Map<string, number>();
        zip.on("error", reject);
        zip.on("end", () => resolve(sizes));
        zip.on("entry", (entry: Yauzl.Entry) => {
          const fileType = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (
            zip.entryCount !== 2 ||
            ![executableName, harnessName].includes(entry.fileName) ||
            sizes.has(entry.fileName) ||
            (fileType !== 0 && fileType !== 0o100000) ||
            (entry.externalFileAttributes & 0x10) !== 0 ||
            (entry.generalPurposeBitFlag & 1) !== 0 ||
            ![0, 8].includes(entry.compressionMethod) ||
            !Number.isSafeInteger(entry.uncompressedSize) ||
            entry.uncompressedSize <= 0 ||
            entry.uncompressedSize > MAX_BYTES
          ) {
            reject(new Error("Antigravity ACP archive contains an unexpected or unsafe member."));
            zip.close();
            return;
          }
          sizes.set(entry.fileName, entry.uncompressedSize);
          zip.readEntry();
        });
        zip.readEntry();
      });
      const executableBytes = members.get(executableName);
      const harnessBytes = members.get(harnessName);
      if (!executableBytes || !harnessBytes)
        throw new Error("Antigravity ACP archive is missing its executable or harness.");
      return { digest: hash.digest("hex"), size, executableBytes, harnessBytes };
    } finally {
      zip.close();
    }
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}
