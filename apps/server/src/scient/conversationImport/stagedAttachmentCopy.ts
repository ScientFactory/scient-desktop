// @effect-diagnostics nodeBuiltinImport:off -- attachment copies stream through Node files with hashing.
/**
 * Publishing a staged attachment into Scient's attachment store: a verified
 * copy through a temporary file, flushed to disk before and after the rename,
 * so a file the import reports as published before its commit survives a
 * power loss. Staging's `copyAttachment` lease method runs it.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";

import type { Sha256Digest } from "@t3tools/contracts";

import { waitForWritableDrain } from "../conversationFile/waitForWritableDrain.ts";

export async function sha256File(
  path: string,
  signal?: AbortSignal,
): Promise<{ sha256: Sha256Digest; byteLength: number }> {
  const hash = NodeCrypto.createHash("sha256");
  let byteLength = 0;
  for await (const chunk of NodeFS.createReadStream(path, { signal }) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    byteLength += chunk.byteLength;
  }
  return { sha256: `sha256:${hash.digest("hex")}`, byteLength };
}

/** How a copy reaches the disk; tests observe the order. */
export interface CopyDurability {
  /** Flushes a file's contents. */
  readonly syncFile: (path: string) => Promise<void>;
  /** Flushes a directory's entries, so a rename into it is kept. */
  readonly syncDirectory: (directory: string) => Promise<void>;
}

const diskDurability: CopyDurability = {
  syncFile: async (path) => {
    // Writable, because Windows flushes only a handle opened for writing.
    const handle = await NodeFS.promises.open(path, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  syncDirectory: async (directory) => {
    try {
      const handle = await NodeFS.promises.open(directory, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      // Windows and some filesystems cannot open or flush a directory; NTFS
      // journals the rename itself. The file was flushed before it.
      if (
        !["EACCES", "EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      ) {
        throw error;
      }
    }
  },
};

/**
 * Copies `source` to `destination` through a temporary file, verifying size
 * and SHA-256 on the way. The file is flushed before the rename and its
 * directory after it; a destination already holding the same bytes is
 * flushed the same way, since an earlier attempt may have stopped before.
 */
export async function copyVerified(
  input: {
    readonly source: string;
    readonly destination: string;
    readonly sha256: Sha256Digest;
    readonly byteLength: number;
  },
  signal: AbortSignal,
  durability: CopyDurability = diskDurability,
): Promise<"copied" | "present" | "corrupt" | "conflict"> {
  if (signal.aborted) throw new Error("Attachment copy was interrupted.");
  const directory = NodePath.dirname(input.destination);
  const existing = await NodeFS.promises.stat(input.destination).catch(() => null);
  if (existing !== null) {
    const present = await sha256File(input.destination, signal);
    if (present.sha256 !== input.sha256 || present.byteLength !== input.byteLength) {
      return "conflict";
    }
    await durability.syncFile(input.destination);
    await durability.syncDirectory(directory);
    return "present";
  }
  await NodeFS.promises.mkdir(directory, { recursive: true });
  const temporary = `${input.destination}.${NodeCrypto.randomUUID()}.part`;
  const hash = NodeCrypto.createHash("sha256");
  let byteLength = 0;
  const sink = NodeFS.createWriteStream(temporary, { flags: "wx" });
  const source = NodeFS.createReadStream(input.source, { signal });
  source.on("error", () => {});
  let sinkError: Error | null = null;
  sink.on("error", (error: Error) => {
    sinkError = error;
    source.destroy(error);
  });
  const sinkFinished = NodeStreamPromises.finished(sink);
  void sinkFinished.catch(() => {});
  const sinkClosed = new Promise<void>((resolve) => sink.once("close", resolve));
  const abort = () => {
    const error = new Error("Attachment copy was interrupted.");
    source.destroy(error);
    sink.destroy(error);
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      hash.update(chunk);
      byteLength += chunk.byteLength;
      if (!sink.write(chunk)) {
        if (sinkError !== null) throw sinkError;
        await waitForWritableDrain(sink);
      }
    }
    if (signal.aborted) throw new Error("Attachment copy was interrupted.");
    if (sinkError !== null) throw sinkError;
    sink.end();
    await sinkFinished;
    if (`sha256:${hash.digest("hex")}` !== input.sha256 || byteLength !== input.byteLength) {
      return "corrupt";
    }
    await durability.syncFile(temporary);
    if (signal.aborted) throw new Error("Attachment copy was interrupted.");
    await NodeFS.promises.rename(temporary, input.destination);
    await durability.syncDirectory(directory);
    return "copied";
  } finally {
    signal.removeEventListener("abort", abort);
    source.destroy();
    if (!sink.closed) sink.destroy();
    await sinkClosed;
    await NodeFS.promises.rm(temporary, { force: true });
  }
}
