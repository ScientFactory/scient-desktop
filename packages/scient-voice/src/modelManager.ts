// @effect-diagnostics nodeBuiltinImport:off globalDate:off - pure Node core, no Effect runtime.
// Downloads, verifies, resumes, repairs, and removes a pinned offline model.
//
// Lifted from the old app's `localVoiceModelManager.ts`. Preserves the full
// safety design: resumable ranged download, sha256 + byte-size + GGML
// magic-header verification, atomic `.partial` -> rename (never exposes an
// unverified model path), a JSON receipt, repair/remove, and 0o700 / 0o600
// permissions. `fetchImpl` is injectable so tests never touch the network.

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { VoiceModelDefinition } from "./modelManifest.ts";

export type VoiceModelState =
  | { readonly state: "missing" }
  | {
      readonly state: "downloading";
      readonly downloadedBytes: number;
      readonly totalBytes: number;
      readonly readyModelPath?: string;
    }
  | {
      readonly state: "ready";
      readonly modelPath: string;
      readonly byteSize: number;
    }
  | { readonly state: "error"; readonly message: string };

export interface VoiceModelDownloadProgress {
  readonly downloadedBytes: number;
  readonly totalBytes: number;
}

export type VoiceModelDownloadProgressCallback = (progress: VoiceModelDownloadProgress) => void;

interface VoiceModelReceipt {
  readonly id: string;
  readonly fileName: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly sourceRevision: string;
  readonly verifiedAt: string;
}

export interface VoiceModelManagerOptions {
  readonly modelsDirectory: string;
  readonly manifest: VoiceModelDefinition;
  readonly fetchImpl?: typeof fetch;
}

export class VoiceModelManager {
  readonly modelPath: string;
  readonly partialPath: string;
  readonly repairPartialPath: string;
  readonly receiptPath: string;

  private readonly modelsDirectory: string;
  private readonly manifest: VoiceModelDefinition;
  private readonly fetchImpl: typeof fetch;
  private activeDownload: Promise<string> | null = null;
  private activeTransferPath: string | null = null;
  private activeOperation: "install" | "repair" | null = null;
  private verifiedFileCache: { readonly size: number; readonly mtimeMs: number } | null = null;

  constructor(options: VoiceModelManagerOptions) {
    this.modelsDirectory = options.modelsDirectory;
    this.manifest = options.manifest;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.modelPath = NodePath.join(options.modelsDirectory, options.manifest.fileName);
    this.partialPath = `${this.modelPath}.partial`;
    this.repairPartialPath = `${this.modelPath}.repair.partial`;
    this.receiptPath = `${this.modelPath}.json`;
  }

  async getStatus(): Promise<VoiceModelState> {
    if (this.activeDownload) {
      const downloadedBytes = await fileSize(this.activeTransferPath ?? this.partialPath);
      const readyModelPath =
        this.activeOperation === "repair" && (await this.hasVerifiedReceipt())
          ? this.modelPath
          : undefined;
      return {
        state: "downloading",
        downloadedBytes,
        totalBytes: this.manifest.byteSize,
        ...(readyModelPath ? { readyModelPath } : {}),
      };
    }

    const ready = await this.hasVerifiedReceipt();
    return ready
      ? {
          state: "ready",
          modelPath: this.modelPath,
          byteSize: this.manifest.byteSize,
        }
      : { state: "missing" };
  }

  isDownloading(): boolean {
    return this.activeDownload !== null;
  }

  async ensureInstalled(
    signal: AbortSignal,
    onProgress?: VoiceModelDownloadProgressCallback,
  ): Promise<string> {
    if (await this.hasVerifiedReceipt()) {
      return this.modelPath;
    }
    if (this.activeDownload) {
      return this.activeDownload;
    }

    this.activeTransferPath = this.partialPath;
    this.activeOperation = "install";
    const download = this.downloadAndVerify(signal, onProgress, this.partialPath).finally(() => {
      if (this.activeDownload === download) {
        this.activeDownload = null;
        this.activeTransferPath = null;
        this.activeOperation = null;
      }
    });
    this.activeDownload = download;
    return download;
  }

  async repair(
    signal: AbortSignal,
    onProgress?: VoiceModelDownloadProgressCallback,
  ): Promise<string> {
    if (this.activeDownload) {
      throw new Error("The offline voice model is already downloading.");
    }
    await NodeFSP.rm(this.repairPartialPath, { force: true });
    this.activeTransferPath = this.repairPartialPath;
    this.activeOperation = "repair";
    const repair = this.downloadAndVerify(signal, onProgress, this.repairPartialPath).finally(
      async () => {
        if (this.activeDownload === repair) {
          this.activeDownload = null;
          this.activeTransferPath = null;
          this.activeOperation = null;
        }
        await NodeFSP.rm(this.repairPartialPath, { force: true });
      },
    );
    this.activeDownload = repair;
    return repair;
  }

  async verifyInstalledModel(): Promise<boolean> {
    const stats = await statOrNull(this.modelPath);
    if (!stats?.isFile() || stats.size !== this.manifest.byteSize) {
      return false;
    }
    const valid =
      (await sha256File(this.modelPath)) === this.manifest.sha256 &&
      (await fileStartsWithHex(this.modelPath, this.manifest.headerHex));
    this.verifiedFileCache = valid ? { size: stats.size, mtimeMs: stats.mtimeMs } : null;
    return valid;
  }

  async remove(): Promise<void> {
    if (this.activeDownload) {
      throw new Error("The offline voice model cannot be removed while it is downloading.");
    }
    await Promise.all([
      NodeFSP.rm(this.modelPath, { force: true }),
      NodeFSP.rm(this.partialPath, { force: true }),
      NodeFSP.rm(this.repairPartialPath, { force: true }),
      NodeFSP.rm(this.receiptPath, { force: true }),
    ]);
    this.verifiedFileCache = null;
  }

  private async hasVerifiedReceipt(): Promise<boolean> {
    const [modelStats, receipt] = await Promise.all([
      statOrNull(this.modelPath),
      readReceipt(this.receiptPath),
    ]);
    const manifest = this.manifest;
    const receiptMatches = Boolean(
      modelStats?.isFile() &&
      modelStats.size === manifest.byteSize &&
      receipt?.id === manifest.id &&
      receipt.fileName === manifest.fileName &&
      receipt.byteSize === manifest.byteSize &&
      receipt.sha256 === manifest.sha256 &&
      receipt.sourceRevision === manifest.sourceRevision,
    );
    if (!receiptMatches || !modelStats) {
      this.verifiedFileCache = null;
      return false;
    }
    if (
      this.verifiedFileCache?.size === modelStats.size &&
      this.verifiedFileCache.mtimeMs === modelStats.mtimeMs
    ) {
      return true;
    }
    return this.verifyInstalledModel();
  }

  private async downloadAndVerify(
    signal: AbortSignal,
    onProgress: VoiceModelDownloadProgressCallback | undefined,
    partialPath: string,
  ): Promise<string> {
    if (typeof this.fetchImpl !== "function") {
      throw new Error("Offline voice model downloads are unavailable in this runtime.");
    }

    await NodeFSP.mkdir(this.modelsDirectory, { recursive: true, mode: 0o700 });
    const manifest = this.manifest;
    let existingBytes = Math.min(await fileSize(partialPath), manifest.byteSize);
    if (existingBytes === manifest.byteSize) {
      const valid = (await sha256File(partialPath)) === manifest.sha256;
      if (!valid) {
        await NodeFSP.rm(partialPath, { force: true });
        existingBytes = 0;
      }
    }

    if (existingBytes < manifest.byteSize) {
      const response = await this.fetchImpl(manifest.downloadUrl, {
        signal,
        ...(existingBytes > 0 ? { headers: { Range: `bytes=${existingBytes}-` } } : {}),
      });
      if (!response.ok) {
        throw new Error(`Offline voice model download failed with status ${response.status}.`);
      }
      if (!response.body) {
        throw new Error("Offline voice model download returned no data.");
      }

      const resumed = existingBytes > 0 && response.status === 206;
      if (!resumed && existingBytes > 0) {
        existingBytes = 0;
        await NodeFSP.rm(partialPath, { force: true });
      }

      const handle = await NodeFSP.open(partialPath, existingBytes > 0 ? "a" : "w", 0o600);
      let downloadedBytes = existingBytes;
      try {
        const reader = response.body.getReader();
        for (;;) {
          signal.throwIfAborted();
          const next = await reader.read();
          if (next.done) break;
          if (downloadedBytes + next.value.byteLength > manifest.byteSize) {
            throw new Error("Offline voice model download exceeded its expected size.");
          }
          await handle.write(next.value);
          downloadedBytes += next.value.byteLength;
          onProgress?.({ downloadedBytes, totalBytes: manifest.byteSize });
        }
      } finally {
        await handle.close();
      }
    }

    const downloadedStats = await statOrNull(partialPath);
    if (downloadedStats?.size !== manifest.byteSize) {
      throw new Error(
        `Offline voice model download is incomplete (${downloadedStats?.size ?? 0}/${manifest.byteSize} bytes).`,
      );
    }

    const digest = await sha256File(partialPath);
    if (digest !== manifest.sha256) {
      await NodeFSP.rm(partialPath, { force: true });
      throw new Error("Offline voice model checksum verification failed.");
    }
    if (!(await fileStartsWithHex(partialPath, manifest.headerHex))) {
      await NodeFSP.rm(partialPath, { force: true });
      throw new Error("Offline voice model header verification failed.");
    }

    // Rename only after every verification passes. Node uses replacement rename
    // semantics for files, so a repair never exposes an unverified model path.
    await NodeFSP.rename(partialPath, this.modelPath);
    const installedStats = await NodeFSP.stat(this.modelPath);
    this.verifiedFileCache = { size: installedStats.size, mtimeMs: installedStats.mtimeMs };
    const receipt: VoiceModelReceipt = {
      id: manifest.id,
      fileName: manifest.fileName,
      byteSize: manifest.byteSize,
      sha256: manifest.sha256,
      sourceRevision: manifest.sourceRevision,
      verifiedAt: new Date().toISOString(),
    };
    const pendingReceiptPath = `${this.receiptPath}.tmp-${process.pid}`;
    await NodeFSP.writeFile(pendingReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      mode: 0o600,
    });
    await NodeFSP.rm(this.receiptPath, { force: true });
    await NodeFSP.rename(pendingReceiptPath, this.receiptPath);
    return this.modelPath;
  }
}

async function statOrNull(path: string) {
  try {
    return await NodeFSP.stat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function fileSize(path: string): Promise<number> {
  return (await statOrNull(path))?.size ?? 0;
}

async function readReceipt(path: string): Promise<VoiceModelReceipt | null> {
  try {
    const value = JSON.parse(await NodeFSP.readFile(path, "utf8")) as Partial<VoiceModelReceipt>;
    if (
      typeof value.id !== "string" ||
      typeof value.fileName !== "string" ||
      typeof value.byteSize !== "number" ||
      typeof value.sha256 !== "string" ||
      typeof value.sourceRevision !== "string" ||
      typeof value.verifiedAt !== "string"
    ) {
      return null;
    }
    return value as VoiceModelReceipt;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function fileStartsWithHex(path: string, expectedHex: string): Promise<boolean> {
  const expected = Buffer.from(expectedHex, "hex");
  const handle = await NodeFSP.open(path, "r");
  try {
    const actual = Buffer.alloc(expected.byteLength);
    const { bytesRead } = await handle.read(actual, 0, actual.byteLength, 0);
    return bytesRead === expected.byteLength && actual.equals(expected);
  } finally {
    await handle.close();
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
