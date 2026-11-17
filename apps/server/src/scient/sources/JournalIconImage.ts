// @effect-diagnostics nodeBuiltinImport:off -- The icon boundary only decodes bounded downloaded bytes.
import * as NodeChildProcess from "node:child_process";
import * as NodeSea from "node:sea";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import { journalImageWorkerSource } from "./JournalIconImageWorker.ts";
import * as NodeModule from "node:module";
import { SaxesParser } from "saxes";

const requireNative = NodeModule.createRequire(import.meta.url);
const decodeSlots = Semaphore.makeUnsafe(3);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const pngEnd = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);

async function decodeIsolated(
  mode: "svg" | "raster",
  bytes: Buffer,
  width = 0,
  height = 0,
  signal?: AbortSignal,
): Promise<Buffer | null> {
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
      ? selfInvocationArgs(invocation, [
          "__journal-icon-image",
          mode,
          String(width),
          String(height),
        ])
      : [
          "-e",
          journalImageWorkerSource(),
          requireNative.resolve("@napi-rs/canvas"),
          mode,
          String(width),
          String(height),
        ];
    const env = Object.fromEntries(
      ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TMP", "TEMP"].flatMap((key) =>
        environment[key] === undefined ? [] : [[key, environment[key]!]],
      ),
    );
    const child = NodeChildProcess.spawn(invocation.command, [...args], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      timeout: 1_500,
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
      if (length > 128 * 1024) {
        abort();
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      resolve(code === 0 && length > 0 && length <= 128 * 1024 ? Buffer.concat(chunks) : null);
    });
    child.stdin.on("error", () => {
      child.kill("SIGKILL");
    });
    child.stdin.end(bytes);
    const output = await promise;
    if (!output || signal?.aborted) return null;
    if (
      mode === "svg" &&
      (output.length < 45 ||
        !output.subarray(0, 8).equals(pngSignature) ||
        !output.subarray(-12).equals(pngEnd) ||
        output.readUInt32BE(16) !== width ||
        output.readUInt32BE(20) !== height)
    )
      return null;
    return output;
  } finally {
    Effect.runSync(decodeSlots.release(1));
  }
}

/** The renderer receives pixels, never a publisher's active SVG document. */
export async function rasterizeJournalSvg(
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  const text = bytes.toString("utf8");
  if (!/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/iu.test(text)) return null;
  try {
    const parser = new SaxesParser();
    let nodes = 0;
    let depth = 0;
    let styles = "";
    let styleDepth = 0;
    let width = 128;
    let height = 128;
    const safeCss = (value: string) => {
      const remaining = value.replace(/url\(\s*(['"]?)#[\w:.-]+\1\s*\)/giu, "");
      if (/[\\@]|url\s*\(/iu.test(remaining))
        throw new Error("External SVG resources are forbidden.");
    };
    parser.on("doctype", () => {
      throw new Error("SVG document types are forbidden.");
    });
    parser.on("error", (error) => {
      throw error;
    });
    parser.on("opentag", (tag) => {
      if (++nodes > 2_048 || ++depth > 64) throw new Error("The SVG is too complex.");
      const localName = tag.name.replace(/^.*:/u, "");
      if (localName.toLowerCase() === "style") styleDepth = depth;
      if (depth === 1) {
        const viewBox = tag.attributes.viewBox
          ?.trim()
          .split(/[\s,]+/u)
          .map(Number);
        const declaredWidth = Number.parseFloat(tag.attributes.width ?? "");
        const declaredHeight = Number.parseFloat(tag.attributes.height ?? "");
        const originalWidth = viewBox?.[2] ?? declaredWidth;
        const originalHeight = viewBox?.[3] ?? declaredHeight;
        if (
          Number.isFinite(originalWidth) &&
          Number.isFinite(originalHeight) &&
          originalWidth! > 0 &&
          originalHeight! > 0
        ) {
          const scale = 128 / Math.max(originalWidth!, originalHeight!);
          width = Math.max(1, Math.round(originalWidth! * scale));
          height = Math.max(1, Math.round(originalHeight! * scale));
        }
      }
      if (/^(?:script|foreignobject|image|feimage|animate.*|set)$/iu.test(localName)) {
        throw new Error("Active or embedded SVG content is forbidden.");
      }
      for (const [name, value] of Object.entries(tag.attributes)) {
        const localAttribute = name.replace(/^.*:/u, "");
        if (/^on/iu.test(localAttribute) || /^(?:src|base)$/iu.test(localAttribute))
          throw new Error("Active SVG attribute.");
        if (/^href$/iu.test(localAttribute) && !/^#[\w:.-]+$/u.test(value)) {
          throw new Error("External SVG reference.");
        }
        safeCss(value);
      }
    });
    parser.on("closetag", () => {
      if (depth === styleDepth) styleDepth = 0;
      depth -= 1;
    });
    parser.on("text", (value) => {
      if (styleDepth) styles += value;
    });
    parser.on("cdata", (value) => {
      if (styleDepth) styles += value;
    });
    parser.write(text).close();
    safeCss(styles);
    return await decodeIsolated("svg", bytes, width, height, signal);
  } catch {
    return null;
  }
}

export async function validateJournalRaster(bytes: Buffer, signal?: AbortSignal): Promise<boolean> {
  try {
    let width = 0;
    let height = 0;
    if (bytes.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71]))) {
      width = bytes.readUInt32BE(16);
      height = bytes.readUInt32BE(20);
    } else if (/^GIF8[79]a$/u.test(bytes.subarray(0, 6).toString("ascii"))) {
      width = bytes.readUInt16LE(6);
      height = bytes.readUInt16LE(8);
    } else if (bytes.readUInt32LE(0) === 0x00010000) {
      const count = bytes.readUInt16LE(4);
      if (!count || count > 32 || bytes.length < 6 + count * 16) return false;
      for (let index = 0; index < count; index += 1) {
        const offset = 6 + index * 16;
        const size = bytes.readUInt32LE(offset + 8);
        const data = bytes.readUInt32LE(offset + 12);
        if (!size || data < 6 + count * 16 || data + size > bytes.length) return false;
        if (bytes.subarray(data, data + 4).equals(Buffer.from([137, 80, 78, 71]))) {
          if (size < 24) return false;
          const pngWidth = bytes.readUInt32BE(data + 16);
          const pngHeight = bytes.readUInt32BE(data + 20);
          if (
            !pngWidth ||
            !pngHeight ||
            pngWidth > 4_096 ||
            pngHeight > 4_096 ||
            pngWidth * pngHeight > 4_194_304
          )
            return false;
        } else {
          if (size < 12) return false;
          const header = bytes.readUInt32LE(data);
          if (header !== 12 && (header < 40 || header > size)) return false;
          const bitmapWidth =
            header === 12 ? bytes.readUInt16LE(data + 4) : bytes.readInt32LE(data + 4);
          const bitmapHeight =
            Math.abs(header === 12 ? bytes.readUInt16LE(data + 6) : bytes.readInt32LE(data + 8)) /
            2;
          if (
            !Number.isInteger(bitmapHeight) ||
            bitmapWidth <= 0 ||
            bitmapHeight <= 0 ||
            bitmapWidth > 4_096 ||
            bitmapHeight > 4_096 ||
            bitmapWidth * bitmapHeight > 4_194_304
          )
            return false;
        }
        width = Math.max(width, bytes[offset] || 256);
        height = Math.max(height, bytes[offset + 1] || 256);
      }
    } else if (bytes[0] === 255 && bytes[1] === 216) {
      for (let offset = 2; offset + 8 < bytes.length;) {
        if (bytes[offset++] !== 255) return false;
        while (bytes[offset] === 255) offset += 1;
        const marker = bytes[offset++]!;
        if (marker === 217 || marker === 218) break;
        if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
        const length = bytes.readUInt16BE(offset);
        if (length < 2 || offset + length > bytes.length) return false;
        if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
          height = bytes.readUInt16BE(offset + 3);
          width = bytes.readUInt16BE(offset + 5);
          break;
        }
        offset += length;
      }
    } else if (
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP"
    ) {
      const kind = bytes.subarray(12, 16).toString("ascii");
      if (kind === "VP8X") {
        width = bytes.readUIntLE(24, 3) + 1;
        height = bytes.readUIntLE(27, 3) + 1;
      } else if (kind === "VP8L") {
        const packed = bytes.readUInt32LE(21);
        width = (packed & 0x3fff) + 1;
        height = ((packed >>> 14) & 0x3fff) + 1;
      } else if (kind === "VP8 ") {
        width = bytes.readUInt16LE(26) & 0x3fff;
        height = bytes.readUInt16LE(28) & 0x3fff;
      }
    }
    if (!width || !height || width > 4_096 || height > 4_096 || width * height > 4_194_304)
      return false;
    return (await decodeIsolated("raster", bytes, 0, 0, signal))?.[0] === 1;
  } catch {
    return false;
  }
}
