/**
 * Project Markdown file → Word.
 *
 * An isolated adapter until the shared project-Markdown capture (conversation
 * export PR 2) produces document bundles: it reads the saved file through the
 * workspace file system, refuses when the file on disk is not the revision the
 * editor showed, and builds a `document`-profile bundle whose relative images
 * the converter resolves itself, only inside the project root. Citation keys
 * stay as written until the capture supplies references.
 *
 * The Word file goes to the same temporary export location as conversation
 * exports and is read through a signed asset.
 */
import {
  ScientWordExportError,
  type DocumentBundle,
  type DocumentWarning,
  type ScientWordFileExportRequest,
} from "@t3tools/contracts";
import { exportFileName } from "@scientfactory/conversation";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import {
  ConversationExportFiles,
  type ConversationExportFileError,
} from "../conversationExport/ConversationExportFiles.ts";
import { PandocWordConverter, type WordConversionFailureReason } from "./PandocWordConverter.ts";

const MARKDOWN_FILE = /\.(?:md|markdown|mdown|mkd)$/iu;

export interface ProducedWordFile {
  readonly path: string;
  readonly fileName: string;
  readonly byteLength: number;
  readonly warnings: ReadonlyArray<DocumentWarning>;
}

export class WordFileExport extends Context.Service<
  WordFileExport,
  {
    readonly export: (
      request: ScientWordFileExportRequest,
    ) => Effect.Effect<ProducedWordFile, ScientWordExportError | ConversationExportFileError>;
  }
>()("t3/scient/pandoc/WordFileExport") {}

const WORD_FAILURE_REASON: Record<WordConversionFailureReason, ScientWordExportError["reason"]> = {
  unavailable: "unavailable",
  "too-large": "too-large",
  timeout: "too-large",
  failed: "conversion-failed",
};

const reject = (reason: ScientWordExportError["reason"], message: string) =>
  Effect.fail(new ScientWordExportError({ reason, message }));

export const make = Effect.gen(function* () {
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceFiles = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const files = yield* ConversationExportFiles;
  const words = yield* PandocWordConverter;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;

  const exportFile: WordFileExport["Service"]["export"] = Effect.fn("WordFileExport.export")(
    function* (request) {
      if (path.isAbsolute(request.relativePath) || !MARKDOWN_FILE.test(request.relativePath)) {
        return yield* reject(
          "not-markdown",
          "Only Markdown files in the project can be exported to Word.",
        );
      }
      const unreadable = () =>
        new ScientWordExportError({
          reason: "file-unreadable",
          message: "Scient could not read this file from the project.",
        });
      const root = yield* workspacePaths
        .normalizeWorkspaceRoot(request.cwd)
        .pipe(Effect.mapError(unreadable));
      const target = yield* workspacePaths
        .resolveRelativePathWithinRoot({ workspaceRoot: root, relativePath: request.relativePath })
        .pipe(Effect.mapError(unreadable));
      const read = yield* workspaceFiles
        .readFile({ cwd: root, relativePath: target.relativePath })
        .pipe(Effect.mapError(unreadable));
      if (read.truncated) {
        return yield* reject("too-large", "This file is too large to export to Word.");
      }
      if (read.revision !== request.revision) {
        return yield* reject(
          "file-changed",
          "The file on disk is not the version shown in the editor. Save it, then export again.",
        );
      }

      const title = path.basename(target.relativePath).replace(MARKDOWN_FILE, "") || "Document";
      const bundle: DocumentBundle = {
        markdown: read.contents,
        profile: "document",
        metadata: {
          title,
          language: null,
          direction: "auto",
          createdAt: null,
          source: {
            _tag: "workspace-file",
            cwd: root,
            relativePath: target.relativePath,
            revision: read.revision,
          },
        },
        assets: [],
        citations: [],
        warnings: [],
      };
      const exportId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const fileName = exportFileName(title, ".docx");
      const reserved = yield* files.reserve({ exportId, fileName });
      const converted = yield* words
        .convert({
          bundle,
          outputPath: reserved.path,
          files: { baseDirectory: path.dirname(target.absolutePath), allowRoots: [root] },
        })
        .pipe(
          Effect.catchTag("WordConversionError", (error) =>
            reject(WORD_FAILURE_REASON[error.reason], error.message),
          ),
        );
      return {
        path: reserved.path,
        fileName,
        byteLength: converted.byteLength,
        warnings: converted.warnings,
      };
    },
  );

  return WordFileExport.of({ export: exportFile });
});

export const layer = Layer.effect(WordFileExport, make);
