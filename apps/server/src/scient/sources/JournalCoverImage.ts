// @effect-diagnostics nodeBuiltinImport:off -- The cover boundary only decodes bounded downloaded bytes.
import * as NodeChildProcess from "node:child_process";
import * as NodeSea from "node:sea";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import { journalCoverWorkerSource, MAX_COVER_OUTPUT_BYTES } from "./JournalCoverImageWorker.ts";
import * as NodeModule from "node:module";

const requireNative = NodeModule.createRequire(import.meta.url);
const decodeSlots = Semaphore.makeUnsafe(3);

async function shrinkIsolated(bytes: Buffer, signal?: AbortSignal): Promise<Buffer | null> {
  await Effect.runPromise(decodeSlots.take(1), { signal });
  try {
    signal?.throwIfAborted();
    const { invocation, environment } = Effect.runSync(
      Effect.all({
        invocation: resolveSelfInvocation(),
        environment: HostProcess.Environment,
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    const args = NodeSea.isSea()
      ? selfInvocationArgs(invocation, ["__journal-cover-image"])
      : ["-e", journalCoverWorkerSource(), requireNative.resolve("@napi-rs/canvas")];
    const env = Object.fromEntries(
      ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TMP", "TEMP"].flatMap((key) =>
        environment[key] === undefined ? [] : [[key, environment[key]!]],
      ),
    );
    const child = NodeChildProcess.spawn(invocation.command, [...args], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    const { promise, resolve } = Promise.withResolvers<Buffer | null>();
    const chunks: Buffer[] = [];
    let length = 0;
    const abort = () => {
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_COVER_OUTPUT_BYTES) {
        abort();
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      resolve(
        code === 0 && length > 0 && length <= MAX_COVER_OUTPUT_BYTES ? Buffer.concat(chunks) : null,
      );
    });
    child.stdin.on("error", () => {
      child.kill("SIGKILL");
    });
    child.stdin.end(bytes);
    const output = await promise;
    if (!output || signal?.aborted) return null;
    // The worker writes a JPEG; anything else is a fault.
    return output[0] === 0xff && output[1] === 0xd8 && output[2] === 0xff ? output : null;
  } finally {
    Effect.runSync(decodeSlots.release(1));
  }
}

/** Checks the declared size before decoding, then shrinks the cover in an isolated process. */
export async function shrinkJournalCover(
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  try {
    const size = declaredSize(bytes);
    if (!size || size.width > 8_192 || size.height > 8_192 || size.width * size.height > 25_000_000)
      return null;
    return await shrinkIsolated(bytes, signal);
  } catch {
    return null;
  }
}

function declaredSize(bytes: Buffer): { readonly width: number; readonly height: number } | null {
  if (bytes.length >= 24 && bytes.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71]))) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 10 && /^GIF8[79]a$/u.test(bytes.subarray(0, 6).toString("ascii"))) {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    for (let offset = 2; offset + 8 < bytes.length;) {
      if (bytes[offset++] !== 255) return null;
      while (bytes[offset] === 255) offset += 1;
      const marker = bytes[offset++]!;
      if (marker === 217 || marker === 218) return null;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return null;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
      }
      offset += length;
    }
    return null;
  }
  if (
    bytes.length >= 30 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    const kind = bytes.subarray(12, 16).toString("ascii");
    if (kind === "VP8X") {
      return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
    }
    if (kind === "VP8L") {
      const packed = bytes.readUInt32LE(21);
      return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
    }
    if (kind === "VP8 ") {
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    }
  }
  return null;
}
