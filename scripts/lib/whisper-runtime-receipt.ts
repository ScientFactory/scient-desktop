// @effect-diagnostics nodeBuiltinImport:off -- receipt checks for a staged whisper.cpp runtime.
// Shared by stage-whisper-runtime.ts and the packaging adapter, which is type-checked with the
// desktop app and so can only import from scripts/lib.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export const WHISPER_CPP_VERSION = "v1.9.1";
export const WHISPER_CPP_COMMIT = "f049fff95a089aa9969deb009cdd4892b3e74916";

export type WhisperRuntimePlatform = "linux" | "mac" | "win";
export type WhisperRuntimeArch = "arm64" | "x64" | "universal";
/**
 * Raised when a platform's runtime is built differently from the same pinned
 * source, so a receipt or development cache entry of the earlier build is not
 * taken for this one. Windows 2 is built here from source; Windows 1 was the
 * upstream archive, which needed the Visual C++ Redistributable.
 */
export const WHISPER_RUNTIME_BUILD: Readonly<Record<WhisperRuntimePlatform, number>> = {
  linux: 1,
  mac: 1,
  win: 2,
};

export function runtimeExecutableName(platform: WhisperRuntimePlatform): string {
  return platform === "win" ? "whisper-server.exe" : "whisper-server";
}

async function sha256File(filePath: string): Promise<string> {
  return NodeCrypto.createHash("sha256")
    .update(await NodeFSP.readFile(filePath))
    .digest("hex");
}

export async function collectFiles(output: string) {
  const names = (await NodeFSP.readdir(output))
    .filter((name) => name !== "provenance.json")
    .toSorted();
  return Promise.all(
    names.map(async (file) => {
      const filePath = NodePath.join(output, file);
      const fileStat = await NodeFSP.stat(filePath);
      return { file, sha256: await sha256File(filePath), size: fileStat.size };
    }),
  );
}

/**
 * Require the exact pinned receipt and every recorded ordinary file, size, and checksum; partial
 * copies, links, or other versions are not usable. This is integrity checking, not protection
 * against a user-files writer.
 */
export async function isStagedWhisperRuntime(
  directory: string,
  platform: WhisperRuntimePlatform,
  arch: WhisperRuntimeArch,
  /**
   * "names" accepts recorded files whose bytes changed: release packaging
   * signs the helper and its libraries after staging. The receipt, the build
   * and the exact list of files must still match.
   */
  contents: "exact" | "names" = "exact",
): Promise<boolean> {
  try {
    const receipt: unknown = JSON.parse(
      await NodeFSP.readFile(NodePath.join(directory, "provenance.json"), "utf8"),
    );
    if (typeof receipt !== "object" || receipt === null) return false;
    const { component, version, source, files } = receipt as Record<string, unknown>;
    const recorded = receipt as {
      readonly platform?: unknown;
      readonly arch?: unknown;
      readonly build?: unknown;
    };
    if (
      component !== "whisper.cpp" ||
      version !== WHISPER_CPP_VERSION ||
      recorded.platform !== platform ||
      recorded.arch !== arch ||
      // Receipts written before builds were numbered are build 1.
      (recorded.build ?? 1) !== WHISPER_RUNTIME_BUILD[platform] ||
      (source as { readonly commit?: unknown } | null)?.commit !== WHISPER_CPP_COMMIT ||
      !Array.isArray(files)
    )
      return false;
    const entries = await NodeFSP.readdir(directory, { withFileTypes: true });
    // A link would leave the copy depending on a file outside it.
    if (!entries.every((entry) => entry.isFile())) return false;
    const actual = await collectFiles(directory);
    return (
      actual.some((file) => file.file === runtimeExecutableName(platform)) &&
      actual.length === files.length &&
      actual.every((file, index) => {
        const expected = files[index] as Record<string, unknown> | null;
        return (
          expected?.file === file.file &&
          (contents === "names" || (expected.sha256 === file.sha256 && expected.size === file.size))
        );
      })
    );
  } catch {
    return false;
  }
}
