// @effect-diagnostics nodeBuiltinImport:off -- yauzl and yazl expose Node streams and buffers.
import type * as NodeStream from "node:stream";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Yauzl from "yauzl";
import * as Yazl from "yazl";

/** A Word file holds a few dozen parts and one per picture; more is refused unread. */
const MAX_ENTRIES = 2_000;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export class DocxPackageError extends Schema.TaggedError<DocxPackageError>()("DocxPackageError", {
  problem: Schema.Literals(["not-a-package", "unsafe-entry", "too-large", "unreadable"]),
}) {
  override get message(): string {
    return `The Word package was refused: ${this.problem}.`;
  }
}

export interface DocxEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly compressed: boolean;
  readonly modified: Date;
}

const refuse = (problem: DocxPackageError["problem"]) => new DocxPackageError({ problem });

const unsafeName = (name: string) =>
  name.length === 0 ||
  name.length > 512 ||
  name.startsWith("/") ||
  name.includes("\\") ||
  name.includes("\0") ||
  name.endsWith("/") ||
  name.split("/").some((segment) => segment === "" || segment === "." || segment === "..");

/** Every entry of a ZIP package in archive order, with bounded entry and total sizes. */
export const readDocxPackage = Effect.fn("DocxPackage.read")(function* (bytes: Uint8Array) {
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b)
    return yield* refuse("not-a-package");
  return yield* Effect.callback<ReadonlyArray<DocxEntry>, DocxPackageError>((resume) => {
    let settled = false;
    const finish = (effect: Effect.Effect<ReadonlyArray<DocxEntry>, DocxPackageError>) => {
      if (settled) return;
      settled = true;
      resume(effect);
    };
    Yauzl.fromBuffer(
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true, decodeStrings: true },
      (error, zip) => {
        if (error || !zip) return finish(Effect.fail(refuse("not-a-package")));
        const entries: DocxEntry[] = [];
        const names = new Set<string>();
        let total = 0;
        const fail = (problem: DocxPackageError["problem"]) => {
          zip.close();
          finish(Effect.fail(refuse(problem)));
        };
        zip.on("error", () => fail("unreadable"));
        zip.on("end", () => finish(Effect.succeed(entries)));
        zip.on("entry", (entry: Yauzl.Entry) => {
          if (entries.length >= MAX_ENTRIES) return fail("too-large");
          if (entry.fileName.endsWith("/")) return zip.readEntry();
          const lower = entry.fileName.toLowerCase();
          if (unsafeName(entry.fileName) || names.has(lower) || entry.isEncrypted())
            return fail("unsafe-entry");
          if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8)
            return fail("unsafe-entry");
          total += entry.uncompressedSize;
          if (entry.uncompressedSize > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES)
            return fail("too-large");
          names.add(lower);
          zip.openReadStream(entry, (streamError, stream: NodeStream.Readable | undefined) => {
            if (streamError || !stream) return fail("unreadable");
            const chunks: Buffer[] = [];
            stream.on("data", (chunk: Buffer) => chunks.push(chunk));
            stream.on("error", () => fail("unreadable"));
            stream.on("end", () => {
              entries.push({
                name: entry.fileName,
                bytes: new Uint8Array(Buffer.concat(chunks)),
                compressed: entry.compressionMethod === 8,
                modified: entry.getLastModDate(),
              });
              zip.readEntry();
            });
          });
        });
        zip.readEntry();
      },
    );
  });
});

/** A package with these entries in this order; untouched parts keep their content and method. */
export const writeDocxPackage = Effect.fn("DocxPackage.write")(function* (
  entries: ReadonlyArray<DocxEntry>,
) {
  return yield* Effect.callback<Uint8Array, DocxPackageError>((resume) => {
    const zip = new Yazl.ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("error", () => resume(Effect.fail(refuse("unreadable"))));
    zip.outputStream.on("end", () => resume(Effect.succeed(new Uint8Array(Buffer.concat(chunks)))));
    for (const entry of entries) {
      zip.addBuffer(Buffer.from(entry.bytes), entry.name, {
        mtime: entry.modified,
        compress: entry.compressed,
      });
    }
    zip.end();
  });
});
