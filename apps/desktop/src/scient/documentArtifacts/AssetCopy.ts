// @effect-diagnostics nodeBuiltinImport:off -- Native save uses file handles for streamed, flushed, atomic publication.
import type { DesktopAssetCopyRequest, DesktopAssetCopyResult } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import * as Electron from "electron";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";

class AssetCopyReadError extends Error {}
class AssetCopyWriteError extends Error {}
class AssetCopyOperationError extends Data.TaggedError("AssetCopyOperationError")<{
  readonly cause: unknown;
}> {}

function failed(
  reason: Extract<DesktopAssetCopyResult, { _tag: "failed" }>["reason"],
): DesktopAssetCopyResult {
  return { _tag: "failed", reason };
}

function fileFilters(suggestedFileName: string): Electron.FileFilter[] {
  const extension = NodePath.extname(suggestedFileName).slice(1);
  if (!/^[a-z0-9][a-z0-9+_-]*$/iu.test(extension)) {
    return [{ name: "All files", extensions: ["*"] }];
  }
  return [
    {
      name: extension.toLowerCase() === "pdf" ? "PDF document" : `${extension.toUpperCase()} file`,
      extensions: [extension],
    },
  ];
}

function parseHttpUrl(rawUrl: string): URL | null {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

async function writeResponseAtomically(
  response: Response,
  destinationPath: string,
): Promise<DesktopAssetCopyResult> {
  if (response.body === null) return failed("network-failed");

  const temporaryPath = NodePath.join(
    NodePath.dirname(destinationPath),
    `.scient-save-${NodeCrypto.randomUUID()}.tmp`,
  );
  let handle: NodeFSP.FileHandle | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let streamCompleted = false;

  try {
    try {
      handle = await NodeFSP.open(temporaryPath, "wx");
    } catch (cause) {
      throw new AssetCopyWriteError("Could not create the temporary destination.", { cause });
    }

    reader = response.body.getReader();
    let filePosition = 0;
    while (true) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (cause) {
        throw new AssetCopyReadError("The asset stream ended unexpectedly.", { cause });
      }
      if (next.done) {
        streamCompleted = true;
        break;
      }

      let chunkOffset = 0;
      while (chunkOffset < next.value.byteLength) {
        try {
          const result = await handle.write(
            next.value,
            chunkOffset,
            next.value.byteLength - chunkOffset,
            filePosition,
          );
          if (result.bytesWritten <= 0) {
            throw new Error("The destination accepted no bytes.");
          }
          chunkOffset += result.bytesWritten;
          filePosition += result.bytesWritten;
        } catch (cause) {
          throw new AssetCopyWriteError("Could not write the destination.", { cause });
        }
      }
    }

    try {
      await handle.sync();
      await handle.close();
      handle = null;
      await NodeFSP.rename(temporaryPath, destinationPath);
    } catch (cause) {
      throw new AssetCopyWriteError("Could not publish the saved copy.", { cause });
    }
    return { _tag: "saved", path: destinationPath };
  } catch (cause) {
    return failed(cause instanceof AssetCopyReadError ? "network-failed" : "write-failed");
  } finally {
    if (reader !== null) {
      if (!streamCompleted) await reader.cancel().catch(() => undefined);
      try {
        reader.releaseLock();
      } catch {
        // The source may already have invalidated the reader while failing.
      }
    }
    if (handle !== null) await handle.close().catch(() => undefined);
    await NodeFSP.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function copyAssetToPath(
  request: DesktopAssetCopyRequest,
  destinationPath: string,
): Promise<DesktopAssetCopyResult> {
  const url = parseHttpUrl(request.url);
  if (url === null) return failed("source-unavailable");

  let response: Response;
  try {
    response = await Electron.net.fetch(url.toString(), {
      cache: "no-store",
      method: "GET",
      redirect: "follow",
    });
  } catch {
    return failed("network-failed");
  }

  if (response.status === 409) return failed("source-changed");
  if (response.status === 404 || response.status === 410) return failed("source-unavailable");
  if (!response.ok) return failed("network-failed");
  return writeResponseAtomically(response, destinationPath);
}

export const saveAssetCopy = Effect.fn("desktop.scient.documentArtifacts.saveAssetCopy")(function* (
  request: DesktopAssetCopyRequest,
) {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const owner = yield* electronWindow.focusedMainOrFirst;
  const selection = yield* Effect.tryPromise({
    try: () => {
      const options: Electron.SaveDialogOptions = {
        defaultPath: request.suggestedFileName,
        filters: fileFilters(request.suggestedFileName),
        properties: ["showOverwriteConfirmation", "createDirectory"],
      };
      return Option.match(owner, {
        onNone: () => Electron.dialog.showSaveDialog(options),
        onSome: (window) => Electron.dialog.showSaveDialog(window, options),
      });
    },
    catch: (cause) => new AssetCopyOperationError({ cause }),
  }).pipe(Effect.result);

  if (Result.isFailure(selection)) return failed("dialog-failed");
  if (selection.success.canceled || selection.success.filePath.length === 0) {
    return { _tag: "cancelled" } as const;
  }
  const destinationPath = selection.success.filePath;
  const copy = yield* Effect.tryPromise({
    try: () => copyAssetToPath(request, destinationPath),
    catch: (cause) => new AssetCopyOperationError({ cause }),
  }).pipe(Effect.result);
  return Result.isSuccess(copy) ? copy.success : failed("write-failed");
});

export const revealSavedAsset = Effect.fn("desktop.scient.documentArtifacts.revealSavedAsset")(
  function* (path: string) {
    yield* Effect.sync(() => Electron.shell.showItemInFolder(path));
  },
);
