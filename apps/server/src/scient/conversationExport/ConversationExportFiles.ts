// @effect-diagnostics nodeBuiltinImport:off -- ZIP packaging streams into the export file.
/**
 * The server-owned temporary location for produced export files. Each export
 * gets its own directory, read by clients through a signed asset URL that
 * expires with it. Directories older than the retention period are removed on
 * a timer, and the whole location is cleared when the server starts, so an
 * export never outlives a restart.
 */
import * as NodeFS from "node:fs";
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

export interface PackageEntry {
  /** Relative POSIX path inside the archive. */
  readonly path: string;
  readonly bytes: Uint8Array;
  /** Deflated unless false; entries are written in the order given. */
  readonly compress?: boolean;
}

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
    /** Removes exports older than the retention period. */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/scient/conversationExport/ConversationExportFiles") {}

/** The export location under the server's state directory. */
export const exportsDirectory = (config: ServerConfig.ServerConfig["Service"], path: Path.Path) =>
  path.join(config.stateDir, "scient", "conversation-exports");

function writeZip(
  target: string,
  entries: ReadonlyArray<PackageEntry>,
  modifiedAt: Date,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const output = NodeFS.createWriteStream(target, { flags: "wx" });
    output.on("close", () => resolve());
    output.on("error", reject);
    zip.outputStream.on("error", reject);
    zip.outputStream.pipe(output);
    for (const entry of entries) {
      zip.addBuffer(Buffer.from(entry.bytes), entry.path, {
        mtime: modifiedAt,
        mode: 0o100644,
        compress: entry.compress ?? true,
      });
    }
    zip.end();
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
          });
        }
      }).pipe(Effect.mapError((cause) => new ConversationExportFileError({ cause })));
      const info = yield* fileSystem
        .stat(target)
        .pipe(Effect.mapError((cause) => new ConversationExportFileError({ cause })));
      return { path: target, byteLength: Number(info.size) };
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
    return ConversationExportFiles.of({ write, sweep });
  });

export const layer = Layer.effect(ConversationExportFiles, make());
