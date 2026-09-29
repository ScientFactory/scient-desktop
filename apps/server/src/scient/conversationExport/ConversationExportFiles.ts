// @effect-diagnostics nodeBuiltinImport:off -- ZIP packaging streams attachment files into the export file.
/**
 * The server-owned temporary location for produced export files. Each export
 * gets its own directory, read by clients through a signed asset URL that
 * expires with it. Directories older than the retention period are removed on
 * a timer, and the whole location is cleared when the server starts, so an
 * export never outlives a restart.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeStream from "node:stream";

import type { Sha256Digest } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as yazl from "yazl";

import * as ServerConfig from "../../config.ts";

/** How long a produced export stays readable. Bounded by the asset token lifetime. */
export const CONVERSATION_EXPORT_RETENTION = Duration.minutes(30);
const SWEEP_INTERVAL = Duration.minutes(5);

export class ConversationExportFileError extends Schema.TaggedError<ConversationExportFileError>()(
  "ConversationExportFileError",
  { cause: Schema.Defect() },
) {}

/** A file an archive entry copies, checked against what the export recorded for it. */
export interface PackageEntryFile {
  readonly path: string;
  readonly byteLength: number;
  /** When known, the bytes copied must hash to it or the archive is not written. */
  readonly sha256: Sha256Digest | null;
}

/**
 * One archive entry: bytes already in memory, or a file streamed into the
 * archive when its turn comes, so only about one entry is in memory at once.
 */
export type PackageEntry = {
  /** Relative POSIX path inside the archive. */
  readonly path: string;
  /** Deflated unless false; entries are written in the order given. */
  readonly compress?: boolean;
} & ({ readonly bytes: Uint8Array } | { readonly file: PackageEntryFile });

export type ExportFileContent =
  | { readonly _tag: "text"; readonly text: string }
  | {
      readonly _tag: "zip";
      readonly entries: ReadonlyArray<PackageEntry>;
      /** Entry timestamp, so the same export content packs the same way. */
      readonly modifiedAt: string;
    };

export interface WrittenExportFile {
  readonly path: string;
  readonly byteLength: number;
}

export class ConversationExportFiles extends Context.Service<
  ConversationExportFiles,
  {
    readonly write: (input: {
      readonly exportId: string;
      readonly fileName: string;
      readonly content: ExportFileContent;
    }) => Effect.Effect<WrittenExportFile, ConversationExportFileError>;
    /**
     * Creates an export's directory and answers where a producer that writes
     * its own file (the Word converter) puts `fileName`.
     */
    readonly reserve: (input: {
      readonly exportId: string;
      readonly fileName: string;
    }) => Effect.Effect<{ readonly path: string }, ConversationExportFileError>;
    /** Removes exports older than the retention period. */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/scient/conversationExport/ConversationExportFiles") {}

/** The export location under the server's state directory. */
export const exportsDirectory = (config: ServerConfig.ServerConfig["Service"], path: Path.Path) =>
  path.join(config.stateDir, "scient", "conversation-exports");

/** Streams `file`, failing when its size or digest differs from what the export recorded. */
function verifiedFileStream(file: PackageEntryFile): NodeStream.Readable {
  const hash = file.sha256 === null ? null : NodeCrypto.createHash("sha256");
  let byteLength = 0;
  const verify = new NodeStream.Transform({
    transform(chunk: Buffer, _encoding, callback) {
      byteLength += chunk.byteLength;
      hash?.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      const digest = hash === null ? null : `sha256:${hash.digest("hex")}`;
      callback(
        byteLength !== file.byteLength || (file.sha256 !== null && digest !== file.sha256)
          ? new Error("An attachment changed while it was exported.")
          : null,
      );
    },
  });
  const source = NodeFS.createReadStream(file.path);
  source.on("error", (cause) => verify.destroy(cause));
  return source.pipe(verify);
}

function writeZip(
  target: string,
  entries: ReadonlyArray<PackageEntry>,
  modifiedAt: Date,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const output = NodeFS.createWriteStream(target, { flags: "wx" });
    let failed = false;
    const fail = (cause: unknown) => {
      if (failed) return;
      failed = true;
      output.destroy();
      reject(cause);
    };
    output.on("close", () => {
      if (!failed) resolve();
    });
    output.on("error", fail);
    zip.on("error", fail);
    zip.outputStream.on("error", fail);
    zip.outputStream.pipe(output);
    for (const entry of entries) {
      // Lazy: yazl opens an entry's stream only when it writes that entry.
      zip.addReadStreamLazy(
        entry.path,
        {
          mtime: modifiedAt,
          mode: 0o100644,
          compress: entry.compress ?? true,
          size: "bytes" in entry ? entry.bytes.byteLength : entry.file.byteLength,
        },
        (callback) => {
          const stream =
            "bytes" in entry
              ? NodeStream.Readable.from(
                  [Buffer.from(entry.bytes.buffer, entry.bytes.byteOffset, entry.bytes.byteLength)],
                  { objectMode: false },
                )
              : verifiedFileStream(entry.file);
          stream.on("error", fail);
          callback(null, stream);
        },
      );
    }
    zip.end();
  });
}

/** What a packaging writer needs to know about an attachment file before it streams it. */
export interface InspectedAttachmentFile {
  readonly byteLength: number;
  readonly sha256: Sha256Digest;
  /** The first bytes, for checking the declared media type. */
  readonly head: Uint8Array;
}

/**
 * Hashes a file by streaming it, holding only its first `headBytes`. Resolves
 * null when the file holds more than `maxBytes`.
 */
export function inspectAttachmentFile(
  path: string,
  maxBytes: number,
  headBytes: number,
): Promise<InspectedAttachmentFile | null> {
  return new Promise((resolve, reject) => {
    const hash = NodeCrypto.createHash("sha256");
    const head: Buffer[] = [];
    let headLength = 0;
    let byteLength = 0;
    const stream = NodeFS.createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      byteLength += bytes.byteLength;
      if (byteLength > maxBytes) {
        stream.destroy();
        resolve(null);
        return;
      }
      hash.update(bytes);
      if (headLength < headBytes) {
        const part = bytes.subarray(0, headBytes - headLength);
        head.push(part);
        headLength += part.byteLength;
      }
    });
    stream.on("end", () =>
      resolve({
        byteLength,
        sha256: `sha256:${hash.digest("hex")}`,
        head: new Uint8Array(Buffer.concat(head)),
      }),
    );
  });
}

export const make = (options?: { readonly retention?: Duration.Duration }) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = exportsDirectory(config, path);
    const retentionMs = Duration.toMillis(options?.retention ?? CONVERSATION_EXPORT_RETENTION);

    // Nothing from a previous run is still addressed by a live asset URL.
    yield* fileSystem
      .remove(root, { recursive: true, force: true })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not clear old conversation exports.", { cause }),
        ),
      );

    const write: ConversationExportFiles["Service"]["write"] = Effect.fn(
      "ConversationExportFiles.write",
    )(function* (input) {
      const directory = path.join(root, input.exportId);
      const target = path.join(directory, input.fileName);
      yield* Effect.gen(function* () {
        yield* fileSystem.makeDirectory(directory, { recursive: true });
        if (input.content._tag === "text") {
          yield* fileSystem.writeFileString(target, input.content.text);
        } else {
          const { entries, modifiedAt } = input.content;
          yield* Effect.tryPromise({
            try: () =>
              writeZip(target, entries, DateTime.toDateUtc(DateTime.makeUnsafe(modifiedAt))),
            catch: (cause) => new ConversationExportFileError({ cause }),
          }).pipe(
            // Never leave a partial archive behind a signed URL.
            Effect.onError(() => fileSystem.remove(target, { force: true }).pipe(Effect.ignore)),
          );
        }
      }).pipe(Effect.mapError((cause) => new ConversationExportFileError({ cause })));
      const info = yield* fileSystem
        .stat(target)
        .pipe(Effect.mapError((cause) => new ConversationExportFileError({ cause })));
      return { path: target, byteLength: Number(info.size) };
    });

    const reserve: ConversationExportFiles["Service"]["reserve"] = Effect.fn(
      "ConversationExportFiles.reserve",
    )(function* (input) {
      const directory = path.join(root, input.exportId);
      yield* fileSystem
        .makeDirectory(directory, { recursive: true })
        .pipe(Effect.mapError((cause) => new ConversationExportFileError({ cause })));
      return { path: path.join(directory, input.fileName) };
    });

    const sweep = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const names = yield* fileSystem.readDirectory(root);
      for (const name of names) {
        const directory = path.join(root, name);
        const info = yield* fileSystem.stat(directory);
        const modified = Option.match(info.mtime, {
          onNone: () => 0,
          onSome: (mtime) => mtime.getTime(),
        });
        if (now - modified >= retentionMs) {
          yield* fileSystem.remove(directory, { recursive: true, force: true });
        }
      }
    }).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.void
          : Effect.logWarning("Could not remove expired conversation exports.", { cause }),
      ),
    );

    yield* Effect.forkScoped(Effect.repeat(sweep, Schedule.spaced(SWEEP_INTERVAL)));
    return ConversationExportFiles.of({ write, reserve, sweep });
  });

export const layer = Layer.effect(ConversationExportFiles, make());
